import type { BoundedChannel } from '../internal/channel';
import { offerTurnDelta } from './session-primitives';
import type { ExecutorDelta } from './vocabulary';

/** What every driver's turn state holds: its id and whether it was asked to stop. */
export interface EngineTurnState {
  readonly turnId: string;
  interruptRequested: boolean;
}

/** A request the engine waits on, held until the consumer or a drain answers it, once. */
export interface PendingEngineRequest<A, D> {
  /** What the driver needs to answer it: the request's method, options or input. */
  readonly detail: D;
  /** The record that carries the answer, named on its `request-resolved` delta. */
  readonly answeredBy: ExecutorDelta['raw'];
  resolve(answer: A): void;
}

/** The part of a running turn that holds the requests its engine waits on. */
export interface EngineRequestTurn<A, D> {
  readonly state: EngineTurnState;
  readonly channel: BoundedChannel<ExecutorDelta>;
  readonly pending: Map<string, PendingEngineRequest<A, D>>;
}

/**
 * Hold an engine request for the consumer and offer it as a `request` delta — unless
 * the turn was already asked to stop: nobody is left to answer, so `refusal` answers it
 * at once and nothing is offered. The one place every driver decides this. The delta is
 * built before the request is held: a request whose delta cannot be built (its parameters
 * do not parse) throws here, is refused to the engine by the caller, and leaves nothing
 * held that a later drain would close on a stream that never offered it.
 */
export function holdEngineRequest<A, D>(
  turn: EngineRequestTurn<A, D>,
  request: {
    interactionId: string;
    detail: D;
    answeredBy: ExecutorDelta['raw'];
    /** Built only when the request is offered. */
    delta: () => Extract<ExecutorDelta, { type: 'request' }>;
    refusal: A;
    resolve(answer: A): void;
  },
): void {
  if (turn.state.interruptRequested) {
    request.resolve(request.refusal);
    return;
  }
  const offered = request.delta();
  turn.pending.set(request.interactionId, {
    detail: request.detail,
    answeredBy: request.answeredBy,
    resolve: request.resolve,
  });
  offerTurnDelta(turn.channel, offered);
}

/**
 * Answer one held request, remove it, and close it on the turn's stream with
 * `request-resolved`. `false` when no such request is waiting.
 */
export function answerEngineRequest<A, D>(
  turn: EngineRequestTurn<A, D>,
  interactionId: string,
  answer: A,
): boolean {
  const waiting = turn.pending.get(interactionId);
  if (waiting === undefined) return false;
  // Answer first: an answer the engine could not take (its input closed or full) throws here
  // and leaves the request held, open to another answer, and not closed on the stream.
  waiting.resolve(answer);
  turn.pending.delete(interactionId);
  offerTurnDelta(turn.channel, {
    type: 'request-resolved',
    turnId: turn.state.turnId,
    itemId: `resolved:${interactionId}`,
    raw: waiting.answeredBy,
    interactionId,
  });
  return true;
}

/**
 * Answer every request still held — the turn was interrupted, ended or lost its
 * engine — each with `answer(request)`, closing each with `request-resolved`.
 */
export function drainEngineRequests<A, D>(
  turn: EngineRequestTurn<A, D> | undefined,
  answer: (request: PendingEngineRequest<A, D>) => A,
): void {
  if (turn === undefined) return;
  for (const [interactionId, waiting] of [...turn.pending]) {
    answerEngineRequest(turn, interactionId, answer(waiting));
  }
}

/**
 * End a turn the engine ended: answer every request still held with `answer` — each closed
 * with `request-resolved` before the end — offer the turn's last `deltas`, and close its
 * stream. The one way every driver ends a turn.
 */
export function endEngineTurn<A, D>(
  turn: EngineRequestTurn<A, D> | undefined,
  answer: (request: PendingEngineRequest<A, D>) => A,
  deltas: readonly ExecutorDelta[],
): void {
  if (turn === undefined) return;
  drainEngineRequests(turn, answer);
  for (const delta of deltas) offerTurnDelta(turn.channel, delta);
  turn.channel.close();
}

/**
 * Fail a turn whose engine was lost: answer every request still held with `answer`, so
 * none is left open to a consumer whose answer would reach nobody, and fail its stream
 * with `error`. The one way every driver fails a turn.
 */
export function loseEngineTurn<A, D>(
  turn: EngineRequestTurn<A, D> | undefined,
  answer: (request: PendingEngineRequest<A, D>) => A,
  error: unknown,
): void {
  if (turn === undefined) return;
  drainEngineRequests(turn, answer);
  turn.channel.fail(error);
}
