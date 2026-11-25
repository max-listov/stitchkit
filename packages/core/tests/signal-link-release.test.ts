/**
 * A wait linked to a caller's long-lived signal leaves no listener on it once the wait is over:
 * a connection deadline, an idle deadline and a guarded fetch each release their link — the fetch
 * once its body ended, was cancelled, or the call failed before it.
 */
import { expect, test } from 'bun:test';
import { withIdleDeadline } from '../src/internal/deadline';
import { fetchGuarded } from '../src/internal/secure-fetch';
import { withConnectionDeadline } from '../src/tools/connections/limits';
import type { ConnectionReadContext } from '../src/tools/connections/operation-limits';

/** The `abort` listeners currently attached to `signal`. */
function abortListeners(signal: AbortSignal): () => number {
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
  return () => attached;
}

const context: ConnectionReadContext = {
  operation: 'tools/call',
  phase: 'call',
  observedReadBytes: 0,
  timeoutMs: 60_000,
  idleTimeoutMs: 60_000,
  maxResponseBytes: 1024,
};

test('a connection deadline leaves no listener on the caller signal after work that ended or failed', async () => {
  const caller = new AbortController();
  const attached = abortListeners(caller.signal);
  for (let call = 0; call < 3; call += 1) {
    await expect(
      withConnectionDeadline('wire', context, caller.signal, async () => 'done'),
    ).resolves.toBe('done');
  }
  await expect(
    withConnectionDeadline('wire', context, caller.signal, async () => {
      throw new Error('work failed');
    }),
  ).rejects.toThrow('work failed');
  expect(attached()).toBe(0);
});

test('an idle deadline leaves no listener on its parent signal once its body settled', async () => {
  const parent = new AbortController();
  const attached = abortListeners(parent.signal);
  for (let call = 0; call < 3; call += 1) {
    await withIdleDeadline(
      60_000,
      parent.signal,
      () => new Error('idle'),
      async () => 'done',
    );
  }
  await withIdleDeadline(
    60_000,
    parent.signal,
    () => new Error('idle'),
    async () => {
      throw new Error('work failed');
    },
  ).catch(() => undefined);
  expect(attached()).toBe(0);
});

test('a guarded fetch leaves no listener on the caller signal once its body ended, was cancelled, or the call failed', async () => {
  const caller = new AbortController();
  const attached = abortListeners(caller.signal);
  const fetchOk = () =>
    fetchGuarded(new URL('http://1.1.1.1/'), false, {
      signal: caller.signal,
      transport: async () => new Response('ok', { status: 200 }),
    });
  await expect((await fetchOk()).text()).resolves.toBe('ok');
  expect(attached(), 'after a body read to its end').toBe(0);
  await (await fetchOk()).body?.cancel();
  expect(attached(), 'after a cancelled body').toBe(0);
  await expect(
    fetchGuarded(new URL('http://1.1.1.1/'), false, {
      signal: caller.signal,
      transport: async () => {
        throw new Error('connection refused');
      },
    }),
  ).rejects.toThrow('connection refused');
  expect(attached(), 'after a call that failed before the body').toBe(0);
  // The caller still ends a body read that is under way: the link holds until the body ends.
  const open = await fetchGuarded(new URL('http://1.1.1.1/'), false, {
    signal: caller.signal,
    // A socket the fetch's signal destroys, as the pinned transport's is.
    transport: async (_url, _resolved, signal) =>
      new Response(
        new ReadableStream({
          pull: (controller) =>
            new Promise<void>((resolve) =>
              signal?.addEventListener('abort', () => {
                controller.error(signal.reason);
                resolve();
              }),
            ),
        }),
      ),
  });
  const read = open.text();
  caller.abort(new Error('caller left'));
  await expect(read).rejects.toBeDefined();
  expect(attached(), 'after the caller ended a body read').toBe(0);
});
