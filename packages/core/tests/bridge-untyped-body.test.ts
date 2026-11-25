/**
 * A body without `Content-Type` crosses the bridge only when its bytes are UTF-8.
 *
 * A Fetch body built from a string carries `text/plain`; one built from bytes, a
 * stream or an untyped `Blob` carries no type at all, so "no type" is exactly
 * where a binary body lives. Bridge v1 moves text only: an untyped body is
 * decoded strictly, and bytes that are not UTF-8 are refused with
 * `unsupported` instead of arriving as U+FFFD. Where the runtime cannot decode
 * strictly (React Native without `TextDecoder`), an untyped body is refused —
 * the bridge cannot show that it is text.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { type BridgeHostPort, createHandler, serveBridge } from '../src/entrypoints/handler';
import {
  BRIDGE_ORIGIN,
  type BridgeClientPort,
  BridgeFailureError,
  createBridgeFetch,
} from '../src/entrypoints/http';
import { bundleBrowserIife, CORE_SRC, createRnRealm } from './rn-realm/rn-realm';

const ORIGIN = 'https://window.app.local';
const NOT_UTF8 = [0xff, 0xfe, 0x00, 0x80];
const TEXT = 'Привет 🚀 </script>';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

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

describe('an untyped body over the bridge', () => {
  test('an untyped response is UTF-8 text or a refusal, never U+FFFD', async () => {
    let echoed: string | undefined;
    const handler = createHandler({
      rawRoutes: [
        {
          method: 'GET',
          path: '/bytes',
          handler: () => new Response(new Uint8Array(NOT_UTF8)),
        },
        {
          method: 'GET',
          path: '/text-bytes',
          handler: () => new Response(new TextEncoder().encode(TEXT)),
        },
        {
          method: 'POST',
          path: '/echo',
          handler: async (request) => {
            echoed = await request.text();
            return new Response(echoed, { headers: { 'content-type': 'text/plain' } });
          },
        },
      ],
    });
    const pair = channelPair();
    const host = serveBridge(pair.hostPort, handler, {
      origins: [ORIGIN],
      logger: silentLogger,
    });
    await flushPort();
    const bridgeFetch = createBridgeFetch(pair.clientPort);
    try {
      // The handler's bytes carry no type: Fetch adds none for a byte body.
      expect(new Response(new Uint8Array(NOT_UTF8)).headers.get('content-type')).toBeNull();

      const binary = await refusal(bridgeFetch(`${BRIDGE_ORIGIN}/bytes`));
      expect(binary).toBeInstanceOf(BridgeFailureError);
      expect((binary as BridgeFailureError).code).toBe('unsupported');

      const text = await bridgeFetch(`${BRIDGE_ORIGIN}/text-bytes`);
      expect(text.status).toBe(200);
      expect(await text.text()).toBe(TEXT);

      // The same rule for a request body the window sends without a type.
      const binaryRequest = await refusal(
        bridgeFetch(
          new Request(`${BRIDGE_ORIGIN}/echo`, {
            method: 'POST',
            body: new Uint8Array(NOT_UTF8),
          }),
        ),
      );
      expect(binaryRequest).toBeInstanceOf(BridgeFailureError);
      expect((binaryRequest as BridgeFailureError).code).toBe('unsupported');
      expect(echoed).toBeUndefined();

      const textRequest = await bridgeFetch(
        new Request(`${BRIDGE_ORIGIN}/echo`, {
          method: 'POST',
          body: new TextEncoder().encode(TEXT),
        }),
      );
      expect(await textRequest.text()).toBe(TEXT);
      expect(echoed).toBe(TEXT);
    } finally {
      bridgeFetch.close();
      host.close();
      pair.close();
    }
  });

  for (const withTextEncoding of [false, true]) {
    test(`a React Native host ${withTextEncoding ? 'with' : 'without'} TextDecoder answers the same way or refuses`, async () => {
      const handlerEntry = join(CORE_SRC, 'entrypoints/handler.ts');
      const bundle = await bundleBrowserIife(`
        import * as h from ${JSON.stringify(handlerEntry)};
        globalThis.__host = h;
      `);
      const realm = createRnRealm({ withTextEncoding });
      realm.evaluate(bundle, 'bridge-untyped-host.iife.js');
      const pair = channelPair();
      realm.context.__hostPort = pair.hostPort;
      realm.context.__origin = ORIGIN;
      realm.context.__notUtf8 = NOT_UTF8;
      // UTF-8 bytes of the sample, built outside the realm, which may lack TextEncoder.
      realm.context.__textBytes = [...new TextEncoder().encode(TEXT)];
      const closeHost = realm.evaluate<() => void>(`(() => {
        const { createHandler, serveBridge } = globalThis.__host;
        const bytes = (list) => new Uint8Array(list).buffer;
        const handler = createHandler({
          rawRoutes: [
            { method: 'GET', path: '/bytes', handler: () => new Response(bytes(globalThis.__notUtf8)) },
            { method: 'GET', path: '/text-bytes', handler: () => new Response(bytes(globalThis.__textBytes)) },
          ],
        });
        const handle = serveBridge(globalThis.__hostPort, handler, { origins: [globalThis.__origin] });
        return () => handle.close();
      })()`);
      await flushPort();
      const bridgeFetch = createBridgeFetch(pair.clientPort);
      try {
        const binary = await refusal(bridgeFetch(`${BRIDGE_ORIGIN}/bytes`));
        expect(binary).toBeInstanceOf(BridgeFailureError);
        expect((binary as BridgeFailureError).code).toBe('unsupported');

        const text = bridgeFetch(`${BRIDGE_ORIGIN}/text-bytes`);
        if (withTextEncoding) {
          expect(await (await text).text()).toBe(TEXT);
        } else {
          const refused = await refusal(text);
          expect(refused).toBeInstanceOf(BridgeFailureError);
          expect((refused as BridgeFailureError).code).toBe('unsupported');
        }
      } finally {
        bridgeFetch.close();
        closeHost();
        pair.close();
      }
    });
  }
});
