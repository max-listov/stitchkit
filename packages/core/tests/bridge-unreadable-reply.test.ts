/**
 * A reply the window cannot read ends the call, once.
 *
 * A response frame is valid by its schema and still may not become a `Response`
 * in the window: a host whose `Headers` does not check values (`whatwg-fetch`
 * keeps `String(value)`) sends a header that is not a ByteString, such as a
 * `Content-Disposition` with a Cyrillic file name. The call is refused at once,
 * the caller's abort and timeout keep working until it ends, and a refusal that
 * the same host would repeat is never replayed — neither this one nor a reply
 * frame that is not a reply or answers another id.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { classifyBridgeTransportRetry } from '../src/browser/bridge-errors';
import { defineContract } from '../src/entrypoints/contract';
import {
  BRIDGE_ORIGIN,
  type BridgeClientPort,
  createBridgeFetch,
  createClient,
  createHttpClient,
} from '../src/entrypoints/http';

const UNREADABLE_HEADER = [
  'content-disposition',
  'attachment; filename="отчёт.json"',
] as const;

const contract = defineContract(
  { prefix: 'p' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Ping',
      output: z.object({ ok: z.boolean() }),
    },
  },
);

/** A host that answers every request with `reply(id)` and counts the requests it saw. */
function fakeHost(reply: (id: string) => unknown): {
  port: BridgeClientPort;
  requests: () => number;
} {
  const listeners = new Set<(frame: string) => void>();
  let requests = 0;
  return {
    port: {
      postMessage(frame) {
        const parsed: { kind: string; id: string } = JSON.parse(frame);
        if (parsed.kind !== 'request') return;
        requests += 1;
        setTimeout(() => {
          for (const listener of listeners) listener(JSON.stringify(reply(parsed.id)));
        }, 1);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    requests: () => requests,
  };
}

const unreadableReply = (id: string) => ({
  v: 1,
  kind: 'response',
  id,
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/json'], UNREADABLE_HEADER],
  body: '{"ok":true}',
});

/** How the call ended within `ms`: its settlement, or `pending`. */
async function settledWithin(call: Promise<unknown>, ms: number): Promise<string> {
  const outcome = call.then(
    () => 'resolved',
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
  );
  const pending = new Promise<string>((resolve) => setTimeout(() => resolve('pending'), ms));
  return Promise.race([outcome, pending]);
}

describe('a reply the window cannot read', () => {
  test('this runtime refuses the header the host sent', () => {
    expect(() => new Headers([[...UNREADABLE_HEADER]])).toThrow();
  });

  test('a port call is refused at once instead of left pending', async () => {
    const host = fakeHost(unreadableReply);
    const bridgeFetch = createBridgeFetch(host.port);
    const caller = new AbortController();
    try {
      const call = bridgeFetch(`${BRIDGE_ORIGIN}/p/ping`, { signal: caller.signal });
      const outcome = await settledWithin(call, 500);
      expect(outcome).toStartWith('rejected: Bridge reply cannot be read as a Response');
      caller.abort(new Error('caller gave up'));
    } finally {
      bridgeFetch.close();
    }
  });

  test('createClient and createHttpClient end the call and do not replay it', async () => {
    for (const via of ['createClient', 'createHttpClient'] as const) {
      const host = fakeHost(unreadableReply);
      const bridgeFetch = createBridgeFetch(host.port);
      const config = {
        baseUrl: BRIDGE_ORIGIN,
        fetch: bridgeFetch,
        timeout: 100,
        retry: { limit: 3 },
      };
      const call =
        via === 'createClient'
          ? createClient(contract, config).ping()
          : createHttpClient(config).get('/p/ping');
      try {
        const outcome = await settledWithin(call, 1000);
        expect(outcome, via).toStartWith('rejected:');
        expect(host.requests(), via).toBe(1);
      } finally {
        bridgeFetch.close();
      }
    }
  });

  test('a reply over this window frame limit or with a code it does not know ends the call', async () => {
    const big = (id: string) => ({
      ...unreadableReply(id),
      headers: [],
      body: 'x'.repeat(5000),
    });
    const unknownCode = (id: string) => ({
      v: 1,
      kind: 'failure',
      id,
      code: 'from-a-newer-host',
    });
    for (const [name, reply, code] of [
      ['over the limit', big, 'frame-too-large'],
      ['unknown code', unknownCode, undefined],
    ] as const) {
      const host = fakeHost(reply);
      const drops: string[] = [];
      const bridgeFetch = createBridgeFetch(host.port, {
        maxFrameBytes: 1000,
        onDroppedFrame: (reason) => drops.push(reason),
      });
      try {
        const call = bridgeFetch(`${BRIDGE_ORIGIN}/p/ping`);
        expect(await settledWithin(call, 500), name).toStartWith('rejected:');
        const error = await call.catch((refusal: unknown) => refusal);
        expect((error as { code?: string }).code, name).toBe(code);
        expect(classifyBridgeTransportRetry(error), name).toBe(false);
        expect(drops, name).toEqual([code ?? 'invalid-frame']);
      } finally {
        bridgeFetch.close();
      }
    }
  });

  test('a window instance long enough to hide its call from an oversized reply is refused', async () => {
    const big = (id: string) => ({
      ...unreadableReply(id),
      headers: [],
      body: 'x'.repeat(5000),
    });
    expect(() =>
      createBridgeFetch(fakeHost(big).port, { windowInstance: 'w'.repeat(600) }),
    ).toThrow('windowInstance');
    // The longest instance accepted, in the characters JSON escapes the most, still names its call.
    for (const windowInstance of ['w'.repeat(128), '\u0001'.repeat(128)]) {
      const host = fakeHost(big);
      const bridgeFetch = createBridgeFetch(host.port, {
        windowInstance,
        maxFrameBytes: 1000,
      });
      try {
        const call = bridgeFetch(`${BRIDGE_ORIGIN}/p/ping`);
        expect(await settledWithin(call, 500)).toStartWith('rejected:');
        expect(await call.catch((error: { code?: string }) => error.code)).toBe(
          'frame-too-large',
        );
      } finally {
        bridgeFetch.close();
      }
    }
  });

  test('an invoke reply that is no reply, answers another id or cannot be read is not replayed', async () => {
    const replies: Record<string, (id: string) => unknown> = {
      'not a reply': () => ({ v: 1, kind: 'hello', hostInstance: 'h' }),
      'another id': (id) => ({ ...unreadableReply(id), id: `${id}-other`, headers: [] }),
      unreadable: unreadableReply,
    };
    for (const [name, reply] of Object.entries(replies)) {
      let invocations = 0;
      const bridgeFetch = createBridgeFetch(async (frame) => {
        invocations += 1;
        const { id }: { id: string } = JSON.parse(frame);
        return JSON.stringify(reply(id));
      });
      const client = createClient(contract, {
        baseUrl: BRIDGE_ORIGIN,
        fetch: bridgeFetch,
        retry: { limit: 3 },
      });
      try {
        const outcome = await settledWithin(client.ping(), 1000);
        expect(outcome, name).toStartWith('rejected:');
        expect(invocations, name).toBe(1);
      } finally {
        bridgeFetch.close();
      }
    }
  });
});
