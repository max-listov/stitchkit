/**
 * Real Hermes V1 VM entrypoint for `stitchkit/handler` + `serveBridge` + `createBridgeFetch`.
 *
 * Unlike `handler-hermes-graph.mjs`, uses plain `setTimeout`-delivered message queues
 * instead of `MessageChannel` (which does not exist in React Native / Hermes).
 * Bundled as IIFE, transformed with async-generator + block-scoping plugins (matching
 * `@react-native/babel-preset` RN 0.88), compiled by `hermesc`, and executed in `hermes`.
 */
import { defineContract } from 'stitchkit/contract';
import * as handlerEntry from 'stitchkit/handler';
import * as httpEntry from 'stitchkit/http';
import { z } from 'zod';

const contract = defineContract(
  { prefix: 'host' },
  {
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Ping portable host in Hermes VM',
      output: z.object({ pong: z.boolean() }),
    },
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo UTF-8 payload in Hermes VM',
      input: z.object({ text: z.string() }),
      output: z.object({ echoed: z.string() }),
    },
  },
);

const origin = 'https://window.local';
const handler = handlerEntry.createHandler({
  services: [
    handlerEntry.implement(contract, {
      ping: () => ({ pong: true }),
      echo: (ctx) => ({ echoed: ctx.input.text }),
    }),
  ],
});

const hostListeners = new Set();
const clientListeners = new Set();
const deliver = (listeners, value) => {
  setTimeout(() => {
    for (const listener of listeners) listener(value);
  }, 0);
};

const bridge = handlerEntry.serveBridge(
  {
    postMessage: (frame) => deliver(clientListeners, frame),
    subscribe: (listener) => {
      hostListeners.add(listener);
      return () => hostListeners.delete(listener);
    },
  },
  handler,
  { origins: [origin] },
);

const bridgeFetch = httpEntry.createBridgeFetch({
  postMessage: (frame) => deliver(hostListeners, { data: frame, origin }),
  subscribe: (listener) => {
    clientListeners.add(listener);
    return () => clientListeners.delete(listener);
  },
});

// Keep barrel surfaces alive as Metro does so Hermes executes their module init.
globalThis.handlerSurface = Object.keys(handlerEntry);
globalThis.httpBridgeSurface = Object.keys(httpEntry);

async function runHermesVmProof() {
  try {
    // Prove the Hermes VM realm matches React Native 0.88 (none of these Node/CLI globals exist).
    for (const forbidden of [
      'Buffer',
      'DOMException',
      'MessageChannel',
      'ReadableStream',
      'setImmediate',
    ]) {
      if (typeof globalThis[forbidden] !== 'undefined') {
        throw new Error(`Unexpected global in Hermes RN 0.88 realm: ${forbidden}`);
      }
    }
    // Wait for the bridge's initial `hello` frame so the first call succeeds without retry.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const api = httpEntry.createClient(contract, {
      baseUrl: httpEntry.BRIDGE_ORIGIN,
      fetch: bridgeFetch,
      retry: { limit: 0 },
    });
    const pong = await api.ping();
    if (pong?.pong !== true) {
      throw new Error(`Unexpected ping response: ${JSON.stringify(pong)}`);
    }
    const echo = await api.echo({ text: 'Привет 🚀' });
    if (echo?.echoed !== 'Привет 🚀') {
      throw new Error(`Unexpected echo response: ${JSON.stringify(echo)}`);
    }
    if (globalThis.handlerSurface.length === 0 || globalThis.httpBridgeSurface.length === 0) {
      throw new Error('Barrel surfaces unexpectedly empty');
    }
    print('HERMES_VM_ROUNDTRIP_OK');
  } finally {
    bridgeFetch.close();
    bridge.close();
  }
}

runHermesVmProof().catch((error) => {
  // Re-throw inside a macrotask so the Hermes CLI exits non-zero with the failure.
  setTimeout(() => {
    throw error;
  }, 0);
});
