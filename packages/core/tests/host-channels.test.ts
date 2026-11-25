/**
 * Three host-RPC channels over ONE unchanged contract (the local-host slice):
 *   1. HTTP `127.0.0.1` + `createLocalHostGuard`
 *   2. `postMessage` bridge (`serveBridge` + `createBridgeFetch`)
 *   3. Direct in-process `fetch → createHandler`
 *
 * Proves the same contract and typed client pass identical functional,
 * trust-refusal, and mid-call restart/replay semantics across all three
 * channels without modifying the contract (item 12).
 */
import { describe, expect, test } from 'bun:test';
import { createConnection, createServer as createNetServer } from 'node:net';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import {
  type BridgeHostPort,
  createHandler,
  implement,
  serveBridge,
} from '../src/entrypoints/handler';
import {
  ApiError,
  BRIDGE_ORIGIN,
  type BridgeClientPort,
  type ClientFetch,
  createBridgeFetch,
  createClient,
} from '../src/entrypoints/http';
import { createLocalHostGuard, createServer } from '../src/entrypoints/server';

const Ok = z.object({ ok: z.literal(true) });
const Task = z.object({ id: z.string(), text: z.string(), done: z.boolean() });

const hostContract = defineContract(
  { prefix: 'host', scope: 'host' },
  {
    listTasks: { method: 'GET', path: '/tasks', desc: 'List tasks', output: z.array(Task) },
    setTaskDone: {
      method: 'POST',
      path: '/tasks/:id/done',
      desc: 'Mark a task done or not',
      params: z.object({ id: z.string().min(1) }),
      input: z.object({ done: z.boolean() }),
      idempotent: true,
      output: Ok,
    },
    copyTranscription: {
      method: 'POST',
      path: '/transcriptions/:id/copy',
      desc: 'Copy a transcription to the clipboard',
      params: z.object({ id: z.string().min(1) }),
      input: z.object({ locale: z.enum(['ru', 'en']) }),
      output: z.object({ copied: z.boolean() }),
    },
  },
);

function createHostApp() {
  const tasks = new Map([['t1', { id: 't1', text: 'ship it', done: false }]]);
  const handled = { listTasks: 0, setTaskDone: 0, copyTranscription: 0 };
  const service = implement(hostContract, {
    listTasks: () => {
      handled.listTasks += 1;
      return [...tasks.values()];
    },
    setTaskDone: ({ params, input }) => {
      handled.setTaskDone += 1;
      const task = tasks.get(params.id);
      if (task) task.done = input.done;
      return { ok: true as const };
    },
    copyTranscription: () => {
      handled.copyTranscription += 1;
      return { copied: true };
    },
  });
  return { tasks, handled, service };
}

interface ChannelHarness {
  readonly name: string;
  create(): Promise<{
    client: ReturnType<typeof createClient<typeof hostContract.endpoints>>;
    tasks: Map<string, { id: string; text: string; done: boolean }>;
    handled: { listTasks: number; setTaskDone: number; copyTranscription: number };
    assertUnauthorizedRefused(): Promise<void>;
    close(): Promise<void>;
  }>;
}

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

const channels: ChannelHarness[] = [
  {
    name: 'HTTP 127.0.0.1 + localHostGuard',
    async create() {
      const { tasks, handled, service } = createHostApp();
      const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const guard = createLocalHostGuard({ secret, origins: ['tauri://localhost'] });
      const server = createServer({
        port: 0,
        hostname: '127.0.0.1',
        services: [service],
        cors: guard.cors,
        hooks: { onRequest: (request) => guard.onRequest(request) },
      });
      const upstreamPort = server.port;

      // Drop the first TCP connection for each path to simulate a mid-call host restart.
      const dropped = new Set<string>();
      const proxy = createNetServer((socket) => {
        socket.once('data', (chunk) => {
          const path = chunk.toString('latin1').split(' ')[1] ?? '';
          if (!dropped.has(path)) {
            dropped.add(path);
            socket.destroy();
            return;
          }
          const target = createConnection({ host: '127.0.0.1', port: upstreamPort }, () => {
            target.write(chunk);
            socket.pipe(target).pipe(socket);
          });
          target.on('error', () => socket.destroy());
        });
        socket.on('error', () => undefined);
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const addr = proxy.address();
      if (!addr || typeof addr === 'string') throw new Error('Expected TCP proxy port');
      const frontUrl = `http://127.0.0.1:${addr.port}`;

      const client = createClient(hostContract, {
        baseUrl: frontUrl,
        headers: { authorization: `Bearer ${secret}`, connection: 'close' },
        retry: { limit: 2 },
      });

      return {
        client,
        tasks,
        handled,
        async assertUnauthorizedRefused() {
          const res = await fetch(new URL('/host/tasks', server.url));
          expect(res.status).toBe(401);
        },
        async close() {
          proxy.close();
          await server.shutdown({ gracePeriodMs: 0, forceTimeoutMs: 200 });
        },
      };
    },
  },
  {
    name: 'postMessage bridge (serveBridge + createBridgeFetch)',
    async create() {
      const { tasks, handled, service } = createHostApp();
      const secret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      const origin = 'https://webview.app.local';
      const handler = createHandler({ services: [service] });

      const channel = new MessageChannel();
      const hostListeners = new Set<(msg: { data: string; origin: string }) => void>();
      const clientListeners = new Set<(frame: string) => void>();
      const droppedPaths = new Set<string>();
      let bootCount = 1;

      channel.port1.onmessage = (event) => {
        for (const listener of clientListeners) listener(String(event.data));
      };
      channel.port2.onmessage = (event) => {
        const raw = String(event.data);
        const parsed = JSON.parse(raw) as { kind?: string; path?: string };
        if (parsed.kind === 'request' && parsed.path && !droppedPaths.has(parsed.path)) {
          // Simulate host restart mid-call: drop the first request for each path and emit a new `hello`.
          droppedPaths.add(parsed.path);
          bootCount += 1;
          channel.port2.postMessage(
            JSON.stringify({ v: 1, kind: 'hello', hostInstance: `bridge-boot-${bootCount}` }),
          );
          return;
        }
        for (const listener of hostListeners) listener({ data: raw, origin });
      };

      const clientPort: BridgeClientPort = {
        postMessage: (frame) => channel.port1.postMessage(frame),
        subscribe: (listener) => {
          clientListeners.add(listener);
          return () => clientListeners.delete(listener);
        },
      };
      const hostPort: BridgeHostPort = {
        postMessage: (frame) => channel.port2.postMessage(frame),
        subscribe: (listener) => {
          hostListeners.add(listener);
          return () => hostListeners.delete(listener);
        },
      };

      const bridgeFetch = createBridgeFetch(clientPort, { secret });
      const host = serveBridge(hostPort, handler, {
        origins: [origin],
        secret,
        hostInstance: 'bridge-boot-1',
        logger: silentLogger,
      });

      const client = createClient(hostContract, {
        baseUrl: BRIDGE_ORIGIN,
        fetch: bridgeFetch,
        retry: { limit: 2 },
      });

      return {
        client,
        tasks,
        handled,
        async assertUnauthorizedRefused() {
          const badFetch = createBridgeFetch(clientPort, { secret: 'invalid-secret-00000' });
          try {
            let refused = false;
            try {
              await badFetch(`${BRIDGE_ORIGIN}/host/tasks`);
            } catch {
              refused = true;
            }
            expect(refused).toBe(true);
          } finally {
            badFetch.close();
          }
        },
        async close() {
          bridgeFetch.close();
          host.close();
          channel.port1.close();
          channel.port2.close();
        },
      };
    },
  },
  {
    name: 'direct fetch -> createHandler',
    async create() {
      const { tasks, handled, service } = createHostApp();
      const handler = createHandler({ services: [service] });
      const droppedPaths = new Set<string>();
      const directFetch: ClientFetch = async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (!droppedPaths.has(url.pathname)) {
          droppedPaths.add(url.pathname);
          throw new TypeError('Simulated transport drop');
        }
        return handler(new Request(input, init));
      };

      const client = createClient(hostContract, {
        baseUrl: 'http://direct.invalid',
        fetch: directFetch,
        retry: { limit: 2 },
      });

      return {
        client,
        tasks,
        handled,
        async assertUnauthorizedRefused() {
          // Direct in-process fetch has no external untrusted boundary.
        },
        async close() {
          // No network resources to release.
        },
      };
    },
  },
];

describe('three host-RPC channels pass the same contract conformance suite', () => {
  for (const harness of channels) {
    test(harness.name, async () => {
      const instance = await harness.create();
      try {
        const listed = await instance.client.listTasks();
        const set = await instance.client.setTaskDone({ id: 't1', done: true });
        let copyError: unknown;
        try {
          await instance.client.copyTranscription({ id: 'r1', locale: 'en' });
        } catch (error) {
          copyError = error;
        }

        expect(listed).toEqual([{ id: 't1', text: 'ship it', done: false }]);
        expect(set).toEqual({ ok: true });
        expect(instance.tasks.get('t1')?.done).toBe(true);
        expect(ApiError.is(copyError)).toBe(true);
        // Non-idempotent POST must never be replayed after a transport drop/restart.
        expect(instance.handled.copyTranscription).toBe(0);
        expect(instance.handled.listTasks).toBe(1);
        expect(instance.handled.setTaskDone).toBe(1);

        await instance.assertUnauthorizedRefused();
      } finally {
        await instance.close();
      }
    });
  }
});
