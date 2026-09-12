import { expect, test } from 'bun:test';
import { createMemoryAgentRuntimeStore } from '../src/agent-runtime';
import {
  createLocalStepDurability,
  StepResultNotSerializableError,
} from '../src/agent-runtime/durability';
import { encodeStepResult } from '../src/agent-runtime/durability-ledger';

test('durable results refuse lossy JSON without executing accessors or toJSON', () => {
  let accessed = false;
  const accessor = {
    get value() {
      accessed = true;
      return 1;
    },
  };
  const custom = {
    toJSON() {
      accessed = true;
      return 1;
    },
  };
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    -0,
    undefined,
    { value: undefined },
    new Date(),
    new Map(),
    [undefined],
    Array(1),
    1n,
    accessor,
    custom,
    cycle,
    { [Symbol('x')]: 1 },
  ]) {
    expect(() => encodeStepResult('invalid', value)).toThrow(StepResultNotSerializableError);
  }
  expect(accessed).toBe(false);
});

test('first durable result and replay are detached JSON snapshots', async () => {
  const store = createMemoryAgentRuntimeStore();
  const options = { store, conversationId: 'json', runId: 'run' };
  const durable = createLocalStepDurability(options);
  const original = { values: [1, 2], nested: { ok: true } };
  const first = await durable.step('snapshot', () => original);
  original.values.push(3);
  first.values.push(4);
  const replay = await durable.step<typeof original>('snapshot', () => ({
    values: [9],
    nested: { ok: false },
  }));
  expect(replay).toEqual({ values: [1, 2], nested: { ok: true } });
  replay.values.push(5);
  expect(await durable.readRecordedStep('snapshot')).toEqual({
    values: [1, 2],
    nested: { ok: true },
  });
  expect(
    await createLocalStepDurability(options).step<typeof original>('snapshot', () => original),
  ).toEqual({
    values: [1, 2],
    nested: { ok: true },
  });
});

test('invalid numeric result is not recorded and explicit null supports effect-only steps', async () => {
  const store = createMemoryAgentRuntimeStore();
  const durable = createLocalStepDurability({ store, conversationId: 'json', runId: 'run' });
  await expect(durable.step('nan', () => NaN)).rejects.toThrow(StepResultNotSerializableError);
  expect(await durable.hasRecordedStep('nan')).toBe(false);
  let calls = 0;
  expect(
    await durable.step('effect', () => {
      calls++;
      return null;
    }),
  ).toBeNull();
  expect(
    await durable.step('effect', () => {
      calls++;
      return null;
    }),
  ).toBeNull();
  expect(calls).toBe(1);
  await expect(durable.deliver({ event: 'x', id: 'x', payload: NaN })).rejects.toThrow();
});

test('concurrent step and wait callers do not share mutable results', async () => {
  const store = createMemoryAgentRuntimeStore();
  const durable = createLocalStepDurability({
    store,
    conversationId: 'concurrent',
    runId: 'run',
  });
  let calls = 0;
  const body = () => {
    calls++;
    return { values: [1] };
  };
  const [left, right] = await Promise.all([durable.step('x', body), durable.step('x', body)]);
  left.values.push(2);
  expect(right).toEqual({ values: [1] });
  expect(calls).toBe(1);
  await durable.deliver({ event: 'ready', id: 'x', payload: { values: [1] } });
  const [a, b] = await Promise.all([
    durable.waitFor<{ values: number[] }>({ event: 'ready', id: 'x' }),
    durable.waitFor<{ values: number[] }>({ event: 'ready', id: 'x' }),
  ]);
  a.values.push(2);
  expect(b).toEqual({ values: [1] });
});

/** Compile-time negative cases, deliberately never executed. */
export function durableTypeContract(durable: ReturnType<typeof createLocalStepDurability>) {
  // @ts-expect-error Date is not a JSON result; serialize it explicitly.
  void durable.step('date', () => new Date());
  // @ts-expect-error An effect-only body must explicitly return null.
  void durable.step('void', () => {
    /* effect-only body lacks the required null result */
  });
}
