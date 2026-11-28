import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  abortReason,
  linkAbortSignals,
  raceAbort,
  untilAborted,
  withLinkedAbortSignals,
} from '../src/internal/abort-race';
import { assertTimerMs, withSignalDeadline } from '../src/internal/deadline';
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
    'Deadline timeoutMs must be an integer from 1 to 2147483647 milliseconds, received 0',
  );
});

test('a timer duration is one rule: a number is a range, a non-number a type, absence a choice', () => {
  expect(() => assertTimerMs('wait', undefined)).not.toThrow();
  expect(() => assertTimerMs('wait', undefined, { absent: 'refused' })).toThrow(TypeError);
  expect(() => assertTimerMs('wait', 1)).not.toThrow();
  expect(() => assertTimerMs('wait', MAX_TIMER_MS)).not.toThrow();
  expect(() => assertTimerMs('wait', 0, { min: 0 })).not.toThrow();
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_MS + 1]) {
    expect(() => assertTimerMs('wait', bad), String(bad)).toThrow(RangeError);
  }
  expect(() => assertTimerMs('wait', -1, { min: 0 })).toThrow(RangeError);
  expect(() => assertTimerMs('wait', JSON.parse('"5"'))).toThrow(TypeError);
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
  expect(holders(/milliseconds, received/)).toEqual(['internal/deadline.ts']);
  // A hand-written range check against the timer ceiling is a second copy of `assertTimerMs`.
  expect(holders(/[<>]=?\s*MAX_TIMER_MS\b/)).toEqual(['internal/deadline.ts']);
  expect(holders(/\bfunction (pause|sleep)\(/)).toEqual(['internal/timers.ts']);
});

function listenerLedger(signal: AbortSignal): { readonly attached: () => number } {
  let attached = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (type: string, ...rest: [never, never?]) => {
    if (type === 'abort') attached += 1;
    add(type, ...rest);
  };
  signal.removeEventListener = (type: string, ...rest: [never, never?]) => {
    if (type === 'abort') attached -= 1;
    remove(type, ...rest);
  };
  return { attached: () => attached };
}

test('untilAborted reads the value or the abort, never rejects for the signal, and detaches on settlement', async () => {
  const longLived = new AbortController();
  const ledger = listenerLedger(longLived.signal);
  expect(await untilAborted(Promise.resolve('done'), longLived.signal)).toEqual({
    aborted: false,
    value: 'done',
  });
  await expect(
    untilAborted(Promise.reject(new Error('work failed')), longLived.signal),
  ).rejects.toThrow('work failed');
  expect(ledger.attached()).toBe(0);

  const stopping = new AbortController();
  const hung = untilAborted(new Promise<never>(() => undefined), stopping.signal);
  stopping.abort(new Error('stop'));
  expect(await hung).toEqual({ aborted: true });
  expect(await untilAborted(Promise.resolve('late'), AbortSignal.abort())).toEqual({
    aborted: true,
  });
});

test('linkAbortSignals forwards the first reason and detaches from both sources on release or abort', () => {
  const first = new AbortController();
  const second = new AbortController();
  const firstLedger = listenerLedger(first.signal);
  const secondLedger = listenerLedger(second.signal);
  const released = linkAbortSignals(first.signal, second.signal);
  expect([firstLedger.attached(), secondLedger.attached()]).toEqual([1, 1]);
  released.release();
  expect([firstLedger.attached(), secondLedger.attached()]).toEqual([0, 0]);
  expect(released.signal.aborted).toBe(false);

  const aborted = linkAbortSignals(first.signal, second.signal);
  const reason = new Error('second stopped');
  second.abort(reason);
  expect(aborted.signal.reason).toBe(reason);
  expect([firstLedger.attached(), secondLedger.attached()]).toEqual([0, 0]);
  expect(linkAbortSignals(first.signal, second.signal).signal.reason).toBe(reason);
});

test('linkAbortSignals skips an absent source, links any number, and is the one signal given alone', () => {
  const only = new AbortController();
  const alone = linkAbortSignals(undefined, only.signal);
  expect(alone.signal).toBe(only.signal);
  alone.release();
  expect(only.signal.aborted).toBe(false);

  const sources = [new AbortController(), new AbortController(), new AbortController()];
  const ledgers = sources.map((source) => listenerLedger(source.signal));
  const [a, b, c] = sources.map((source) => source.signal);
  if (!a || !b || !c) throw new Error('three sources');
  const linked = linkAbortSignals(a, undefined, b, c);
  expect(ledgers.map((ledger) => ledger.attached())).toEqual([1, 1, 1]);
  const reason = new Error('the middle source stopped');
  sources[1]?.abort(reason);
  expect(linked.signal.reason).toBe(reason);
  expect(ledgers.map((ledger) => ledger.attached())).toEqual([0, 0, 0]);
  expect(linkAbortSignals(a, b, c).signal.reason).toBe(reason);
});

test('waiting for an abort and reading its reason each have one owner in the source', () => {
  const sources = sourceFiles(join(import.meta.dir, '..', 'src'));
  const holders = (needle: RegExp): string[] =>
    sources
      .filter((path) => needle.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(path.indexOf('/src/') + 5));
  expect(holders(/addEventListener\(\s*'abort',\s*\(\)\s*=>\s*res(?:olve)?\(\)/)).toEqual([]);
  expect(holders(/\breason \?\? abortError\(/)).toEqual(['internal/abort-race.ts']);
  // Linking a caller's signal to one a component owns is `linkAbortSignals`; a second linker
  // forwards the reason its own way and keeps its listener on its own terms.
  expect(holders(/\bfunction \w*[lL]ink\w*(?:Abort|Signal)\w*\(/)).toEqual([
    'internal/abort-race.ts',
  ]);
  // An abort reason read off a callback and replaced by an invented error is `abortReason`.
  expect(holders(/\breason \?\? new \w*Error\(/)).toEqual([]);
  // A signal's reason handed on as the failure — thrown, rejected, passed to a finisher, or
  // picked by a ternary — is `abortReason(signal)`: a signal aborted without a reason still
  // fails with an `AbortError`, never with `undefined` or a substitute the call site invented.
  // Any signal's name counts (`outerSignal`). An abort listener handing the reason to a call of
  // its own (`=> finish(signal?.reason)`) is a finisher; one forwarding it into another
  // object's `abort`/`cancel` (`controller.abort(signal.reason)`) passes it on and is not.
  const bareReason =
    /(?:\bthrow\s+|\breject\w*\(|\bPromise\.reject\(|\?\s|=>\s*(?:void\s+)?(?:this\.)?\w+\(\s*)(?:[\w$]+\??\.)*\w*[sS]ignal\??\.reason\b|\b\w*(?:signal|Signal|parent)\??\.reason\s*\?\?/;
  for (const form of [
    'if (options.signal?.aborted) throw options.signal.reason;',
    'if (outerSignal?.aborted) throw outerSignal.reason;',
    'const onAbort = (): void => finish(signal?.reason, true);',
    'const abort = () => this.close(signal?.reason);',
    'return Promise.reject(signal.reason);',
    'rejectWait(signal.reason);',
    'controller.error(signal.aborted ? signal.reason : error);',
    "fail(parent?.reason ?? new Error('aborted'));",
    "controller.abort(signal.reason ?? abortError('aborted'));",
  ]) {
    expect(bareReason.test(form), form).toBe(true);
  }
  for (const form of [
    'controller.abort(signal.reason);',
    'const cancel = () => void reader.cancel(signal?.reason).catch(() => undefined);',
    "if (signal.reason === 'timeout') return 'timeout';",
    'if (error === signal.reason) throw error;',
  ]) {
    expect(bareReason.test(form), form).toBe(false);
  }
  const owner = join('src', 'internal', 'abort-race.ts');
  const bareReasonLines = sources
    .filter((path) => !path.endsWith(owner))
    .flatMap((path) =>
      readFileSync(path, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          bareReason.test(line)
            ? [`${path.slice(path.indexOf('/src/') + 5)}:${index + 1}`]
            : [],
        ),
    );
  expect(bareReasonLines).toEqual([]);
  // Signals are linked one way across the source: `linkAbortSignals`, released where the linked
  // work ends. React Native keeps `AbortSignal.any` listeners on its sources until one aborts, so
  // a long-lived source (a session, a run, a lifetime) would retain every composite ever made.
  // `browser/session.ts` (`bindFetch`) is the one exception: its response goes back to a
  // generated client that reads a streamed body after the fetch resolves, and the session must
  // still abort that read; a `Response` exposes no point where its body is done, so a JS link
  // released at that point does not exist, and one held until abort would pin a strong listener
  // on the long-lived session signal where native `AbortSignal.any` holds none.
  expect(holders(/\bAbortSignal\.any\(/)).toEqual(['browser/session.ts']);
  // A controller that exists only to follow a caller and a timer is `linkAbortSignals`. A
  // signal's reason forwarded by hand is left only where the controller is an owned lifetime its
  // owner aborts and reads on its own — a link yields a second, derived signal, not that owner.
  const forwardedByHand = /\.abort\(\s*(?:[\w$]+\??\.)*\w*[sS]ignal\??\.reason\s*\)/g;
  expect('controller.abort(sourceSignal.reason);'.match(forwardedByHand)).toHaveLength(1);
  expect(
    Object.fromEntries(
      sources.flatMap((path) => {
        const count = readFileSync(path, 'utf8').match(forwardedByHand)?.length ?? 0;
        return count > 0 ? [[path.slice(path.indexOf('/src/') + 5), count]] : [];
      }),
    ),
  ).toEqual({
    // Claude SDK takes an AbortController whose lifetime the probe also aborts in finally.
    'agent-executor/claude-sdk/probe.ts': 1,
    // The command's lifetime: also aborted by `killOn`, its deadline and the owner's own stop.
    'process/command-owner.ts': 2,
    // A close deadline armed only after the leader exits, into a controller the caller owns;
    // a settlement signal that its own completion aborts too.
    'process/leader-settlement.ts': 3,
    // The stream's lifetime: aborted by its lifetime timer and close, read to tell a
    // cancellation from a failure.
    'server/endpoint-dispatch.ts': 2,
    'tools/cli/run-stream.ts': 1,
  });
});

test('abortReason has one definition, falls back to AbortError, and withLinkedAbortSignals detaches listeners on settlement', async () => {
  const sources = sourceFiles(join(import.meta.dir, '..', 'src'));
  const abortReasonHolders = sources
    .filter((path) => /\bfunction abortReason\(/.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(path.indexOf('/src/') + 5));
  expect(abortReasonHolders).toEqual(['internal/abort-race.ts']);

  const customSignal = { aborted: true, reason: undefined } as unknown as AbortSignal;
  const fallback = abortReason(customSignal);
  expect(fallback).toBeInstanceOf(Error);
  expect((fallback as Error).name).toBe('AbortError');
  await expect(raceAbort(Promise.resolve('never'), customSignal)).rejects.toMatchObject({
    name: 'AbortError',
  });

  const added: string[] = [];
  const removed: string[] = [];
  const longLived = new AbortController();
  const add = longLived.signal.addEventListener.bind(longLived.signal);
  const remove = longLived.signal.removeEventListener.bind(longLived.signal);
  longLived.signal.addEventListener = (type: string, ...rest: [never, never?]) => {
    added.push(type);
    add(type, ...rest);
  };
  longLived.signal.removeEventListener = (type: string, ...rest: [never, never?]) => {
    removed.push(type);
    remove(type, ...rest);
  };
  const perCall = new AbortController();
  const value = await withLinkedAbortSignals(
    perCall.signal,
    longLived.signal,
    async (signal) => {
      expect(signal.aborted).toBe(false);
      return 'done';
    },
  );
  expect(value).toBe('done');
  expect(added).toEqual(['abort']);
  expect(removed).toEqual(['abort']);
});
