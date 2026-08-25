import { afterEach, describe, expect, test } from 'bun:test';
import { parseNDJSON, parseSSE } from '../src/browser/stream';
import { createServer } from '../src/server/bun';
import { ndjsonRoute, sseRoute, streamingRoute } from '../src/server/streaming-route';
import type { RawRoute } from '../src/server/types';

/**
 * The test that was missing where this defect lived.
 *
 * Every existing check on those routes published an event immediately after
 * subscribing, so none of them survived long enough to reach the ten-second
 * idle threshold — and a route with no timeout handling, no heartbeat and no
 * opening flush passed all of them. What proves the primitive is a subscription
 * that stays SILENT for longer than the threshold and is still alive at the end.
 */

const servers: { shutdown: (options: { gracePeriodMs: number }) => unknown }[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown({ gracePeriodMs: 0 });
});

function serve(route: RawRoute<unknown>): string {
  const server = createServer({ port: 0, rawRoutes: [route] });
  servers.push(server);
  return `http://localhost:${server.port}`;
}

/**
 * A subscription that never fires — the shape of a quiet plane.
 *
 * It waits on the signal, because that is the contract: an async generator
 * parked on its next value cannot be interrupted by `iterator.return()`, which
 * is queued behind the pending `next()`. A fixture that ignored the signal
 * would be asserting something the runtime cannot deliver.
 */
function silentSource(): {
  source: (request: Request, context: { signal: AbortSignal }) => AsyncIterable<unknown>;
  closed: Promise<void>;
} {
  let markClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  async function* generate(
    _request: Request,
    { signal }: { signal: AbortSignal },
  ): AsyncGenerator<unknown> {
    try {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    } finally {
      markClosed();
    }
  }
  return { source: generate, closed };
}

describe('a long-lived streaming route takes the checklist off the author', () => {
  test('the headers arrive at open, before the source has said anything', async () => {
    // Point 3. Without the opening keep-alive the runtime holds the response
    // until the body produces a byte, so `fetch` does not return — and "subscribed
    // and silent" is indistinguishable from "not answering", with no response to
    // inspect because there is no response yet.
    const { source } = silentSource();
    const url = serve(ndjsonRoute({ path: '/events', source }));
    const controller = new AbortController();
    const response = await Promise.race([
      fetch(`${url}/events`, { signal: controller.signal }),
      Bun.sleep(2_000).then(() => {
        throw new Error('fetch did not return before the source produced anything');
      }),
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    controller.abort();
  });

  test('a silent subscription outlives the generic idle threshold', async () => {
    // Points 1 and 2, and the reason this file exists. Bun resets an idle HTTP
    // connection after ten seconds; a subscription to a rare event is idle by
    // nature. Twelve seconds of silence, then the stream must still be live.
    const { source } = silentSource();
    const url = serve(ndjsonRoute({ path: '/events', heartbeatMs: 250, source }));
    const controller = new AbortController();
    const response = await fetch(`${url}/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    const deadline = Date.now() + 12_000;
    let beats = 0;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        Bun.sleep(3_000).then(() => ({ done: true, value: undefined })),
      ]);
      // A closed connection reads as `done`. That is the failure this is for.
      expect(chunk.done).toBe(false);
      beats += 1;
    }
    expect(beats).toBeGreaterThan(10);
    controller.abort();
  }, 30_000);

  test('a disconnect closes the source, so nothing is left running', async () => {
    // The fourth thing, and the one nobody remembers to test: a departed
    // consumer must not leave live work on the server.
    const { source, closed } = silentSource();
    const url = serve(ndjsonRoute({ path: '/events', heartbeatMs: 200, source }));
    const controller = new AbortController();
    await fetch(`${url}/events`, { signal: controller.signal });
    controller.abort();

    const outcome = await Promise.race([
      closed.then(() => 'closed'),
      Bun.sleep(5_000).then(() => 'still running'),
    ]);
    expect(outcome).toBe('closed');
  }, 15_000);

  test('frames arrive as NDJSON, and the keep-alives between them are skipped', async () => {
    async function* three(): AsyncGenerator<unknown> {
      yield { n: 1 };
      await Bun.sleep(120);
      yield { n: 2 };
      await Bun.sleep(120);
      yield { n: 3 };
    }
    // A heartbeat faster than the gaps, so blank lines are guaranteed to be
    // interleaved with the data — the reading rule is under test, not assumed.
    const url = serve(ndjsonRoute({ path: '/events', heartbeatMs: 30, source: three }));
    const response = await fetch(`${url}/events`);
    const received: unknown[] = [];
    for await (const frame of parseNDJSON(response)) received.push(frame);
    expect(received).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  }, 15_000);

  test('the SSE framing is the one `parseSSE` already reads', async () => {
    async function* two(): AsyncGenerator<unknown> {
      yield { n: 1 };
      yield { n: 2 };
    }
    const url = serve(sseRoute({ path: '/events', source: two }));
    const response = await fetch(`${url}/events`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const received: unknown[] = [];
    for await (const frame of parseSSE(response)) received.push(frame);
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);
  });

  test('a failure mid-stream arrives as the framework error envelope', async () => {
    // The headers left long ago, so there is no status left to send. What a
    // consumer must never get instead is the raw internal message.
    async function* fails(): AsyncGenerator<unknown> {
      yield { n: 1 };
      throw new Error('the database password is hunter2');
    }
    const url = serve(ndjsonRoute({ path: '/events', source: fails }));
    const received: unknown[] = [];
    for await (const frame of parseNDJSON(await fetch(`${url}/events`))) received.push(frame);

    expect(received[0]).toEqual({ n: 1 });
    const envelope = received[1];
    expect(JSON.stringify(envelope)).not.toContain('hunter2');
    expect(JSON.stringify(envelope)).toContain('INTERNAL_SERVER_ERROR');
  });

  test('clearing the idle timeout is load-bearing on its own', async () => {
    // The falsifying half the first version of this file was missing. With a
    // fast heartbeat, EITHER measure alone keeps the connection up, so the test
    // above passes with `applyIdleTimeout` deleted. Here the heartbeat is
    // deliberately longer than Bun's ten-second threshold, so the only thing
    // holding the connection open is the cleared timeout — and a duck-typed
    // `Reflect.get(server, 'timeout')` that silently stops resolving is exactly
    // the regression that would otherwise ship unnoticed.
    const { source } = silentSource();
    const url = serve(ndjsonRoute({ path: '/events', heartbeatMs: 60_000, source }));
    const controller = new AbortController();
    const response = await fetch(`${url}/events`, { signal: controller.signal });
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) return;

    // The opening keep-alive is already on the wire — that is point 3. Consume
    // it, then wait past the threshold with nothing else due for a minute.
    const opening = await reader.read();
    expect(opening.done).toBe(false);

    const outcome = await Promise.race([
      reader.read().then((chunk) => (chunk.done ? 'closed' : 'unexpected frame')),
      Bun.sleep(13_000).then(() => 'still open'),
    ]);
    expect(outcome).toBe('still open');
    controller.abort();
  }, 30_000);

  test('the framing headers win over a consumer header of any spelling', async () => {
    // Spread does not do this. Object keys are case-sensitive and `Headers`
    // built from a record APPEND, so the lower-case spelling — the one a
    // consumer naturally writes — used to ship
    // `content-type: application/x-ndjson; charset=utf-8, application/x-ndjson`:
    // a malformed type rather than an overridden one.
    const url = serve(
      ndjsonRoute({
        path: '/events',
        heartbeatMs: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'cache-control': 'max-age=99',
          'x-consumer': 'kept',
        },
        source: silentSource().source,
      }),
    );
    const controller = new AbortController();
    const response = await fetch(`${url}/events`, { signal: controller.signal });
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    // A header that does not collide is still the consumer's to set.
    expect(response.headers.get('x-consumer')).toBe('kept');
    controller.abort();
  });

  test('an always-ready source neither starves the runtime nor runs away', async () => {
    // Two measured failures in one, and the first is the worse one.
    //
    // A source that is never waiting resolves `next()` as a microtask, so the
    // pump spun without the event loop ever getting a turn: 19.5 million frames
    // produced and the consumer's `fetch` never returned at all. Point 3 —
    // headers at open — silently stopped being true for exactly the source that
    // has the most to say. Second, nothing bounded production: frames left the
    // source as fast as it could make them, against a reader that read nothing.
    let produced = 0;
    async function* firehose(): AsyncGenerator<unknown> {
      for (;;) {
        produced += 1;
        yield { n: produced, filler: 'x'.repeat(200) };
      }
    }
    const url = serve(ndjsonRoute({ path: '/events', heartbeatMs: 50, source: firehose }));
    const controller = new AbortController();

    // Opened and then deliberately never read. Without the hand-back this never
    // resolves.
    const response = await Promise.race([
      fetch(`${url}/events`, { signal: controller.signal }),
      Bun.sleep(4_000).then(() => {
        throw new Error(`an always-ready source starved the runtime after ${produced} frames`);
      }),
    ]);
    expect(response.status).toBe(200);

    await Bun.sleep(1_000);
    controller.abort();

    // Generous by two orders of magnitude — the claim is a bound, not a number.
    // Unbounded reached eight figures inside this window.
    expect(produced).toBeLessThan(200_000);
  }, 30_000);

  test('breaking out of the reader cancels the body it was reading', async () => {
    // What the reader can guarantee, and no more.
    //
    // `parseNDJSON` used to only release the lock, leaving the body open. It now
    // cancels it, which is correct on its own terms — but measured against Bun
    // today, a client-side cancel does NOT promptly reach the server: the source
    // stayed alive for seconds afterwards. So ending a SUBSCRIPTION is an
    // `AbortController` (proved by "a disconnect closes the source" above), and
    // the guide says so rather than showing a `break` that only half works.
    async function* two(): AsyncGenerator<unknown> {
      yield { n: 1 };
      yield { n: 2 };
      yield { n: 3 };
    }
    const url = serve(ndjsonRoute({ path: '/events', heartbeatMs: 200, source: two }));
    const response = await fetch(`${url}/events`);

    const received: unknown[] = [];
    for await (const frame of parseNDJSON(response)) {
      received.push(frame);
      if (received.length === 2) break;
    }
    expect(received).toEqual([{ n: 1 }, { n: 2 }]);

    // The body is cancelled, not merely unlocked: a fresh reader is finished
    // immediately. Without the cancel this read would wait for the third frame.
    const after = response.body?.getReader();
    expect(after).toBeDefined();
    if (!after) return;
    const next = await Promise.race([
      after.read(),
      Bun.sleep(2_000).then(() => ({ done: false, value: undefined })),
    ]);
    expect(next.done).toBe(true);
  }, 15_000);

  test('an unusable heartbeat is refused at construction, not at the first pulse', () => {
    const { source } = silentSource();
    expect(() => streamingRoute({ path: '/x', heartbeatMs: 0, source })).toThrow(TypeError);
    expect(() => streamingRoute({ path: '/x', heartbeatMs: Number.NaN, source })).toThrow(
      TypeError,
    );
    expect(() => streamingRoute({ path: '/x', idleTimeoutSeconds: -1, source })).toThrow(
      TypeError,
    );
    // The branch `Number.isInteger` exists for: seconds, not milliseconds.
    expect(() => streamingRoute({ path: '/x', idleTimeoutSeconds: 1.5, source })).toThrow(
      TypeError,
    );
  });
});
