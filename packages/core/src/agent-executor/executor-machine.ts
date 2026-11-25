/**
 * The executor's connection to its server, as a pure machine: the
 * application drives the transport and feeds events; the machine says what
 * the executor may do. Every new connection is a new generation, so an event
 * or an answer that belongs to an earlier connection is told apart and
 * dropped instead of acted on.
 */
export type ExecutorConnectionState =
  | { phase: 'disconnected'; generation: number }
  | { phase: 'connecting'; generation: number }
  | { phase: 'ready'; generation: number; instance: string }
  | { phase: 'stopping'; generation: number }
  | { phase: 'stopped'; generation: number };

/** Input event driving `advanceExecutorConnection` state transitions. */
export type ExecutorConnectionEvent =
  | { type: 'connect' }
  | { type: 'hello-acked'; generation: number; instance: string }
  | { type: 'disconnected'; generation: number }
  | { type: 'stop' }
  | { type: 'stopped' };

/** Initial disconnected state (generation 0) for an executor connection machine. */
export const INITIAL_EXECUTOR_CONNECTION: ExecutorConnectionState = {
  phase: 'disconnected',
  generation: 0,
};

/**
 * The next state. `connect` opens a new generation; an acknowledgement or a
 * disconnect of another generation changes nothing; once stopping, nothing
 * reconnects.
 */
export function advanceExecutorConnection(
  state: ExecutorConnectionState,
  event: ExecutorConnectionEvent,
): ExecutorConnectionState {
  if (state.phase === 'stopped') return state;
  switch (event.type) {
    case 'connect':
      if (
        state.phase === 'stopping' ||
        state.phase === 'ready' ||
        state.phase === 'connecting'
      ) {
        return state;
      }
      return { phase: 'connecting', generation: state.generation + 1 };
    case 'hello-acked':
      if (state.phase !== 'connecting' || event.generation !== state.generation) return state;
      return { phase: 'ready', generation: state.generation, instance: event.instance };
    case 'disconnected':
      if (event.generation !== state.generation || state.phase === 'stopping') return state;
      return { phase: 'disconnected', generation: state.generation };
    case 'stop':
      return { phase: 'stopping', generation: state.generation };
    case 'stopped':
      return state.phase === 'stopping'
        ? { phase: 'stopped', generation: state.generation }
        : state;
  }
}

/** Whether a turn may be accepted: only while ready, and only under the generation it came on. */
export function canAcceptTurn(state: ExecutorConnectionState, generation: number): boolean {
  return state.phase === 'ready' && state.generation === generation;
}
