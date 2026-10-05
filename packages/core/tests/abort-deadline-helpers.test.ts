import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { raceAbort } from '../src/internal/abort-race';
import { withSignalDeadline } from '../src/internal/deadline';
import { assertPositiveSafeInteger } from '../src/internal/positive-integer';
import { MAX_TIMER_MS, sleep } from '../src/internal/timers';
import { ConnectionTimeoutError } from '../src/tools/connections/errors';
import { withConnectionDeadline } from '../src/tools/connections/limits';
import type { ConnectionReadContext } from '../src/tools/connections/operation-limits';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : path.endsWith('.ts')
        ? [path]
        : [];
  });
}

test('a value that arrives after the signal won is handed to the late-value disposer', async () => {
  const controller = new AbortController();
  const late = Promise.withResolvers<string>();
  const disposed: string[] = [];
  const race = raceAbort(late.promise, controller.signal, (value) => disposed.push(value));
  controller.abort(new Error('stop'));
  await expect(race).rejects.toThrow('stop');
  late.resolve('leaked handle');
  await late.promise;
  await Promise.resolve();
  expect(disposed).toEqual(['leaked handle']);
});

test('the disposer also runs when the signal was aborted before the race began', async () => {
  const disposed: string[] = [];
  const reason = new Error('already stopped');
  await expect(
    raceAbort(Promise.resolve('late'), AbortSignal.abort(reason), (value) =>
      disposed.push(value),
    ),
  ).rejects.toBe(reason);
  await Promise.resolve();
  expect(disposed).toEqual(['late']);
});

test('a value that wins the race is not disposed and a throwing disposer cannot replace the reason', async () => {
  const disposed: string[] = [];
  const controller = new AbortController();
  expect(
    await raceAbort(Promise.resolve('kept'), controller.signal, (value) =>
      disposed.push(value),
    ),
  ).toBe('kept');
  expect(disposed).toEqual([]);
  const late = Promise.withResolvers<string>();
  const race = raceAbort(late.promise, controller.signal, () => {
    throw new Error('disposer failure');
  });
  const reason = new Error('stop');
  controller.abort(reason);
  await expect(race).rejects.toBe(reason);
  late.resolve('x');
  await late.promise;
});

test('sleep rejects with the signal reason, is refused when pre-aborted, and removes its listener', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled sleep');
  const pending = sleep(60_000, controller.signal);
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  await expect(sleep(60_000, controller.signal)).rejects.toBe(reason);
  const added: string[] = [];
  const removed: string[] = [];
  const signal = new AbortController().signal;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type: string, ...rest: [never, never?]) => {
    added.push(type);
    add(type, ...rest);
  };
  signal.removeEventListener = (type: string, ...rest: [never, never?]) => {
    removed.push(type);
    remove(type, ...rest);
  };
  await sleep(1, signal);
  expect(added).toEqual(['abort']);
  expect(removed).toEqual(['abort']);
});

test('the deadline aborts the body signal with the supplied reason and never touches the caller signal', async () => {
  const caller = new AbortController();
  const reason = new Error('deadline hit');
  let seen: AbortSignal | undefined;
  const result = await withSignalDeadline(
    5,
    caller.signal,
    () => reason,
    (signal) => {
      seen = signal;
      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    },
  ).catch((error: unknown) => error);
  expect(result).toBe(reason);
  expect(seen?.reason).toBe(reason);
  expect(caller.signal.aborted).toBe(false);
});

test('the caller reason reaches the body unchanged, and a pre-aborted caller never starts the body', async () => {
  const caller = new AbortController();
  const callerReason = { private: 'caller marker' };
  const outcome = withSignalDeadline(
    60_000,
    caller.signal,
    () => new Error('never'),
    (signal) =>
      new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  ).catch((error: unknown) => error);
  caller.abort(callerReason);
  expect(await outcome).toBe(callerReason);
  let started = false;
  await expect(
    withSignalDeadline(
      60_000,
      caller.signal,
      () => new Error('never'),
      async () => {
        started = true;
      },
    ),
  ).rejects.toBe(callerReason);
  expect(started).toBe(false);
});

test('a deadline outside the timer range is refused instead of firing at once', async () => {
  const body = async () => undefined;
  await expect(
    withSignalDeadline(MAX_TIMER_MS + 1, undefined, () => new Error('x'), body),
  ).rejects.toThrow(RangeError);
  await expect(withSignalDeadline(0, undefined, () => new Error('x'), body)).rejects.toThrow(
    'positive safe integer',
  );
});

function readContext(timeoutMs: number): ConnectionReadContext {
  return {
    timeoutMs,
    maxResponseBytes: 100,
    operation: 'tools/call',
    phase: 'call',
    observedReadBytes: 0,
  };
}

test('a connection deadline gives the body a scoped context and leaves the caller context unchanged', async () => {
  const context = readContext(20);
  let scopedSignal: AbortSignal | undefined;
  const error = await withConnectionDeadline('wire', context, undefined, async (scoped) => {
    scopedSignal = scoped.signal;
    expect(scoped).not.toBe(context);
    scoped.observedReadBytes = 7;
    return new Promise<never>(() => undefined);
  }).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(ConnectionTimeoutError);
  expect(error).toMatchObject({
    observedReadBytes: 7,
    timeoutMs: 20,
    operation: 'tools/call',
  });
  expect(scopedSignal?.aborted).toBe(true);
  expect(context.signal).toBeUndefined();
  expect(context.observedReadBytes).toBe(0);
});

test('a positive safe integer is the one accepted limit, with the owner-chosen error type', () => {
  expect(() => assertPositiveSafeInteger('limit', undefined)).not.toThrow();
  expect(() => assertPositiveSafeInteger('limit', 1)).not.toThrow();
  for (const bad of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
    expect(() => assertPositiveSafeInteger('limit', bad)).toThrow(TypeError);
  }
  expect(() => assertPositiveSafeInteger('limit', 0, RangeError)).toThrow(
    'limit must be a positive safe integer, received 0',
  );
  expect(() => assertPositiveSafeInteger('limit', 0, RangeError)).toThrow(RangeError);
});

test('the timer ceiling, the limit message and the abortable pause each have one definition', () => {
  const sources = sourceFiles(join(import.meta.dir, '..', 'src'));
  const holders = (needle: RegExp): string[] =>
    sources
      .filter((path) => needle.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(path.indexOf('/src/') + 5));
  expect(holders(/2_147_483_647|2147483647/)).toEqual(['internal/timers.ts']);
  expect(holders(/must be a positive safe integer/)).toEqual(['internal/positive-integer.ts']);
  expect(holders(/\bfunction (pause|sleep)\(/)).toEqual(['internal/timers.ts']);
});
