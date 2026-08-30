import { z } from 'zod';
import { type BoundedChannel, createBoundedChannel } from '../application/channel';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();

export const LiveStatePhaseSchema = z.enum([
  'idle',
  'opening',
  'live',
  'resync-required',
  'unavailable',
  'closed',
]);
export type LiveStatePhase = z.infer<typeof LiveStatePhaseSchema>;

export const LiveStateStopReasonSchema = z.enum([
  'gap',
  'buffer-overflow',
  'source-unavailable',
  'source-error',
  'controller-error',
  'controller-capacity',
]);
export type LiveStateStopReason = z.infer<typeof LiveStateStopReasonSchema>;

export const LiveStateControllerStatusSchema = z
  .object({
    phase: LiveStatePhaseSchema,
    generation: z.number().int().nonnegative(),
    hasValue: z.boolean(),
    bufferedEvents: z.number().int().nonnegative(),
    bufferedBytes: z.number().int().nonnegative(),
    receivedEvents: z.number().int().nonnegative(),
    appliedEvents: z.number().int().nonnegative(),
    duplicateEvents: z.number().int().nonnegative(),
    gapEvents: z.number().int().nonnegative(),
    refusedEvents: z.number().int().nonnegative(),
    reason: LiveStateStopReasonSchema.optional(),
  })
  .strict()
  .readonly();
export type LiveStateControllerStatus = z.infer<typeof LiveStateControllerStatusSchema>;

export interface LiveStateControllerSnapshot<TState> extends LiveStateControllerStatus {
  readonly value?: TState;
}

export type LiveStateEventDecision<TState> =
  | { readonly outcome: 'applied'; readonly state: TState }
  | { readonly outcome: 'duplicate' }
  | { readonly outcome: 'gap' };

export interface LiveStateSourceOpenInput<TEvent> {
  readonly signal: AbortSignal;
  /** May run before `open()` resolves; the controller buffers those events finitely. */
  readonly onEvent: (event: TEvent) => void;
  /** Reports loss of this source generation. Reconnect policy remains source-owned. */
  readonly onUnavailable: () => void;
}

export interface LiveStateSourceOpenResult<TState> {
  /** State at the source's declared consistency point. */
  readonly snapshot: TState;
  /**
   * Releases only resources owned by this opened source generation. Must be
   * idempotent because abort-aware sources may already have begun cleanup.
   */
  close(): void | Promise<void>;
}

export interface LiveStateSource<TState, TEvent> {
  /**
   * Open one continuous generation.
   *
   * By resolution, every event after `snapshot`'s consistency point has already
   * been or will be passed to `onEvent`. A source that performs an unrelated
   * snapshot read followed by subscription does not satisfy this contract.
   */
  open(input: LiveStateSourceOpenInput<TEvent>): Promise<LiveStateSourceOpenResult<TState>>;
}

export interface LiveStateControllerError {
  readonly error: unknown;
  readonly generation: number;
  readonly phase: LiveStatePhase;
}

export interface LiveStateSubscriberError<TState> {
  readonly error: unknown;
  readonly snapshot: LiveStateControllerSnapshot<TState>;
}

export interface LiveStateControllerConfig<TState, TEvent> {
  readonly source: LiveStateSource<TState, TEvent>;
  /** Provider-owned cursor/revision policy and state reduction. Must be synchronous. */
  readonly applyEvent: (state: TState, event: TEvent) => LiveStateEventDecision<TState>;
  readonly maxBufferedEvents: number;
  readonly maxBufferedBytes: number;
  /** Exact retained-byte accounting for an event waiting behind the snapshot boundary. */
  readonly sizeOfEvent: (event: TEvent) => number;
  readonly signal?: AbortSignal;
  onControllerError?(failure: LiveStateControllerError): void;
  onSubscriberError?(failure: LiveStateSubscriberError<TState>): void;
}

export interface LiveStateController<TState> {
  /** Opens only from `idle`; use `resync()` after loss or an explicit refresh. */
  start(): Promise<LiveStateControllerSnapshot<TState>>;
  /**
   * Fences the current generation and opens a fresh source boundary while
   * bounded pending-operation capacity permits. Otherwise it returns
   * `unavailable/controller-capacity`; retry after `resync-required` is published.
   */
  resync(): Promise<LiveStateControllerSnapshot<TState>>;
  getSnapshot(): LiveStateControllerSnapshot<TState>;
  /** Synchronous external-store subscription; async listeners are removed as invalid. */
  subscribe(listener: (snapshot: LiveStateControllerSnapshot<TState>) => void): () => void;
  /** Fences current work and closes any source handle that has already opened. */
  close(): Promise<LiveStateControllerSnapshot<TState>>;
}

interface LiveStateGeneration<TEvent> {
  readonly id: number;
  readonly startedByResync: boolean;
  readonly abort: AbortController;
  readonly buffer: BoundedChannel<TEvent>;
  readonly retiredPromise: Promise<void>;
  readonly settleRetired: () => void;
  retired: boolean;
  sourceOpenStarted: boolean;
  closeSource?: () => void | Promise<void>;
  closePromise?: Promise<void>;
}

type StoredLiveState<TState> =
  | { readonly hasValue: false }
  | { readonly hasValue: true; readonly value: TState };

/**
 * Keep one application state current across a provider-declared snapshot/event
 * boundary without owning transport reconnect, schemas, replay storage or cursors.
 */
export function createLiveStateController<TState, TEvent>(
  config: LiveStateControllerConfig<TState, TEvent>,
): LiveStateController<TState> {
  const maxBufferedEvents = PositiveSafeIntegerSchema.parse(config.maxBufferedEvents);
  const maxBufferedBytes = PositiveSafeIntegerSchema.parse(config.maxBufferedBytes);
  const subscribers = new Set<(snapshot: LiveStateControllerSnapshot<TState>) => void>();
  let phase: LiveStatePhase = 'idle';
  let reason: LiveStateStopReason | undefined;
  let generation = 0;
  let stored: StoredLiveState<TState> = { hasValue: false };
  let receivedEvents = 0;
  let appliedEvents = 0;
  let duplicateEvents = 0;
  let gapEvents = 0;
  let refusedEvents = 0;
  let current: LiveStateGeneration<TEvent> | undefined;
  let opening: Promise<LiveStateControllerSnapshot<TState>> | undefined;
  let unsettledSourceOpens = 0;
  let unsettledSourceCloses = 0;
  let publishDepth = 0;
  let controllerErrorObserverEnabled = true;
  let subscriberErrorObserverEnabled = true;

  const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function';

  const status = (): LiveStateControllerStatus => {
    const buffered = current?.buffer.getSnapshot();
    return LiveStateControllerStatusSchema.parse({
      phase,
      generation,
      hasValue: stored.hasValue,
      bufferedEvents: buffered?.queuedItems ?? 0,
      bufferedBytes: buffered?.queuedBytes ?? 0,
      receivedEvents,
      appliedEvents,
      duplicateEvents,
      gapEvents,
      refusedEvents,
      ...(reason && { reason }),
    });
  };

  const buildSnapshot = (): LiveStateControllerSnapshot<TState> => {
    const metadata = status();
    return stored.hasValue ? Object.freeze({ ...metadata, value: stored.value }) : metadata;
  };

  let published = buildSnapshot();

  const reportControllerError = (
    error: unknown,
    at: LiveStatePhase,
    atGeneration: number,
  ): void => {
    if (!config.onControllerError || !controllerErrorObserverEnabled) return;
    try {
      const returned: unknown = config.onControllerError({
        error,
        generation: atGeneration,
        phase: at,
      });
      if (isPromiseLike(returned)) {
        controllerErrorObserverEnabled = false;
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // Diagnostic observers cannot affect controller settlement.
    }
  };

  const reportSubscriberError = (
    error: unknown,
    snapshot: LiveStateControllerSnapshot<TState>,
  ): void => {
    if (!config.onSubscriberError || !subscriberErrorObserverEnabled) return;
    try {
      const returned: unknown = config.onSubscriberError({ error, snapshot });
      if (isPromiseLike(returned)) {
        subscriberErrorObserverEnabled = false;
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // Diagnostic observers cannot affect subscriber isolation.
    }
  };

  const publish = (): LiveStateControllerSnapshot<TState> => {
    const snapshot = buildSnapshot();
    published = snapshot;
    publishDepth += 1;
    try {
      for (const listener of subscribers) {
        try {
          const returned: unknown = listener(snapshot);
          if (isPromiseLike(returned)) {
            subscribers.delete(listener);
            reportSubscriberError(
              new TypeError('Live-state subscribers must settle synchronously'),
              snapshot,
            );
            void Promise.resolve(returned).catch(() => undefined);
          }
        } catch (error) {
          reportSubscriberError(error, snapshot);
        }
      }
    } finally {
      publishDepth -= 1;
    }
    return published;
  };

  const publishAvailableCapacity = (): void => {
    if (
      phase !== 'unavailable' ||
      reason !== 'controller-capacity' ||
      unsettledSourceOpens + unsettledSourceCloses >= 2
    )
      return;
    phase = 'resync-required';
    publish();
  };

  const closeSource = (active: LiveStateGeneration<TEvent>): Promise<void> => {
    if (active.closePromise) return active.closePromise;
    if (!active.closeSource) return Promise.resolve();
    const at = phase;
    unsettledSourceCloses += 1;
    active.closePromise = Promise.resolve()
      .then(() => active.closeSource?.())
      .then(() => undefined)
      .catch((error) => {
        reportControllerError(error, at, active.id);
      })
      .finally(() => {
        unsettledSourceCloses -= 1;
        publishAvailableCapacity();
      });
    return active.closePromise;
  };

  const retire = (active: LiveStateGeneration<TEvent>): Promise<void> => {
    if (!active.retired) {
      active.retired = true;
      active.settleRetired();
      active.abort.abort();
      active.buffer.close({ mode: 'discard' });
    }
    return closeSource(active);
  };

  const stopGeneration = (
    active: LiveStateGeneration<TEvent>,
    nextPhase: Extract<LiveStatePhase, 'resync-required' | 'unavailable'>,
    nextReason: LiveStateStopReason,
  ): void => {
    if (current !== active || active.retired || phase === 'closed') return;
    phase = nextPhase;
    reason = nextReason;
    void retire(active);
    publish();
  };

  const apply = (active: LiveStateGeneration<TEvent>, event: TEvent): void => {
    if (
      current !== active ||
      active.retired ||
      !stored.hasValue ||
      (phase !== 'opening' && phase !== 'live')
    )
      return;
    let decision: LiveStateEventDecision<TState>;
    try {
      decision = config.applyEvent(stored.value, event);
    } catch (error) {
      reportControllerError(error, phase, active.id);
      stopGeneration(active, 'unavailable', 'controller-error');
      return;
    }
    if (current !== active || active.retired || (phase !== 'opening' && phase !== 'live'))
      return;
    if (
      !decision ||
      !['applied', 'duplicate', 'gap'].includes(decision.outcome) ||
      (decision.outcome === 'applied' && !('state' in decision))
    ) {
      reportControllerError(
        new Error('applyEvent returned an invalid decision'),
        phase,
        active.id,
      );
      stopGeneration(active, 'unavailable', 'controller-error');
      return;
    }
    if (decision.outcome === 'duplicate') {
      duplicateEvents += 1;
      publish();
      return;
    }
    if (decision.outcome === 'gap') {
      gapEvents += 1;
      stopGeneration(active, 'resync-required', 'gap');
      return;
    }
    stored = { hasValue: true, value: decision.state };
    appliedEvents += 1;
    publish();
  };

  const onEvent = (active: LiveStateGeneration<TEvent>, event: TEvent): void => {
    if (current !== active || active.retired || phase === 'closed') return;
    receivedEvents += 1;
    if (phase === 'opening') {
      try {
        const offered = active.buffer.offer(event);
        if (offered.outcome === 'refused') {
          refusedEvents += 1;
          stopGeneration(active, 'resync-required', 'buffer-overflow');
        } else {
          publish();
        }
      } catch (error) {
        refusedEvents += 1;
        reportControllerError(error, phase, active.id);
        stopGeneration(active, 'unavailable', 'controller-error');
      }
      return;
    }
    if (phase === 'live') apply(active, event);
  };

  const openGeneration = async (
    active: LiveStateGeneration<TEvent>,
  ): Promise<LiveStateControllerSnapshot<TState>> => {
    try {
      if (active.retired || current !== active || phase === 'closed') return published;
      unsettledSourceOpens += 1;
      let sourceOpening: Promise<LiveStateSourceOpenResult<TState>>;
      try {
        sourceOpening = config.source.open({
          signal: active.abort.signal,
          onEvent: (event) => onEvent(active, event),
          onUnavailable: () => stopGeneration(active, 'unavailable', 'source-unavailable'),
        });
      } catch (error) {
        unsettledSourceOpens -= 1;
        publishAvailableCapacity();
        throw error;
      }
      sourceOpening = sourceOpening.then(
        (opened) => {
          // Install ownership before releasing the open-operation charge. A
          // queued resync can then transfer that charge to closeSource without
          // a microtask-sized hole in the combined operation bound.
          active.closeSource = () => opened.close();
          unsettledSourceOpens -= 1;
          if (active.retired || current !== active || phase === 'closed') {
            void closeSource(active);
          }
          publishAvailableCapacity();
          return opened;
        },
        (error: unknown) => {
          unsettledSourceOpens -= 1;
          publishAvailableCapacity();
          throw error;
        },
      );
      const outcome = await Promise.race([
        sourceOpening.then((opened) => ({ outcome: 'opened' as const, opened })),
        active.retiredPromise.then(() => ({ outcome: 'retired' as const })),
      ]);
      if (outcome.outcome === 'retired') {
        return published;
      }
      const { opened } = outcome;
      if (current !== active || active.retired || phase !== 'opening') {
        void closeSource(active);
        return published;
      }
      stored = { hasValue: true, value: opened.snapshot };
      publish();

      while (current === active && !active.retired && phase === 'opening') {
        if (active.buffer.getSnapshot().queuedItems === 0) {
          active.buffer.close({ mode: 'discard' });
          phase = 'live';
          reason = undefined;
          return publish();
        }
        const next = await active.buffer.next();
        if (next.done) break;
        apply(active, next.value);
      }
      if (current && current !== active && opening) return opening;
      return published;
    } catch (error) {
      if (current === active && !active.retired && phase !== 'closed') {
        reportControllerError(error, phase, active.id);
        stopGeneration(active, 'unavailable', 'source-error');
      }
      publishAvailableCapacity();
      return published;
    }
  };

  const begin = (startedByResync: boolean): Promise<LiveStateControllerSnapshot<TState>> => {
    generation += 1;
    phase = 'opening';
    reason = undefined;
    let settleRetired = (): void => undefined;
    const retiredPromise = new Promise<void>((resolve) => {
      settleRetired = resolve;
    });
    const active: LiveStateGeneration<TEvent> = {
      id: generation,
      startedByResync,
      abort: new AbortController(),
      buffer: createBoundedChannel<TEvent>({
        policy: 'ordered',
        maxItems: maxBufferedEvents,
        maxBytes: maxBufferedBytes,
        sizeOf: config.sizeOfEvent,
      }),
      retiredPromise,
      settleRetired,
      retired: false,
      sourceOpenStarted: false,
    };
    current = active;
    publish();
    if (current !== active || active.retired || phase !== 'opening') {
      return opening ?? Promise.resolve(published);
    }
    active.sourceOpenStarted = true;
    const operation = openGeneration(active);
    opening = operation;
    void operation.finally(() => {
      if (opening === operation) opening = undefined;
    });
    return operation;
  };

  const close = (): Promise<LiveStateControllerSnapshot<TState>> => {
    if (phase === 'closed') return Promise.resolve(published);
    const active = current;
    current = undefined;
    phase = 'closed';
    reason = undefined;
    const snapshot = publish();
    if (active) void retire(active);
    config.signal?.removeEventListener('abort', abortFromConfig);
    subscribers.clear();
    return Promise.resolve(snapshot);
  };

  function abortFromConfig(): void {
    void close();
  }

  if (config.signal?.aborted) {
    phase = 'closed';
    published = buildSnapshot();
  } else {
    config.signal?.addEventListener('abort', abortFromConfig, { once: true });
  }

  return {
    start() {
      if (phase === 'idle') return begin(false);
      return opening ?? Promise.resolve(published);
    },
    resync() {
      if (phase === 'closed') return Promise.resolve(published);
      const active = current;
      if (
        active?.startedByResync &&
        !active.sourceOpenStarted &&
        phase === 'opening' &&
        publishDepth > 0
      ) {
        return opening ?? Promise.resolve(published);
      }
      if (active) {
        void retire(active);
        // A source that ignores AbortSignal still owns its pending promise. Keep
        // at most two unsettled source open/close operations in total instead of
        // retaining one closure per repeated resync request.
        if (unsettledSourceOpens + unsettledSourceCloses >= 2) {
          phase = 'unavailable';
          reason = 'controller-capacity';
          return Promise.resolve(publish());
        }
      }
      return begin(true);
    },
    getSnapshot: () => published,
    subscribe(listener) {
      if (phase === 'closed') return () => undefined;
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    close,
  };
}
