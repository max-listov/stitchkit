/**
 * A streaming endpoint is refused over the bridge, not buffered.
 *
 * Bridge v1 carries one response in one frame. A contract `stream` (SSE or
 * NDJSON) and a raw route answering a streaming type would be read on the host
 * until the stream ended or one frame filled, while the window saw nothing but
 * its own timeout. The host refuses such a response with `unsupported` as soon
 * as it sees its type, and cancels the stream it was handed.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  type BridgeHostPort,
  createHandler,
  implement,
  serveBridge,
} from '../src/entrypoints/handler';
import {
  BRIDGE_ORIGIN,
  type BridgeClientPort,
  BridgeFailureError,
  createBridgeFetch,
  createClient,
} from '../src/entrypoints/http';

const ORIGIN = 'https://window.app.local';

const flushPort = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

function channelPair(): {
  clientPort: BridgeClientPort;
  hostPort: BridgeHostPort;
  close: () => void;
} {
  const channel = new MessageChannel();
  const toHost = new Set<(message: { data: string; origin: string }) => void>();
  const toClient = new Set<(frame: string) => void>();
  channel.port1.onmessage = (event) => {
    for (const listener of toClient) listener(String(event.data));
  };
  channel.port2.onmessage = (event) => {
    for (const listener of toHost) listener({ data: String(event.data), origin: ORIGIN });
  };
  return {
    clientPort: {
      postMessage: (frame) => channel.port1.postMessage(frame),
      subscribe(listener) {
        toClient.add(listener);
        return () => toClient.delete(listener);
      },
    },
    hostPort: {
      postMessage: (frame) => channel.port2.postMessage(frame),
      subscribe(listener) {
        toHost.add(listener);
        return () => toHost.delete(listener);
      },
    },
    close() {
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/** The `BridgeFailureError` an error carries, at any depth of its cause chain. */
function bridgeFailureOf(error: unknown): BridgeFailureError | undefined {
  for (let at: unknown = error; at instanceof Error; at = at.cause) {
    if (at instanceof BridgeFailureError) return at;
  }
  return undefined;
}

const Item = z.object({ n: z.number() }).strict();

describe('a streaming endpoint over the bridge', () => {
  test('SSE and NDJSON contract streams and a streaming raw route are refused with unsupported', async () => {
    const produced = { sse: 0, ndjson: 0 };
    const endless = (format: keyof typeof produced) =>
      async function* ({ signal }: { signal: AbortSignal }) {
        for (let n = 0; !signal.aborted; n++) {
          produced[format] += 1;
          yield { n };
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      };
    const contract = defineContract(
      { prefix: 's' },
      {
        sse: {
          method: 'GET',
          path: '/sse',
          desc: 'SSE',
          stream: { item: Item, format: 'sse' },
        },
        ndjson: { method: 'GET', path: '/ndjson', desc: 'NDJSON', stream: { item: Item } },
        text: {
          method: 'GET',
          path: '/text',
          desc: 'Text',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    let rawCancelled = false;
    const handler = createHandler({
      services: [
        implement(contract, {
          sse: endless('sse'),
          ndjson: endless('ndjson'),
          text: () => ({ ok: true }),
        }),
      ],
      rawRoutes: [
        {
          method: 'GET',
          path: '/raw-events',
          handler: () =>
            new Response(
              new ReadableStream({
                pull: (controller) =>
                  controller.enqueue(new TextEncoder().encode('data: x\n\n')),
                cancel: () => {
                  rawCancelled = true;
                },
              }),
              { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
            ),
        },
      ],
    });
    const pair = channelPair();
    const host = serveBridge(pair.hostPort, handler, { origins: [ORIGIN] });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    const client = createClient(contract, {
      baseUrl: BRIDGE_ORIGIN,
      fetch: bridgeFetch,
      timeout: 1500,
    });
    try {
      for (const open of [() => client.sse(), () => client.ndjson()]) {
        const started = performance.now();
        const error = await open().then(
          () => undefined,
          (refusal: unknown) => refusal,
        );
        expect(bridgeFailureOf(error)?.code).toBe('unsupported');
        // Refused when the type is seen, long before the client's own timeout.
        expect(performance.now() - started).toBeLessThan(500);
      }
      const raw = await bridgeFetch(`${BRIDGE_ORIGIN}/raw-events`).then(
        () => undefined,
        (refusal: unknown) => refusal,
      );
      expect(bridgeFailureOf(raw)?.code).toBe('unsupported');
      await flushPort();
      expect(rawCancelled).toBe(true);
      // The host stopped reading each stream instead of buffering it.
      const settled = { ...produced };
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(produced).toEqual(settled);
      expect(produced.sse).toBeLessThan(10);
      expect(produced.ndjson).toBeLessThan(10);
      // An ordinary endpoint on the same bridge still answers.
      expect(await client.text()).toEqual({ ok: true });
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('a request body of a streaming type is refused before it is sent', async () => {
    let reached = false;
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'POST',
          path: '/ingest',
          handler: () => {
            reached = true;
            return new Response('ok', { headers: { 'content-type': 'text/plain' } });
          },
        },
      ],
    });
    const pair = channelPair();
    const host = serveBridge(pair.hostPort, handler, { origins: [ORIGIN] });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    try {
      for (const type of ['text/event-stream', 'application/x-ndjson']) {
        const error = await bridgeFetch(
          new Request(`${BRIDGE_ORIGIN}/ingest`, {
            method: 'POST',
            headers: { 'content-type': type },
            body: '{"n":1}\n',
          }),
        ).then(
          () => undefined,
          (refusal: unknown) => refusal,
        );
        expect(bridgeFailureOf(error)?.code, type).toBe('unsupported');
      }
      expect(reached).toBe(false);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });
});
