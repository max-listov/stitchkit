import { expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { commandCleanupError } from '../src/process/group';
import {
  GroupSettlementError,
  groupSettlementDiagnostics,
} from '../src/process/group-diagnostics';

const observation: ConstructorParameters<typeof GroupSettlementError>[1] = {
  failure: 'deadline',
  groupId: 123,
  observations: 2,
  lastStates: ['?E'],
  elapsedMs: 2000,
};

test('cleanup promotes only bounded process observations through nested causes without caller messages', () => {
  const settlement = new GroupSettlementError('settlement failed', observation);
  const cause = new AggregateError(
    [new Error('private caller reason'), settlement],
    'cleanup failed',
  );
  const error = commandCleanupError(cause);
  expect(error.cause).toBe(cause);
  expect(error.code).toBe('COMMAND_CLEANUP');
  expect(error.message).toContain(JSON.stringify(observation));
  expect(inspect(error)).toContain('"lastStates":["?E"]');
  expect(error.message).not.toContain('private caller reason');
  expect(commandCleanupError(new Error('private caller reason')).message).toBe(
    'Command cleanup did not complete',
  );
});

test('cleanup diagnostic traversal bounds cycles, depth, observations and unrelated error data', () => {
  const fake = new Error('not an internal observation', { cause: observation });
  expect(groupSettlementDiagnostics(fake)).toEqual([]);
  const cycle = new Error('cycle');
  cycle.cause = cycle;
  expect(groupSettlementDiagnostics(cycle)).toEqual([]);
  const many = Array.from(
    { length: 100 },
    () => new GroupSettlementError('failed', observation),
  );
  expect(groupSettlementDiagnostics(new AggregateError(many)).length).toBe(4);
  let deep: Error = new GroupSettlementError('failed', observation);
  for (let index = 0; index < 10; index++) deep = new Error('wrapper', { cause: deep });
  expect(groupSettlementDiagnostics(deep)).toEqual([]);
});

test('cleanup diagnostics never invoke caller error accessors or replace an unreadable cause', () => {
  const getter = () => {
    throw new Error('caller accessor ran');
  };
  const caller = new Error('caller');
  Object.defineProperty(caller, 'cause', { get: getter });
  const aggregate = new AggregateError([
    caller,
    new GroupSettlementError('failed', observation),
  ]);
  const error = commandCleanupError(aggregate);
  expect(error.code).toBe('COMMAND_CLEANUP');
  expect(error.cause).toBe(aggregate);
  expect(error.message).toContain(JSON.stringify(observation));
  const inaccessible = new AggregateError([]);
  Object.defineProperty(inaccessible, 'errors', { get: getter });
  expect(commandCleanupError(inaccessible).cause).toBe(inaccessible);
  const proxy = new Proxy(caller, { getPrototypeOf: getter });
  expect(commandCleanupError(proxy).cause).toBe(proxy);
  const invalid = new AggregateError([]);
  Object.defineProperty(invalid, 'errors', { value: null });
  expect(commandCleanupError(invalid).cause).toBe(invalid);
  const array = [caller, new GroupSettlementError('failed', observation)];
  Object.defineProperty(array, '0', { get: getter });
  const indexed = new AggregateError([]);
  Object.defineProperty(indexed, 'errors', { value: array });
  expect(commandCleanupError(indexed).message).toContain(JSON.stringify(observation));
  const altered = { ...observation, lastStates: [...observation.lastStates] };
  const settlement = new GroupSettlementError('failed', altered);
  Object.defineProperty(altered, 'lastStates', { get: getter });
  expect(commandCleanupError(settlement).message).toContain(JSON.stringify(observation));
});
