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
import {
  type ReferrerRule,
  type ResolvedAttribution,
  resolveAttribution,
} from './attribution';
import { sendUnloadBeacon } from './beacon';
import { resolveTrackedClick, type TrackedClickAttributes } from './clicks';
import { deliverTrackingBatch } from './delivery';
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
import { createSequenceReserve } from './sequence-reserve';
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

type Draft<TType extends string> = Omit<
  TrackingEventEnvelope<TType>,
  'eventId' | 'visitId' | 'browserStreamId' | 'browserSequence'
>;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let at = 0; at < items.length; at += size) chunks.push(items.slice(at, at + size));
  return chunks;
}

export function createTrackingClient<
  TMetadata extends object,
  TEvent extends TrackingEventEnvelope<keyof TMetadata & string> = TrackingEventEnvelope<
    keyof TMetadata & string
  >,
>(config: TrackingClientConfig<TMetadata, TEvent>): TrackingClient<TMetadata> {
  type TType = keyof TMetadata & string;
  // The type requires a string; a JavaScript caller that passes nothing would
  // otherwise send every batch to be refused by the server schema.
  if (typeof config.buildId !== 'string' || config.buildId.length === 0) {
    throw new Error('[stitchkit] tracking client requires a buildId — a git SHA or "dev"');
  }
  const { host, builtin, outbox } = config;
  const heartbeatMs = config.heartbeatMs ?? 30_000;
  const renewAfterHiddenMs = config.renewAfterHiddenMs ?? 30 * 60 * 1000;
  const pendingLimit = config.pendingLimit ?? 100;
  const batchSize = config.batchSize ?? 50;
  const fail = config.onFailure ?? (() => undefined);
  // Without `decorate` the event *is* the envelope — `TEvent` defaulted to it.
  // The one place the default's identity is asserted rather than proven.
  const decorate =
    config.decorate ?? ((event: TrackingEventEnvelope<TType>) => event as TEvent);
  const unload =
    config.unload ??
    ((request: TrackEventsRequest<TEvent>) =>
      config.unloadUrl === undefined
        ? false
        : sendUnloadBeacon(config.unloadUrl, JSON.stringify(request)));

  let browserStreamId: string | null = null;
  let visitId: string | null = null;
  let outboxAvailable = outbox !== undefined;
  let bootstrapping: Promise<string | null> | null = null;
  let pending: Draft<TType>[] = [];
  let currentPage: string | null = null;
  let attribution: ResolvedAttribution | null = null;
  let running = 0;
  const flushOwner = host.randomUUID();
  const meter = createVisibleTimeMeter({
    now: () => host.now(),
    wallClock: () => host.wallClock(),
    randomUUID: () => host.randomUUID(),
  });
  const scroll = createScrollMilestones(config.scrollMilestones);
  const sequences = createSequenceReserve(
    (count) => {
      if (!outbox || !outboxAvailable) return Promise.reject(new Error('outbox unavailable'));
      return outbox.reserveSequences(count);
    },
    {
      ...config.sequence,
      // Without an outbox the fallback is the design, not a failure to report.
      onUnavailable: outbox
        ? (error) => {
            outboxAvailable = false;
            fail('sequence reservation', error);
          }
        : undefined,
    },
  );

  const currentUtm = (): UtmData | undefined =>
    attribution?.currentTouch.utm?.source ? attribution.currentTouch.utm : undefined;

  const captureAttribution = (
    search: string,
    pathname: string,
  ): ResolvedAttribution | null => {
    if (!host.storage) return null;
    const page = host.page();
    attribution = resolveAttribution({
      search,
      pathname,
      referrer: page.referrer,
      hostname: page.hostname,
      storage: host.storage,
      referrerMap: config.referrerMap,
      now: host.wallClock(),
    });
    return attribution;
  };

  const bootstrapVisit = (renew = false): Promise<string | null> => {
    if (!renew && visitId && browserStreamId) return Promise.resolve(visitId);
    if (bootstrapping) return bootstrapping;
    const run = (async () => {
      try {
        const health = outbox
          ? await outbox.health()
          : { state: 'unavailable' as const, queued: 0, dropped: 0 };
        const wasAvailable = outboxAvailable;
        outboxAvailable = health.state === 'available';
        // The shared source is back: forget the per-tab fallback numbers, or
        // events would carry random-base sequences into the shared outbox.
        if (outboxAvailable && !wasAvailable && !sequences.shared()) sequences.reset();
        browserStreamId =
          outboxAvailable && outbox
            ? await outbox.streamId()
            : (browserStreamId ?? host.randomUUID());
        await sequences.refill();
        const page = host.page();
        const touch = captureAttribution(page.search, page.pathname);
        const response = await config.bootstrap({
          browserStreamId,
          previousVisitId: visitId ?? undefined,
          origin: page.origin,
          landingPath: page.pathname,
          referrer: page.referrer || undefined,
          utm: touch?.currentTouch.utm?.source ? touch.currentTouch.utm : undefined,
          displayMode: page.displayMode,
          screenWidth: page.screenWidth,
          screenHeight: page.screenHeight,
          buildId: config.buildId,
          outboxState: health.state,
          outboxQueued: health.queued,
          outboxDropped: health.dropped,
        });
        visitId = response.visitId;
        config.onVisit?.(visitId);
        return visitId;
      } catch (error) {
        fail('visit bootstrap', error);
        return null;
      } finally {
        bootstrapping = null;
      }
    })();
    bootstrapping = run;
    return run;
  };

  const deliver = async (events: TEvent[]): Promise<TrackEventsResponse | null> => {
    let response: TrackEventsResponse | null = null;
    const outcome = await deliverTrackingBatch({
      request: async () => {
        response = await config.deliver({
          buildId: config.buildId,
          events,
          utm: currentUtm(),
        });
      },
      onUnauthorized: config.onUnauthorized,
      onFailure: (error) => fail('event delivery', error),
    });
    return outcome === 'delivered' ? response : null;
  };

  // One flush at a time per tab. The lease keeps two *tabs* from sending the
  // same batch; inside one tab the periodic flush and a persist-and-flush can
  // start together, and the owner may re-acquire its own lease, so without
  // this both would read the same batch and send it twice. A flush requested
  // while one runs is honoured once it ends, and its caller waits for that one.
  let flushing: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const flushOutbox = (): Promise<void> => {
    if (!outbox || !outboxAvailable) return Promise.resolve();
    if (flushing) {
      queued ??= flushing.then(() => {
        queued = null;
        return flushOutbox();
      });
      return queued;
    }
    flushing = (async () => {
      try {
        if (!(await outbox.acquireLease(flushOwner))) return;
        const batch = await outbox.readBatch(batchSize);
        if (batch.length === 0) return;
        const response = await deliver(batch);
        if (response) {
          await outbox.acknowledge(response.dispositions.map((item) => item.eventId));
        }
      } catch (error) {
        fail('outbox flush', error);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };

  /** Give a draft its identity synchronously; `null` when the pool is dry. */
  const materialize = (draft: Draft<TType>): TEvent | null => {
    if (!visitId || !browserStreamId) return null;
    const sequence = sequences.take();
    if (sequence === null) return null;
    return decorate({
      ...draft,
      eventId: host.randomUUID(),
      visitId,
      browserStreamId,
      browserSequence: sequence,
    });
  };

  const persistAndFlush = async (events: TEvent[]): Promise<void> => {
    if (!outbox || !outboxAvailable) {
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
    if (!visitId || !browserStreamId) {
      pending = [...pending, ...drafts].slice(-pendingLimit);
      // Whoever's bootstrap wins drains the queue — including a retry after a
      // first bootstrap that failed, which used to strand what was parked.
      void bootstrapVisit().then((issued) => {
        if (issued) drainPending();
      });
      return;
    }
    void (async () => {
      const events: TEvent[] = [];
      for (const draft of drafts) {
        let event = materialize(draft);
        if (!event) {
          await sequences.refill();
          event = materialize(draft);
        }
        if (event) events.push(event);
      }
      if (events.length > 0) await persistAndFlush(events);
    })();
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
    unload({ buildId: config.buildId, events: [event], utm: currentUtm() });
    if (outbox && outboxAvailable) {
      void outbox.enqueue(event).catch((error) => fail('unload event persistence', error));
    }
  };

  const draft = (type: TType, metadata?: Record<string, unknown>): Draft<TType> => ({
    type,
    page: currentPage ?? host.page().pathname,
    metadata,
    clientTimestamp: host.wallClock(),
  });

  const leaveDraft = (page: string): Draft<TType> => ({
    type: builtin.pageLeave,
    page,
    metadata: { ...meter.cut(), scrollDepthPercent: scroll.max() },
    clientTimestamp: host.wallClock(),
  });

  function track(type: TType, metadata?: unknown): void {
    send([draft(type, metadata === undefined ? undefined : asMetadata(metadata))]);
  }

  const onNavigate = (pathname: string, search: string): void => {
    captureAttribution(search, pathname);
    const previous = currentPage;
    // The same address again — StrictMode, a layout re-render — is not a new view.
    if (previous === pathname) return;
    if (previous && host.visible()) send([leaveDraft(previous)]);
    currentPage = pathname;
    meter.checkpoint();
    scroll.reset();
    const page = host.page();
    send([
      {
        type: builtin.pageView,
        page: pathname,
        metadata: {
          title: page.title,
          screenWidth: page.viewportWidth,
          screenHeight: page.viewportHeight,
          referrer: previous ? undefined : page.referrer || undefined,
        },
        clientTimestamp: host.wallClock(),
      },
    ]);
  };

  const start = (): (() => void) => {
    const generation = ++running;
    const unsubscribe: Array<() => void> = [];
    void bootstrapVisit().then((issued) => {
      // `stop()` before the visit arrived: nothing parked goes out under it.
      if (!issued || generation !== running) return;
      drainPending();
      void flushOutbox();
    });
    const renewThenFlush = () => void bootstrapVisit(true).then(() => flushOutbox());
    unsubscribe.push(host.on('online', renewThenFlush));
    unsubscribe.push(host.interval(() => void flushOutbox(), heartbeatMs));

    // `pagehide` and `visibilitychange:hidden` arrive as a pair a millisecond
    // apart when leaving for another document; the second is the same fact.
    let hiddenAt: number | null = null;
    let lastLeaveAt = Number.NEGATIVE_INFINITY;
    const onHide = () => {
      const at = host.now();
      if (at - lastLeaveAt < 1_000) return;
      lastLeaveAt = at;
      sendOnUnload(leaveDraft(currentPage ?? host.page().pathname));
      if (outbox && outboxAvailable)
        void outbox.releaseLease(flushOwner).catch(() => undefined);
    };
    unsubscribe.push(host.on('pagehide', onHide));
    unsubscribe.push(
      host.on('visibilitychange', () => {
        if (!host.visible()) {
          hiddenAt = host.wallClock();
          onHide();
          return;
        }
        meter.checkpoint();
        if (hiddenAt !== null && host.wallClock() - hiddenAt >= renewAfterHiddenMs) {
          renewThenFlush();
        }
        hiddenAt = null;
      }),
    );

    // Heartbeat: proof of presence and the next cut of visible time.
    unsubscribe.push(
      host.interval(() => {
        send([draft(builtin.heartbeat, { ...meter.heartbeat(host.visible()) })]);
      }, heartbeatMs),
    );

    // Scroll: the deepest point, checked every two seconds, milestones once each.
    unsubscribe.push(host.on('scroll', () => scroll.record(host.scrollDepth())));
    unsubscribe.push(
      host.interval(() => {
        for (const milestone of scroll.observe(host.scrollDepth())) {
          send([draft(builtin.scrollDepth, { maxPercent: milestone })]);
        }
      }, 2_000),
    );

    unsubscribe.push(
      host.onClick((target) => {
        const click = resolveTrackedClick(target, {
          origin: host.page().origin,
          attributes: config.clickAttributes,
          isAction: config.isAction,
        });
        if (!click) return;
        const drafts: Draft<TType>[] = [];
        if (click.interaction)
          drafts.push(draft(builtin.interaction, { ...click.interaction }));
        if (click.click) drafts.push(draft(builtin.click, { ...click.click }));
        if (click.outbound) drafts.push(draft(builtin.outboundClick, { ...click.outbound }));
        if (click.leavesPage) for (const item of drafts) sendOnUnload(item);
        else send(drafts);
      }),
    );

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
    visitId: () => visitId,
    browserStreamId: () => browserStreamId,
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
