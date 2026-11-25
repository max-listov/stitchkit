import { defineContract } from 'stitchkit/contract';
import * as handlerEntry from 'stitchkit/handler';
import * as httpEntry from 'stitchkit/http';
import { z } from 'zod';

export const contract = defineContract(
  { prefix: 'host' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Ping portable host',
      output: z.object({ pong: z.boolean() }),
    },
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo message',
      input: z.object({ text: z.string() }),
      output: z.object({ echoed: z.string() }),
    },
  },
);

export function createHostAndClient(origin = 'https://window.local') {
  const handler = handlerEntry.createHandler({
    services: [
      handlerEntry.implement(contract, {
        ping: () => ({ pong: true }),
        echo: (ctx) => ({ echoed: ctx.input.text }),
      }),
    ],
  });

  const channel = new MessageChannel();
  const hostListeners = new Set();
  const clientListeners = new Set();
  channel.port1.onmessage = (event) => {
    for (const listener of clientListeners) listener(event.data);
  };
  channel.port2.onmessage = (event) => {
    for (const listener of hostListeners) listener({ data: event.data, origin });
  };

  const bridge = handlerEntry.serveBridge(
    {
      postMessage: (frame) => channel.port2.postMessage(frame),
      subscribe: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    },
    handler,
    { origins: [origin] },
  );

  const bridgeFetch = httpEntry.createBridgeFetch({
    postMessage: (frame) => channel.port1.postMessage(frame),
    subscribe: (listener) => {
      clientListeners.add(listener);
      return () => clientListeners.delete(listener);
    },
  });

  const client = httpEntry.createClient(contract, {
    baseUrl: httpEntry.BRIDGE_ORIGIN,
    fetch: bridgeFetch,
  });

  return {
    client,
    close() {
      bridgeFetch.close();
      bridge.close();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

// Metro retains barrel exports; keep the full stitchkit/handler surface in the Hermes compiler proof.
globalThis.handlerSurface = Object.keys(handlerEntry);
globalThis.httpBridgeSurface = Object.keys(httpEntry);
