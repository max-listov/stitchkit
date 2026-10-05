import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearImmediate, setImmediate } from 'node:timers';
import { runTelegramBroadcast, type TelegramBroadcastConfig } from '../src/telegram/broadcast';
import { deferred } from './application-directory-inbox-fixture';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'stitchkit-broadcast-policy-'));
  directories.push(path);
  return path;
}
function config(
  directory: string,
  overrides: Partial<TelegramBroadcastConfig> = {},
): TelegramBroadcastConfig {
  return {
    name: 'notice',
    directory,
    recipients: () => [1],
    send: async () => undefined,
    ...overrides,
  };
}

test('an injected FLOOD_WAIT classifier requests its exact wait, then retries the same recipient', async () => {
  const dir = await directory();
  const waits: number[] = [];
  const attempts: number[] = [];
  let now = 0;
  const flood = new Error('FLOOD_WAIT_2');
  const result = await runTelegramBroadcast(
    config(dir, {
      send: async ({ attempt }) => {
        attempts.push(attempt);
        if (attempt === 1) throw flood;
      },
      classify: (error) =>
        error === flood
          ? { kind: 'retry-after', retryAfterMs: 2_000, reason: 'provider-rate-limit' }
          : { kind: 'ambiguous' },
      maxRetryDelayMs: 2_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    }),
  );
  expect(result).toMatchObject({ outcome: 'finished', delivered: 1, uncertain: 0 });
  expect(attempts).toEqual([1, 2]);
  expect(waits).toEqual([2_000]);
});

test('a provider wait above maxRetryDelayMs halts without clamping or resending early', async () => {
  const dir = await directory();
  let sends = 0;
  const waits: number[] = [];
  const result = await runTelegramBroadcast(
    config(dir, {
      send: async () => {
        sends += 1;
        throw new Error('wait');
      },
      classify: () => ({ kind: 'retry-after', retryAfterMs: 2_001 }),
      maxRetryDelayMs: 2_000,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
  );
  expect(result).toMatchObject({
    outcome: 'halted',
    pending: 1,
    halt: { kind: 'retry-after', retryAfterMs: 2_001 },
  });
  expect(sends).toBe(1);
  expect(waits).toEqual([]);
  const resumed = await runTelegramBroadcast(
    config(dir, {
      send: async () => {
        sends += 1;
      },
    }),
  );
  expect(resumed.delivered).toBe(1);
  expect(sends).toBe(2);
});

test('explicit transient failures obey the attempt budget and become failed', async () => {
  const dir = await directory();
  let attempts = 0;
  const waits: number[] = [];
  let now = 0;
  const result = await runTelegramBroadcast(
    config(dir, {
      send: async () => {
        attempts += 1;
        throw new Error('certified pre-effect failure');
      },
      classify: () => ({ kind: 'transient', reason: 'connect-refused' }),
      maxAttempts: 3,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    }),
  );
  expect(result).toMatchObject({ outcome: 'finished', failed: 1, uncertain: 0 });
  expect(attempts).toBe(3);
  expect(waits).toEqual([1_000, 2_000]);
});

test('transient backoff is capped at maxRetryDelayMs and never halts the broadcast', async () => {
  const dir = await directory();
  const waits: number[] = [];
  let now = 0;
  const result = await runTelegramBroadcast(
    config(dir, {
      send: async ({ attempt }) => {
        if (attempt <= 4) throw new Error('certified pre-effect failure');
      },
      classify: () => ({ kind: 'transient', reason: 'connect-refused' }),
      maxAttempts: 6,
      maxRetryDelayMs: 5_000,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    }),
  );
  expect(result).toMatchObject({ outcome: 'finished', delivered: 1, failed: 0 });
  expect(waits).toEqual([1_000, 2_000, 4_000, 5_000]);
});

test('injected permanent and ambiguous outcomes persist and are never resent', async () => {
  for (const failure of [
    { kind: 'permanent', recipientUnreachable: true, reason: 'recipient-gone' },
    { kind: 'ambiguous', reason: 'transport-outcome-unknown' },
  ] as const) {
    const dir = await directory();
    let attempts = 0;
    const options = config(dir, {
      send: async () => {
        attempts += 1;
        throw new Error('provider');
      },
      classify: () => failure,
    });
    const first = await runTelegramBroadcast(options);
    expect(first.uncertain + first.unreachable).toBe(1);
    await runTelegramBroadcast(options);
    expect(attempts).toBe(1);
  }
});

test('abort interrupts a custom backoff sleeper that ignores its signal before another send', async () => {
  const dir = await directory();
  const stop = new AbortController();
  const sleeping = deferred();
  let attempts = 0;
  const running = runTelegramBroadcast(
    config(dir, {
      signal: stop.signal,
      send: async () => {
        attempts += 1;
        throw new Error('transient');
      },
      classify: () => ({ kind: 'transient' }),
      sleep: async (_, signal) => {
        expect(signal).toBe(stop.signal);
        sleeping.resolve();
        await new Promise<void>(() => undefined);
      },
    }),
  );
  await sleeping.promise;
  stop.abort(new Error('shutdown'));
  expect(await running).toMatchObject({ outcome: 'stopped', pending: 1 });
  expect(attempts).toBe(1);
  expect((await runTelegramBroadcast(config(dir))).delivered).toBe(1);
});

test('abort during pacing never starts the next recipient', async () => {
  const dir = await directory();
  const stop = new AbortController();
  const sleeping = deferred();
  const sent: number[] = [];
  const running = runTelegramBroadcast(
    config(dir, {
      recipients: () => [1, 2],
      signal: stop.signal,
      send: async ({ recipient }) => {
        sent.push(Number(recipient));
      },
      now: () => 0,
      sleep: async () => {
        sleeping.resolve();
        await new Promise<void>(() => undefined);
      },
    }),
  );
  await sleeping.promise;
  stop.abort();
  expect(await running).toMatchObject({ outcome: 'stopped', delivered: 1, pending: 1 });
  expect(sent).toEqual([1]);
});

test('caller abort during the lock check after backoff prevents retry and preserves pending work', async () => {
  for (const cancel of [false, true]) {
    const dir = await directory();
    const stop = new AbortController();
    const calls: Array<{ attempt: number; aborted: boolean }> = [];
    let pendingAbort: ReturnType<typeof setImmediate> | undefined;
    let result: Awaited<ReturnType<typeof runTelegramBroadcast>>;
    try {
      result = await runTelegramBroadcast(
        config(dir, {
          signal: stop.signal,
          classify: () => ({ kind: 'retry-after', retryAfterMs: 1 }),
          sleep: async () => {
            if (cancel && calls.length === 1)
              pendingAbort = setImmediate(() => stop.abort(new Error('caller cancelled')));
          },
          send: async ({ attempt }) => {
            calls.push({ attempt, aborted: stop.signal.aborted });
            if (attempt === 1) throw new Error('known refusal before effect');
          },
        }),
      );
    } finally {
      if (pendingAbort) clearImmediate(pendingAbort);
    }
    expect(calls.every((call) => !call.aborted)).toBe(true);
    if (!cancel) {
      expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
      expect(result).toMatchObject({ outcome: 'finished', delivered: 1, pending: 0 });
      continue;
    }
    expect(stop.signal.aborted).toBe(true);
    expect(calls.map((call) => call.attempt)).toEqual([1]);
    expect(result).toMatchObject({
      outcome: 'stopped',
      delivered: 0,
      pending: 1,
      uncertain: 0,
    });
    expect(await readFile(join(dir, 'notice.journal.ndjson'), 'utf8')).toContain(
      '"s":"released"',
    );
    expect(await runTelegramBroadcast(config(dir))).toMatchObject({
      delivered: 1,
      uncertain: 0,
    });
  }
});

test('invalid classifier results leave a durable sending intent for uncertain recovery', async () => {
  const dir = await directory();
  let sends = 0;
  await expect(
    runTelegramBroadcast(
      config(dir, {
        send: async () => {
          sends += 1;
          throw new Error('unknown');
        },
        classify: () => ({ kind: 'retry-after', retryAfterMs: NaN }),
      }),
    ),
  ).rejects.toBeDefined();
  expect(await readFile(join(dir, 'notice.journal.ndjson'), 'utf8')).toBe(
    '{"i":0,"s":"sending"}\n',
  );
  expect(
    await runTelegramBroadcast(
      config(dir, {
        send: async () => {
          sends += 1;
        },
      }),
    ),
  ).toMatchObject({ uncertain: 1, delivered: 0, outcome: 'finished' });
  expect(sends).toBe(1);
});

test('loss of lock during an in-flight send refuses stale receipt and next send, preserving replacement', async () => {
  const dir = await directory();
  const entered = deferred();
  const finish = deferred();
  const sends: number[] = [];
  const running = runTelegramBroadcast(
    config(dir, {
      recipients: () => [1, 2],
      send: async ({ recipient }) => {
        sends.push(Number(recipient));
        entered.resolve();
        await finish.promise;
      },
    }),
  );
  await entered.promise;
  const lock = join(dir, 'notice.lock');
  const replacement = JSON.stringify({ pid: process.pid, token: 'replacement' });
  await unlink(lock);
  await writeFile(lock, replacement);
  finish.resolve();
  await expect(running).rejects.toBeDefined();
  expect(sends).toEqual([1]);
  expect(await readFile(lock, 'utf8')).toBe(replacement);
  expect(await readFile(join(dir, 'notice.journal.ndjson'), 'utf8')).toBe(
    '{"i":0,"s":"sending"}\n',
  );
  await expect(runTelegramBroadcast(config(dir))).rejects.toThrow('owner is unknown');
  await unlink(lock); // This test owns the replacement; production cannot discard an unknown owner.
  expect(
    await runTelegramBroadcast(
      config(dir, {
        send: async ({ recipient }) => {
          sends.push(Number(recipient));
        },
      }),
    ),
  ).toMatchObject({ uncertain: 1, delivered: 1 });
  expect(sends).toEqual([1, 2]);
});

test('finite retry, pacing and progress bounds refuse invalid options before creating job files', async () => {
  const dir = await directory();
  const invalid: Partial<TelegramBroadcastConfig>[] = [
    ...[0, -1, Infinity, NaN, 1e-20].map((ratePerSecond) => ({ ratePerSecond })),
    ...[0, 101, 1.5, Infinity].map((maxAttempts) => ({ maxAttempts })),
    ...[-1, 1.5, Infinity, 2_147_483_648].map((maxRetryDelayMs) => ({ maxRetryDelayMs })),
    ...[-1, 0.5, Infinity, 2_147_483_648].map((progressEveryMs) => ({ progressEveryMs })),
  ];
  for (const options of invalid)
    await expect(runTelegramBroadcast(config(dir, options))).rejects.toBeDefined();
  expect(await readdir(dir)).toEqual([]);
});
