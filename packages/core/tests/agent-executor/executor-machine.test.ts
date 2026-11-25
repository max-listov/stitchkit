/** Generations keep an earlier connection's answers out of a later one. */
import { expect, test } from 'bun:test';
import {
  advanceExecutorConnection,
  canAcceptTurn,
  INITIAL_EXECUTOR_CONNECTION,
} from '../../src/agent-executor/executor-machine';

test('an acknowledgement of an earlier connection does not make a later one ready', () => {
  let state = advanceExecutorConnection(INITIAL_EXECUTOR_CONNECTION, { type: 'connect' });
  state = advanceExecutorConnection(state, { type: 'disconnected', generation: 1 });
  state = advanceExecutorConnection(state, { type: 'connect' });
  expect(state).toEqual({ phase: 'connecting', generation: 2 });
  expect(
    advanceExecutorConnection(state, { type: 'hello-acked', generation: 1, instance: 'i' }),
  ).toEqual(state);
  state = advanceExecutorConnection(state, {
    type: 'hello-acked',
    generation: 2,
    instance: 'i',
  });
  expect(canAcceptTurn(state, 2)).toBe(true);
  expect(canAcceptTurn(state, 1)).toBe(false);
});

test('once stopping, nothing reconnects, and a late disconnect does not undo the stop', () => {
  let state = advanceExecutorConnection(INITIAL_EXECUTOR_CONNECTION, { type: 'connect' });
  state = advanceExecutorConnection(state, { type: 'stop' });
  expect(advanceExecutorConnection(state, { type: 'connect' }).phase).toBe('stopping');
  expect(advanceExecutorConnection(state, { type: 'disconnected', generation: 1 }).phase).toBe(
    'stopping',
  );
  state = advanceExecutorConnection(state, { type: 'stopped' });
  expect(advanceExecutorConnection(state, { type: 'connect' }).phase).toBe('stopped');
});
