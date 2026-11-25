/**
 * A body with a text type crosses the bridge only when its bytes are UTF-8.
 *
 * Bridge v1 carries a body as a UTF-8 string. A type that says text — a
 * `charset` other than UTF-8 included — does not make other bytes UTF-8: read
 * leniently they arrive as U+FFFD under a header that still names the original
 * charset. Wherever the runtime shows the bytes, they are decoded strictly and
 * refused with `unsupported` when they are not UTF-8, on the host for a response
 * and in the window for a request. UTF-8 bytes under any text type pass intact.
 */
import { describe, expect, test } from 'bun:test';
import { type BridgeHostPort, createHandler, serveBridge } from '../src/entrypoints/handler';
import {
  BRIDGE_ORIGIN,
  type BridgeClientPort,
  BridgeFailureError,
  createBridgeFetch,
} from '../src/entrypoints/http';

const ORIGIN = 'https://window.app.local';
const PRIVET_CP1251 = [0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2];
const JSON_WITH_FF = [0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d];
const TEXT = 'Привет 🚀 </script>';

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

async function refusal(call: Promise<Response>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  return undefined;
}

const RESPONSES: Record<string, { bytes: number[]; type: string }> = {
  '/cp1251': { bytes: PRIVET_CP1251, type: 'text/plain; charset=windows-1251' },
  '/json-ff': { bytes: JSON_WITH_FF, type: 'application/json' },
  '/utf8-under-latin1': {
    bytes: [...new TextEncoder().encode(TEXT)],
    type: 'text/plain; charset=iso-8859-1',
  },
  '/utf8-json': {
    bytes: [...new TextEncoder().encode(JSON.stringify({ text: TEXT }))],
    type: 'application/json',
  },
};

const BOM_CSV = [0xef, 0xbb, 0xbf, 0x61, 0x2c, 0x62];

describe('a typed text body over the bridge', () => {
  test('a byte order mark reaches the window as the handler wrote it', async () => {
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/bom',
          handler: () =>
            new Response(new Uint8Array(BOM_CSV), { headers: { 'content-type': 'text/csv' } }),
        },
      ],
    });
    const pair = channelPair();
    const host = serveBridge(pair.hostPort, handler, { origins: [ORIGIN] });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    try {
      const response = await bridgeFetch(`${BRIDGE_ORIGIN}/bom`);
      expect([...new Uint8Array(await response.arrayBuffer())]).toEqual(BOM_CSV);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('a string body sent through init follows the type rule a Request follows', async () => {
    let reached = 0;
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'POST',
          path: '/in',
          handler: () => {
            reached += 1;
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
      for (const type of [
        'application/octet-stream',
        'application/x-ndjson',
        'TEXT/EVENT-STREAM',
      ]) {
        const init = { method: 'POST', headers: { 'Content-Type': type }, body: '{"n":1}\n' };
        const viaInit = await refusal(bridgeFetch(`${BRIDGE_ORIGIN}/in`, init));
        const viaRequest = await refusal(
          bridgeFetch(new Request(`${BRIDGE_ORIGIN}/in`, init)),
        );
        for (const refused of [viaInit, viaRequest]) {
          expect(refused, type).toBeInstanceOf(BridgeFailureError);
          expect((refused as BridgeFailureError).code, type).toBe('unsupported');
        }
        expect((viaInit as Error).message, type).toBe((viaRequest as Error).message);
      }
      expect(reached).toBe(0);
      // A textual type still travels from init.
      await bridgeFetch(`${BRIDGE_ORIGIN}/in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"n":1}',
      });
      expect(reached).toBe(1);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  test('bytes that are not UTF-8 are refused, UTF-8 bytes pass intact under any text type', async () => {
    let echoed: string | undefined;
    const handler = createHandler({
      rawRoutes: [
        ...Object.entries(RESPONSES).map(([path, { bytes, type }]) => ({
          method: 'GET' as const,
          path,
          handler: () =>
            new Response(new Uint8Array(bytes), { headers: { 'content-type': type } }),
        })),
        {
          method: 'POST',
          path: '/echo',
          handler: async (request: Request) => {
            echoed = await request.text();
            return new Response(echoed, { headers: { 'content-type': 'text/plain' } });
          },
        },
      ],
    });
    const pair = channelPair();
    const host = serveBridge(pair.hostPort, handler, { origins: [ORIGIN] });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    try {
      for (const path of ['/cp1251', '/json-ff']) {
        const refused = await refusal(bridgeFetch(`${BRIDGE_ORIGIN}${path}`));
        expect(refused, path).toBeInstanceOf(BridgeFailureError);
        expect((refused as BridgeFailureError).code, path).toBe('unsupported');
      }

      // The same bytes reach the window as were sent: re-encoding the string gives them back.
      const latin1 = await bridgeFetch(`${BRIDGE_ORIGIN}/utf8-under-latin1`);
      expect(latin1.headers.get('content-type')).toBe('text/plain; charset=iso-8859-1');
      expect([...new Uint8Array(await latin1.arrayBuffer())]).toEqual(
        RESPONSES['/utf8-under-latin1']?.bytes ?? [],
      );
      const json = await bridgeFetch(`${BRIDGE_ORIGIN}/utf8-json`);
      expect(await json.json()).toEqual({ text: TEXT });

      // A request the window sends with a text type follows the same rule.
      const request = (bytes: number[]) =>
        new Request(`${BRIDGE_ORIGIN}/echo`, {
          method: 'POST',
          headers: { 'content-type': 'text/plain; charset=windows-1251' },
          body: new Uint8Array(bytes),
        });
      const refusedRequest = await refusal(bridgeFetch(request(PRIVET_CP1251)));
      expect(refusedRequest).toBeInstanceOf(BridgeFailureError);
      expect((refusedRequest as BridgeFailureError).code).toBe('unsupported');
      expect(echoed).toBeUndefined();
      const sent = await bridgeFetch(request([...new TextEncoder().encode(TEXT)]));
      expect(await sent.text()).toBe(TEXT);
      expect(echoed).toBe(TEXT);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });
});
