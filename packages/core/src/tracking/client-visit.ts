/**
 * The visit and the outbox of one tab: opening (or renewing) the visit lease,
 * and flushing the outbox one batch at a time under its flush lease.
 */
import {
  type ReferrerRule,
  type ResolvedAttribution,
  resolveAttribution,
} from './attribution';
import type { Draft } from './client';
import { deliverTrackingBatch } from './delivery';
import type { TrackingHost } from './host';
import type { TrackingOutbox, TrackingQueuedEvent } from './outbox';
import type {
  TrackEventsRequest,
  TrackEventsResponse,
  TrackingEventEnvelope,
  VisitBootstrapResponse,
  VisitEntryContext,
} from './schemas';
import { createSequenceReserve } from './sequence-reserve';

/** What one tab knows about its visit, shared by bootstrap, delivery and the unload path. */
export interface VisitState {
  browserStreamId: string | null;
  visitId: string | null;
  outboxAvailable: boolean;
  bootstrapping: Promise<string | null> | null;
}

type Fail = (what: string, error: unknown) => void;

export interface VisitBootstrapDeps {
  readonly visit: VisitState;
  readonly config: {
    readonly buildId: string;
    bootstrap(entry: VisitEntryContext): Promise<VisitBootstrapResponse>;
    onVisit?(visitId: string): void;
  };
  readonly host: TrackingHost;
  readonly outbox: TrackingOutbox<TrackingEventEnvelope<string>> | undefined;
  readonly sequences: ReturnType<typeof createSequenceReserve>;
  captureAttribution(search: string, pathname: string): ResolvedAttribution | null;
  readonly fail: Fail;
}

/**
 * Open the visit, or renew it. One bootstrap at a time; a caller during one
 * shares it. `null` when it failed — reported, never thrown.
 */
export function bootstrapTrackingVisit(
  deps: VisitBootstrapDeps,
  renew: boolean,
): Promise<string | null> {
  const { visit, config, host, outbox, sequences, captureAttribution, fail } = deps;
  if (!renew && visit.visitId && visit.browserStreamId) return Promise.resolve(visit.visitId);
  if (visit.bootstrapping) return visit.bootstrapping;
  const run = (async () => {
    try {
      const health = outbox
        ? await outbox.health()
        : { state: 'unavailable' as const, queued: 0, dropped: 0 };
      const wasAvailable = visit.outboxAvailable;
      visit.outboxAvailable = health.state === 'available';
      // The shared source is back: forget the per-tab fallback numbers, or
      // events would carry random-base sequences into the shared outbox.
      if (visit.outboxAvailable && !wasAvailable && !sequences.shared()) sequences.reset();
      visit.browserStreamId =
        visit.outboxAvailable && outbox
          ? await outbox.streamId()
          : (visit.browserStreamId ?? host.randomUUID());
      await sequences.refill();
      const page = host.page();
      const touch = captureAttribution(page.search, page.pathname);
      const response = await config.bootstrap({
        browserStreamId: visit.browserStreamId,
        previousVisitId: visit.visitId ?? undefined,
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
      visit.visitId = response.visitId;
      config.onVisit?.(visit.visitId);
      return visit.visitId;
    } catch (error) {
      fail('visit bootstrap', error);
      return null;
    } finally {
      visit.bootstrapping = null;
    }
  })();
  visit.bootstrapping = run;
  return run;
}

// One flush at a time per tab. The lease keeps two *tabs* from sending the
// same batch; inside one tab the periodic flush and a persist-and-flush can
// start together, and the owner may re-acquire its own lease, so without
// this both would read the same batch and send it twice. A flush requested
// while one runs is honoured once it ends, and its caller waits for that one.
export function createOutboxFlusher<TEvent extends TrackingQueuedEvent>(deps: {
  readonly outbox: TrackingOutbox<TEvent> | undefined;
  isAvailable(): boolean;
  readonly owner: string;
  readonly batchSize: number;
  deliver(events: TEvent[]): Promise<TrackEventsResponse | null>;
  readonly fail: Fail;
}): () => Promise<void> {
  const { outbox } = deps;
  let flushing: Promise<void> | null = null;
  let queued: Promise<void> | null = null;
  const flushOutbox = (): Promise<void> => {
    if (!outbox || !deps.isAvailable()) return Promise.resolve();
    if (flushing) {
      queued ??= flushing.then(() => {
        queued = null;
        return flushOutbox();
      });
      return queued;
    }
    flushing = (async () => {
      try {
        if (!(await outbox.acquireLease(deps.owner))) return;
        const batch = await outbox.readBatch(deps.batchSize);
        if (batch.length === 0) return;
        const response = await deps.deliver(batch);
        if (response) {
          await outbox.acknowledge(response.dispositions.map((item) => item.eventId));
        }
      } catch (error) {
        deps.fail('outbox flush', error);
      } finally {
        flushing = null;
      }
    })();
    return flushing;
  };
  return flushOutbox;
}

/** The shared sequence source is the outbox; without one, the per-tab fallback is the design. */
export function createVisitSequences(
  outbox: Pick<TrackingOutbox, 'reserveSequences'> | undefined,
  visit: VisitState,
  options: Parameters<typeof createSequenceReserve>[1],
  fail: (what: string, error: unknown) => void,
) {
  return createSequenceReserve(
    (count) => {
      if (!outbox || !visit.outboxAvailable)
        return Promise.reject(new Error('outbox unavailable'));
      return outbox.reserveSequences(count);
    },
    {
      ...options,
      // Without an outbox the fallback is the design, not a failure to report.
      onUnavailable: outbox
        ? (error) => {
            visit.outboxAvailable = false;
            fail('sequence reservation', error);
          }
        : undefined,
    },
  );
}

export function pageAttribution(
  host: TrackingHost,
  storage: NonNullable<TrackingHost['storage']>,
  referrerMap: readonly ReferrerRule[] | undefined,
  search: string,
  pathname: string,
): ResolvedAttribution {
  const page = host.page();
  return resolveAttribution({
    search,
    pathname,
    referrer: page.referrer,
    hostname: page.hostname,
    storage,
    referrerMap,
    now: host.wallClock(),
  });
}

/** A page view; the referrer belongs to the first view of the visit only. */
export function pageViewDraft<TType extends string>(
  host: TrackingHost,
  type: TType,
  pathname: string,
  previous: string | null,
): Draft<TType> {
  const page = host.page();
  return {
    type,
    page: pathname,
    metadata: {
      title: page.title,
      screenWidth: page.viewportWidth,
      screenHeight: page.viewportHeight,
      referrer: previous ? undefined : page.referrer || undefined,
    },
    clientTimestamp: host.wallClock(),
  };
}

/** Give every draft its identity, refilling the sequence pool once when it runs dry. */
export async function materializeAll<TType extends string, TEvent>(
  drafts: readonly Draft<TType>[],
  materialize: (draft: Draft<TType>) => TEvent | null,
  sequences: { refill(): Promise<unknown> },
): Promise<TEvent[]> {
  const events: TEvent[] = [];
  for (const draft of drafts) {
    let event = materialize(draft);
    if (!event) {
      await sequences.refill();
      event = materialize(draft);
    }
    if (event) events.push(event);
  }
  return events;
}

/** One batch to the application's transport, with one bounded retry; `null` when it did not land. */
export async function deliverTrackedEvents<TEvent extends TrackingEventEnvelope<string>>(
  config: {
    deliver(request: TrackEventsRequest<TEvent>): Promise<TrackEventsResponse>;
    onUnauthorized?: Parameters<typeof deliverTrackingBatch>[0]['onUnauthorized'];
  },
  request: TrackEventsRequest<TEvent>,
  fail: Fail,
): Promise<TrackEventsResponse | null> {
  let response: TrackEventsResponse | null = null;
  const outcome = await deliverTrackingBatch({
    request: async () => {
      response = await config.deliver(request);
    },
    onUnauthorized: config.onUnauthorized,
    onFailure: (error) => fail('event delivery', error),
  });
  return outcome === 'delivered' ? response : null;
}
