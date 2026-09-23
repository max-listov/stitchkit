/**
 * The live-state controller's state machine: one generation at a time opens
 * the source, buffers events behind the snapshot boundary, drains them and goes
 * live; a gap, an overflow or a source loss fences it. A class because every
 * step reads and writes the same fields — as methods each step is its own
 * function a test and a reader can take apart, which one closure never was.
 */
import { z } from 'zod';
import { type BoundedChannel, createBoundedChannel } from '../internal/channel';
import {
  type LiveStateControllerConfig,
  type LiveStateControllerSnapshot,
  type LiveStateControllerStatus,
  LiveStateControllerStatusSchema,
  type LiveStateEventDecision,
  type LiveStatePhase,
  type LiveStateSourceOpenResult,
  type LiveStateStopReason,
} from './live-state';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();

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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

export class LiveStateCore<TState, TEvent> {
  readonly maxBufferedEvents: number;
  readonly maxBufferedBytes: number;
  readonly subscribers = new Set<(snapshot: LiveStateControllerSnapshot<TState>) => void>();
  phase: LiveStatePhase = 'idle';
  reason: LiveStateStopReason | undefined;
  generation = 0;
  stored: StoredLiveState<TState> = { hasValue: false };
  receivedEvents = 0;
  appliedEvents = 0;
  duplicateEvents = 0;
  gapEvents = 0;
  refusedEvents = 0;
  current: LiveStateGeneration<TEvent> | undefined;
  opening: Promise<LiveStateControllerSnapshot<TState>> | undefined;
  unsettledSourceOpens = 0;
  unsettledSourceCloses = 0;
  publishDepth = 0;
  controllerErrorObserverEnabled = true;
  subscriberErrorObserverEnabled = true;
  published: LiveStateControllerSnapshot<TState>;
  private readonly abortFromConfig = (): void => {
    void this.close();
  };

  constructor(readonly config: LiveStateControllerConfig<TState, TEvent>) {
    this.maxBufferedEvents = PositiveSafeIntegerSchema.parse(config.maxBufferedEvents);
    this.maxBufferedBytes = PositiveSafeIntegerSchema.parse(config.maxBufferedBytes);
    if (config.signal?.aborted) this.phase = 'closed';
    else config.signal?.addEventListener('abort', this.abortFromConfig, { once: true });
    this.published = this.buildSnapshot();
  }

  start(): Promise<LiveStateControllerSnapshot<TState>> {
    if (this.phase === 'idle') return this.begin(false);
    return this.opening ?? Promise.resolve(this.published);
  }

  resync(): Promise<LiveStateControllerSnapshot<TState>> {
    if (this.phase === 'closed') return Promise.resolve(this.published);
    const active = this.current;
    if (
      active?.startedByResync &&
      !active.sourceOpenStarted &&
      this.phase === 'opening' &&
      this.publishDepth > 0
    ) {
      return this.opening ?? Promise.resolve(this.published);
    }
    if (active) {
      void this.retire(active);
      // A source that ignores AbortSignal still owns its pending promise. Keep
      // at most two unsettled source open/close operations in total instead of
      // retaining one closure per repeated resync request.
      if (this.unsettledSourceOpens + this.unsettledSourceCloses >= 2) {
        this.phase = 'unavailable';
        this.reason = 'controller-capacity';
        return Promise.resolve(this.publish());
      }
    }
    return this.begin(true);
  }

  status(): LiveStateControllerStatus {
    const buffered = this.current?.buffer.getSnapshot();
    return LiveStateControllerStatusSchema.parse({
      phase: this.phase,
      generation: this.generation,
      hasValue: this.stored.hasValue,
      bufferedEvents: buffered?.queuedItems ?? 0,
      bufferedBytes: buffered?.queuedBytes ?? 0,
      receivedEvents: this.receivedEvents,
      appliedEvents: this.appliedEvents,
      duplicateEvents: this.duplicateEvents,
      gapEvents: this.gapEvents,
      refusedEvents: this.refusedEvents,
      ...(this.reason && { reason: this.reason }),
    });
  }

  buildSnapshot(): LiveStateControllerSnapshot<TState> {
    const metadata = this.status();
    return this.stored.hasValue
      ? Object.freeze({ ...metadata, value: this.stored.value })
      : metadata;
  }

  reportControllerError(error: unknown, at: LiveStatePhase, atGeneration: number): void {
    if (!this.config.onControllerError || !this.controllerErrorObserverEnabled) return;
    try {
      const returned: unknown = this.config.onControllerError({
        error,
        generation: atGeneration,
        phase: at,
      });
      if (isPromiseLike(returned)) {
        this.controllerErrorObserverEnabled = false;
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // Diagnostic observers cannot affect controller settlement.
    }
  }

  reportSubscriberError(error: unknown, snapshot: LiveStateControllerSnapshot<TState>): void {
    if (!this.config.onSubscriberError || !this.subscriberErrorObserverEnabled) return;
    try {
      const returned: unknown = this.config.onSubscriberError({ error, snapshot });
      if (isPromiseLike(returned)) {
        this.subscriberErrorObserverEnabled = false;
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // Diagnostic observers cannot affect subscriber isolation.
    }
  }

  publish(): LiveStateControllerSnapshot<TState> {
    const snapshot = this.buildSnapshot();
    this.published = snapshot;
    this.publishDepth += 1;
    try {
      for (const listener of this.subscribers) {
        try {
          const returned: unknown = listener(snapshot);
          if (isPromiseLike(returned)) {
            this.subscribers.delete(listener);
            this.reportSubscriberError(
              new TypeError('Live-state subscribers must settle synchronously'),
              snapshot,
            );
            void Promise.resolve(returned).catch(() => undefined);
          }
        } catch (error) {
          this.reportSubscriberError(error, snapshot);
        }
      }
    } finally {
      this.publishDepth -= 1;
    }
    return this.published;
  }

  publishAvailableCapacity(): void {
    if (
      this.phase !== 'unavailable' ||
      this.reason !== 'controller-capacity' ||
      this.unsettledSourceOpens + this.unsettledSourceCloses >= 2
    )
      return;
    this.phase = 'resync-required';
    this.publish();
  }

  closeSource(active: LiveStateGeneration<TEvent>): Promise<void> {
    if (active.closePromise) return active.closePromise;
    if (!active.closeSource) return Promise.resolve();
    const at = this.phase;
    this.unsettledSourceCloses += 1;
    active.closePromise = Promise.resolve()
      .then(() => active.closeSource?.())
      .then(() => undefined)
      .catch((error) => {
        this.reportControllerError(error, at, active.id);
      })
      .finally(() => {
        this.unsettledSourceCloses -= 1;
        this.publishAvailableCapacity();
      });
    return active.closePromise;
  }

  retire(active: LiveStateGeneration<TEvent>): Promise<void> {
    if (!active.retired) {
      active.retired = true;
      active.settleRetired();
      active.abort.abort();
      active.buffer.close({ mode: 'discard' });
    }
    return this.closeSource(active);
  }

  stopGeneration(
    active: LiveStateGeneration<TEvent>,
    nextPhase: Extract<LiveStatePhase, 'resync-required' | 'unavailable'>,
    nextReason: LiveStateStopReason,
  ): void {
    if (this.current !== active || active.retired || this.phase === 'closed') return;
    this.phase = nextPhase;
    this.reason = nextReason;
    void this.retire(active);
    this.publish();
  }

  apply(active: LiveStateGeneration<TEvent>, event: TEvent): void {
    if (
      this.current !== active ||
      active.retired ||
      !this.stored.hasValue ||
      (this.phase !== 'opening' && this.phase !== 'live')
    )
      return;
    let decision: LiveStateEventDecision<TState>;
    try {
      decision = this.config.applyEvent(this.stored.value, event);
    } catch (error) {
      this.reportControllerError(error, this.phase, active.id);
      this.stopGeneration(active, 'unavailable', 'controller-error');
      return;
    }
    if (
      this.current !== active ||
      active.retired ||
      (this.phase !== 'opening' && this.phase !== 'live')
    )
      return;
    if (
      !decision ||
      !['applied', 'duplicate', 'gap'].includes(decision.outcome) ||
      (decision.outcome === 'applied' && !('state' in decision))
    ) {
      this.reportControllerError(
        new Error('applyEvent returned an invalid decision'),
        this.phase,
        active.id,
      );
      this.stopGeneration(active, 'unavailable', 'controller-error');
      return;
    }
    if (decision.outcome === 'duplicate') {
      this.duplicateEvents += 1;
      this.publish();
      return;
    }
    if (decision.outcome === 'gap') {
      this.gapEvents += 1;
      this.stopGeneration(active, 'resync-required', 'gap');
      return;
    }
    this.stored = { hasValue: true, value: decision.state };
    this.appliedEvents += 1;
    this.publish();
  }

  onEvent(active: LiveStateGeneration<TEvent>, event: TEvent): void {
    if (this.current !== active || active.retired || this.phase === 'closed') return;
    this.receivedEvents += 1;
    if (this.phase === 'opening') {
      try {
        const offered = active.buffer.offer(event);
        if (offered.outcome === 'refused') {
          this.refusedEvents += 1;
          this.stopGeneration(active, 'resync-required', 'buffer-overflow');
        } else {
          this.publish();
        }
      } catch (error) {
        this.refusedEvents += 1;
        this.reportControllerError(error, this.phase, active.id);
        this.stopGeneration(active, 'unavailable', 'controller-error');
      }
      return;
    }
    if (this.phase === 'live') this.apply(active, event);
  }

  async openGeneration(
    active: LiveStateGeneration<TEvent>,
  ): Promise<LiveStateControllerSnapshot<TState>> {
    try {
      if (active.retired || this.current !== active || this.phase === 'closed')
        return this.published;
      this.unsettledSourceOpens += 1;
      let sourceOpening: Promise<LiveStateSourceOpenResult<TState>>;
      try {
        sourceOpening = this.config.source.open({
          signal: active.abort.signal,
          onEvent: (event) => this.onEvent(active, event),
          onUnavailable: () =>
            this.stopGeneration(active, 'unavailable', 'source-unavailable'),
        });
      } catch (error) {
        this.unsettledSourceOpens -= 1;
        this.publishAvailableCapacity();
        throw error;
      }
      sourceOpening = sourceOpening.then(
        (opened) => {
          // Install ownership before releasing the open-operation charge. A
          // queued resync can then transfer that charge to closeSource without
          // a microtask-sized hole in the combined operation bound.
          active.closeSource = () => opened.close();
          this.unsettledSourceOpens -= 1;
          if (active.retired || this.current !== active || this.phase === 'closed') {
            void this.closeSource(active);
          }
          this.publishAvailableCapacity();
          return opened;
        },
        (error: unknown) => {
          this.unsettledSourceOpens -= 1;
          this.publishAvailableCapacity();
          throw error;
        },
      );
      const outcome = await Promise.race([
        sourceOpening.then((opened) => ({ outcome: 'opened' as const, opened })),
        active.retiredPromise.then(() => ({ outcome: 'retired' as const })),
      ]);
      if (outcome.outcome === 'retired') {
        return this.published;
      }
      const { opened } = outcome;
      if (this.current !== active || active.retired || this.phase !== 'opening') {
        void this.closeSource(active);
        return this.published;
      }
      this.stored = { hasValue: true, value: opened.snapshot };
      this.publish();

      while (this.current === active && !active.retired && this.phase === 'opening') {
        if (active.buffer.getSnapshot().queuedItems === 0) {
          active.buffer.close({ mode: 'discard' });
          this.phase = 'live';
          this.reason = undefined;
          return this.publish();
        }
        const next = await active.buffer.next();
        if (next.done) break;
        this.apply(active, next.value);
      }
      if (this.current && this.current !== active && this.opening) return this.opening;
      return this.published;
    } catch (error) {
      if (this.current === active && !active.retired && this.phase !== 'closed') {
        this.reportControllerError(error, this.phase, active.id);
        this.stopGeneration(active, 'unavailable', 'source-error');
      }
      this.publishAvailableCapacity();
      return this.published;
    }
  }

  begin(startedByResync: boolean): Promise<LiveStateControllerSnapshot<TState>> {
    this.generation += 1;
    this.phase = 'opening';
    this.reason = undefined;
    let settleRetired = (): void => undefined;
    const retiredPromise = new Promise<void>((resolve) => {
      settleRetired = resolve;
    });
    const active: LiveStateGeneration<TEvent> = {
      id: this.generation,
      startedByResync,
      abort: new AbortController(),
      buffer: createBoundedChannel<TEvent>({
        policy: 'ordered',
        maxItems: this.maxBufferedEvents,
        maxBytes: this.maxBufferedBytes,
        sizeOf: this.config.sizeOfEvent,
      }),
      retiredPromise,
      settleRetired,
      retired: false,
      sourceOpenStarted: false,
    };
    this.current = active;
    this.publish();
    if (this.current !== active || active.retired || this.phase !== 'opening') {
      return this.opening ?? Promise.resolve(this.published);
    }
    active.sourceOpenStarted = true;
    const operation = this.openGeneration(active);
    this.opening = operation;
    void operation.finally(() => {
      if (this.opening === operation) this.opening = undefined;
    });
    return operation;
  }

  close(): Promise<LiveStateControllerSnapshot<TState>> {
    if (this.phase === 'closed') return Promise.resolve(this.published);
    const active = this.current;
    this.current = undefined;
    this.phase = 'closed';
    this.reason = undefined;
    const snapshot = this.publish();
    if (active) void this.retire(active);
    this.config.signal?.removeEventListener('abort', this.abortFromConfig);
    this.subscribers.clear();
    return Promise.resolve(snapshot);
  }
}
