import { z } from 'zod';
import { LiveStateCore } from './live-state-core';

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

/**
 * Keep one application state current across a provider-declared snapshot/event
 * boundary without owning transport reconnect, schemas, replay storage or cursors.
 */
export function createLiveStateController<TState, TEvent>(
  config: LiveStateControllerConfig<TState, TEvent>,
): LiveStateController<TState> {
  const core = new LiveStateCore<TState, TEvent>(config);
  return {
    start: () => core.start(),
    resync: () => core.resync(),
    getSnapshot: () => core.published,
    subscribe(listener) {
      if (core.phase === 'closed') return () => undefined;
      core.subscribers.add(listener);
      return () => core.subscribers.delete(listener);
    },
    close: () => core.close(),
  };
}
