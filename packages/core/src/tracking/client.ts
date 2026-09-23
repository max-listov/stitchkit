/**
 * The browser tracking client — the mechanics two consuming applications
 * each carried in a 550-line provider, as one object with no framework in it.
 *
 * What it owns: the visit lease and its renewal, the pending queue before the
 * visit exists, synchronous event identity from a reserved sequence block, the
 * outbox and its flush lease, delivery with one bounded retry, the page-leave
 * event sent as a string beacon *and* queued as insurance, additive visible
 * time, scroll milestones, declarative clicks, heartbeats. What it does not
 * own: the event types and their meaning, the transport (a `deliver` the
 * application supplies — HTTP, a socket first), the React wrapper, the
 * session. → ADR 0166.
 */
import type { ReferrerRule, ResolvedAttribution } from './attribution';
import { sendUnloadBeacon } from './beacon';
import type { TrackedClickAttributes } from './clicks';
import { wireTrackingListeners } from './client-listeners';
import {
  bootstrapTrackingVisit,
  createOutboxFlusher,
  createVisitSequences,
  deliverTrackedEvents,
  materializeAll,
  pageAttribution,
  pageViewDraft,
  type VisitState,
} from './client-visit';
import type { TrackingHost } from './host';
import type { TrackingOutbox } from './outbox';
import type {
  TrackEventsRequest,
  TrackEventsResponse,
  TrackingEventEnvelope,
  UtmData,
  VisitBootstrapResponse,
  VisitEntryContext,
} from './schemas';
import { createScrollMilestones } from './scroll';
import { createVisibleTimeMeter } from './visible-time';

/** The names of the events the client itself emits, in the application's vocabulary. */
export interface BuiltinTrackingEventTypes<TType extends string> {
  pageView: TType;
  pageLeave: TType;
  scrollDepth: TType;
  heartbeat: TType;
  click: TType;
  outboundClick: TType;
  interaction: TType;
}

/** The names both consuming applications happen to use. */
export const CONVENTIONAL_TRACKING_EVENT_TYPES = {
  pageView: 'PAGE_VIEW',
  pageLeave: 'PAGE_LEAVE',
  scrollDepth: 'SCROLL_DEPTH',
  heartbeat: 'SESSION_HEARTBEAT',
  click: 'CLICK',
  outboundClick: 'OUTBOUND_CLICK',
  interaction: 'INTERACTION',
} as const satisfies BuiltinTrackingEventTypes<string>;

/** The event types whose metadata is `undefined` — `track(type)` alone. */
export type EventsWithoutMetadata<TMetadata> = {
  [K in keyof TMetadata & string]: TMetadata[K] extends undefined ? K : never;
}[keyof TMetadata & string];
/** The event types that carry metadata — `track(type, metadata)`. */
export type EventsWithMetadata<TMetadata> = {
  [K in keyof TMetadata & string]: TMetadata[K] extends undefined ? never : K;
}[keyof TMetadata & string];

/** `track('SIGN_OUT')` or `track('CLICK', { element })` — typed by the application's metadata map. */
export interface TrackFn<TMetadata> {
  <T extends EventsWithoutMetadata<TMetadata>>(type: T): void;
  <T extends EventsWithMetadata<TMetadata>>(type: T, metadata: TMetadata[T]): void;
}

export interface TrackingClientConfig<
  TMetadata extends object,
  TEvent extends TrackingEventEnvelope<keyof TMetadata & string> = TrackingEventEnvelope<
    keyof TMetadata & string
  >,
> {
  host: TrackingHost;
  /** The build that produced the events — a git SHA or `dev`. */
  buildId: string;
  /** The application's names for the events the client emits itself. */
  builtin: BuiltinTrackingEventTypes<keyof TMetadata & string>;
  /** Issue or renew the visit — the contract client's `bootstrap`. */
  bootstrap: (entry: VisitEntryContext) => Promise<VisitBootstrapResponse>;
  /**
   * Send a batch — the contract client's `track`, or a socket first and HTTP
   * as the fallback; the client does not care which.
   */
  deliver: (request: TrackEventsRequest<TEvent>) => Promise<TrackEventsResponse>;
  /**
   * Add the application's own fields to every event as it is minted — the
   * `eventExtras` of the schema (a locale, an area), or the identity a client
   * that cannot send headers on unload has to carry in the body. Runs once
   * per event, before the outbox, the beacon and `deliver` see it.
   */
  decorate?: (event: TrackingEventEnvelope<keyof TMetadata & string>) => TEvent;
  /**
   * Send the page-leave batch from a dying document. Default:
   * `sendUnloadBeacon(unloadUrl, JSON.stringify(request))` — always a string
   * body, see ADR 0165.
   */
  unload?: (request: TrackEventsRequest<TEvent>) => boolean;
  /** Where the beacon goes when `unload` is not given — the `track` URL. */
  unloadUrl?: string;
  /** The tab-shared outbox; omit for direct delivery only (no persistence). */
  outbox?: TrackingOutbox<TEvent>;
  /** A `401`/`403` recovery hook for `deliverTrackingBatch`. */
  onUnauthorized?: () => Promise<boolean>;
  /** Called with every visit id issued — a RUM collector, a socket auth. */
  onVisit?: (visitId: string) => void;
  onFailure?: (what: string, error: unknown) => void;
  /** Whether an interaction name is one the application knows. Default: any. */
  isAction?: (action: string) => boolean;
  referrerMap?: readonly ReferrerRule[];
  clickAttributes?: TrackedClickAttributes;
  scrollMilestones?: readonly number[];
  /** Heartbeat and flush period. Default 30 s. */
  heartbeatMs?: number;
  /** Hidden for at least this long → renew the visit on return. Default 30 min. */
  renewAfterHiddenMs?: number;
  /** Drafts kept while the visit is not yet issued. Default 100. */
  pendingLimit?: number;
  /**
   * Events per request — the contract's `maxEventsPerBatch`. Default 50. A
   * batch larger than the schema admits is a `400` that is never retried and
   * never acknowledged, so this has to agree with the server.
   */
  batchSize?: number;
  sequence?: { blockSize?: number; lowWater?: number };
}

export interface TrackingClient<TMetadata extends object> {
  track: TrackFn<TMetadata>;
  /** The router tells the client about a new address; the client emits leave + view. */
  onNavigate(pathname: string, search: string): void;
  /** Subscribe to the host, bootstrap the visit, flush. Returns `stop`. */
  start(): () => void;
  visitId(): string | null;
  browserStreamId(): string | null;
  /** First- and current-touch attribution as last resolved, or `null` before the first page. */
  attribution(): ResolvedAttribution | null;
}

export type Draft<TType extends string> = Omit<
  TrackingEventEnvelope<TType>,
  'eventId' | 'visitId' | 'browserStreamId' | 'browserSequence'
>;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

/** The default page-leave path: a string beacon to `unloadUrl`, or nothing without one. */
function unloadBeacon<TEvent extends TrackingEventEnvelope<string>>(
  unloadUrl: string | undefined,
) {
  return (request: TrackEventsRequest<TEvent>): boolean =>
    unloadUrl === undefined ? false : sendUnloadBeacon(unloadUrl, JSON.stringify(request));
}

/** The campaign a visit is attributed to now, when the current touch carries one. */
function currentUtmOf(attribution: ResolvedAttribution | null): UtmData | undefined {
  return attribution?.currentTouch.utm?.source ? attribution.currentTouch.utm : undefined;
}

/** The client's periods and limits, defaulted, once its build id is known to be there. */
function trackingTimings(config: {
  buildId: string;
  heartbeatMs?: number;
  renewAfterHiddenMs?: number;
  pendingLimit?: number;
  batchSize?: number;
}) {
  // The type requires a string; a JavaScript caller that passes nothing would
  // otherwise send every batch to be refused by the server schema.
  if (typeof config.buildId !== 'string' || config.buildId.length === 0) {
    throw new Error('[stitchkit] tracking client requires a buildId — a git SHA or "dev"');
  }
  return {
    heartbeatMs: config.heartbeatMs ?? 30_000,
    renewAfterHiddenMs: config.renewAfterHiddenMs ?? 30 * 60 * 1000,
    pendingLimit: config.pendingLimit ?? 100,
    batchSize: config.batchSize ?? 50,
  };
}

export function createTrackingClient<
  TMetadata extends object,
  TEvent extends TrackingEventEnvelope<keyof TMetadata & string> = TrackingEventEnvelope<
    keyof TMetadata & string
  >,
>(config: TrackingClientConfig<TMetadata, TEvent>): TrackingClient<TMetadata> {
  type TType = keyof TMetadata & string;
  const { host, builtin, outbox } = config;
  const { heartbeatMs, renewAfterHiddenMs, pendingLimit, batchSize } = trackingTimings(config);
  const fail = config.onFailure ?? (() => undefined);
  // Without `decorate` the event *is* the envelope — `TEvent` defaulted to it.
  // The one place the default's identity is asserted rather than proven.
  const decorate =
    config.decorate ?? ((event: TrackingEventEnvelope<TType>) => event as TEvent);
  const unload = config.unload ?? unloadBeacon<TEvent>(config.unloadUrl);

  const visit: VisitState = {
    browserStreamId: null,
    visitId: null,
    outboxAvailable: outbox !== undefined,
    bootstrapping: null,
  };
  let pending: Draft<TType>[] = [];
  let currentPage: string | null = null;
  let attribution: ResolvedAttribution | null = null;
  let running = 0;
  const flushOwner = host.randomUUID();
  const meter = createVisibleTimeMeter(host);
  const scroll = createScrollMilestones(config.scrollMilestones);
  const sequences = createVisitSequences(outbox, visit, config.sequence, fail);

  const captureAttribution = (
    search: string,
    pathname: string,
  ): ResolvedAttribution | null => {
    if (!host.storage) return null;
    attribution = pageAttribution(host, host.storage, config.referrerMap, search, pathname);
    return attribution;
  };

  const bootstrapVisit = (renew = false): Promise<string | null> =>
    bootstrapTrackingVisit(
      { visit, config, host, outbox, sequences, captureAttribution, fail },
      renew,
    );

  const deliver = (events: TEvent[]): Promise<TrackEventsResponse | null> =>
    deliverTrackedEvents(
      config,
      { buildId: config.buildId, events, utm: currentUtmOf(attribution) },
      fail,
    );

  const flushOutbox = createOutboxFlusher({
    outbox,
    isAvailable: () => visit.outboxAvailable,
    owner: flushOwner,
    batchSize,
    deliver,
    fail,
  });

  /** Give a draft its identity synchronously; `null` when the pool is dry. */
  const materialize = (draft: Draft<TType>): TEvent | null => {
    if (!visit.visitId || !visit.browserStreamId) return null;
    const sequence = sequences.take();
    if (sequence === null) return null;
    return decorate({
      ...draft,
      eventId: host.randomUUID(),
      visitId: visit.visitId,
      browserStreamId: visit.browserStreamId,
      browserSequence: sequence,
    });
  };

  const persistAndFlush = async (events: TEvent[]): Promise<void> => {
    if (!outbox || !visit.outboxAvailable) {
      for (const batch of chunk(events, batchSize)) await deliver(batch);
      return;
    }
    try {
      for (const event of events) await outbox.enqueue(event);
      await flushOutbox();
    } catch (error) {
      fail('event persistence', error);
    }
  };

  const drainPending = (): void => {
    const drafts = pending.splice(0);
    if (drafts.length > 0) send(drafts);
  };

  const send = (drafts: Draft<TType>[]): void => {
    if (!visit.visitId || !visit.browserStreamId) {
      pending = [...pending, ...drafts].slice(-pendingLimit);
      // Whoever's bootstrap wins drains the queue — including a retry after a
      // first bootstrap that failed, which used to strand what was parked.
      void bootstrapVisit().then((issued) => {
        if (issued) drainPending();
      });
      return;
    }
    void materializeAll(drafts, materialize, sequences).then(async (events) => {
      if (events.length > 0) await persistAndFlush(events);
    });
  };

  /**
   * The unload path: the beacon goes **synchronously**, with an identity the
   * event already holds — the document may be gone in milliseconds. A copy is
   * queued afterwards as insurance; if the beacon arrived, the next flush gets
   * `duplicate` for it and drops the copy.
   */
  const sendOnUnload = (draft: Draft<TType>): void => {
    const event = materialize(draft);
    if (!event) {
      send([draft]);
      return;
    }
    unload({ buildId: config.buildId, events: [event], utm: currentUtmOf(attribution) });
    if (outbox && visit.outboxAvailable)
      void outbox.enqueue(event).catch((error) => fail('unload event persistence', error));
  };

  const draft = (type: TType, metadata?: Record<string, unknown>): Draft<TType> => {
    const page = currentPage ?? host.page().pathname;
    return { type, page, metadata, clientTimestamp: host.wallClock() };
  };

  const leaveDraft = (page: string): Draft<TType> => {
    const metadata = { ...meter.cut(), scrollDepthPercent: scroll.max() };
    return { type: builtin.pageLeave, page, metadata, clientTimestamp: host.wallClock() };
  };

  const track = (type: TType, metadata?: unknown): void =>
    send([draft(type, metadata === undefined ? undefined : asMetadata(metadata))]);

  const onNavigate = (pathname: string, search: string): void => {
    captureAttribution(search, pathname);
    const previous = currentPage;
    // The same address again — StrictMode, a layout re-render — is not a new view.
    if (previous === pathname) return;
    if (previous && host.visible()) send([leaveDraft(previous)]);
    currentPage = pathname;
    meter.checkpoint();
    scroll.reset();
    send([pageViewDraft(host, builtin.pageView, pathname, previous)]);
  };

  const start = (): (() => void) => {
    const generation = ++running;
    void bootstrapVisit().then((issued) => {
      // `stop()` before the visit arrived: nothing parked goes out under it.
      if (!issued || generation !== running) return;
      drainPending();
      void flushOutbox();
    });
    const unsubscribe = wireTrackingListeners<TType>({
      host,
      builtin,
      heartbeatMs,
      renewAfterHiddenMs,
      meter,
      scroll,
      draft,
      leaveDraft,
      send,
      sendOnUnload,
      flushOutbox,
      renewVisit: () => bootstrapVisit(true),
      currentPage: () => currentPage ?? host.page().pathname,
      releaseLease: () => {
        if (outbox && visit.outboxAvailable)
          void outbox.releaseLease(flushOwner).catch(() => undefined);
      },
      clickAttributes: config.clickAttributes,
      isAction: config.isAction,
    });
    return () => {
      running += 1;
      for (const off of unsubscribe.splice(0)) off();
    };
  };

  return {
    // The one bridge from the loose implementation (`type: string`, metadata
    // `unknown`) to the surface typed by the application's metadata map — the
    // same shape of cast `browser/client.ts` carries for a scoped client.
    track: track as TrackFn<TMetadata>,
    onNavigate,
    start,
    visitId: () => visit.visitId,
    browserStreamId: () => visit.browserStreamId,
    attribution: () => attribution,
  };
}

/**
 * The public `track` is typed by the application's metadata map; inside, an
 * event's metadata is the untyped record the envelope carries. This is the
 * one bridge between the two — a typed value narrowing to the wire shape.
 */
function asMetadata(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? { ...value } : undefined;
}
