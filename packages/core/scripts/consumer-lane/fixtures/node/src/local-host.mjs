/**
 * An app host as a consuming desktop app runs one, on the installed package.
 *
 * The consumer this proves ran its window ↔ host RPC as a hand-written
 * WebSocket protocol: a method map with `replay: 'safe' | 'never'`, a server
 * dispatcher, a client with its own reconnect and replay, about 980 lines of
 * transport around the methods. Here three of its methods — a read, a write
 * that is safe to repeat, a write that is not — are an ordinary contract served
 * on loopback behind the local-host guard, and the window is the typed client.
 * The host drops the first connection of every call, as a restarting host does:
 * the read and the safe write go again, the unsafe write does not.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createHttpClient } from 'stitchkit';
import { defineContract } from 'stitchkit/contract';
import {
  createHandler,
  createLocalHostGuard,
  createUnixClientTransport,
  implement,
  serveNode,
} from 'stitchkit/node';
import { z } from 'zod';
import { proof } from './packed-sqlite.mjs';

const Ok = z.object({ ok: z.literal(true) });
const Task = z.object({ id: z.string(), text: z.string(), done: z.boolean() });

// Was: 'tasks.list' { input: noParams, output: array(task), replay: 'safe' } plus a
// registerRpcMethod call and a client wrapper. Now one endpoint each.
const host = defineContract(
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

const tasks = new Map([['t1', { id: 't1', text: 'ship it', done: false }]]);
const handled = { listTasks: 0, setTaskDone: 0, copyTranscription: 0 };
const secret = crypto.randomUUID() + crypto.randomUUID();
const guard = createLocalHostGuard({ secret, origins: ['tauri://localhost'] });

const services = [
  implement(host, {
    listTasks: () => {
      handled.listTasks += 1;
      return [...tasks.values()];
    },
    setTaskDone: ({ params, input }) => {
      handled.setTaskDone += 1;
      const task = tasks.get(params.id);
      if (task) task.done = input.done;
      return { ok: true };
    },
    copyTranscription: () => {
      handled.copyTranscription += 1;
      return { copied: true };
    },
  }),
];

const server = await serveNode({
  port: 0,
  hostname: '127.0.0.1',
  services,
  cors: guard.cors,
  hooks: { onRequest: (request) => guard.onRequest(request) },
});
const upstream = Number(new URL(server.url).port);

// Second local channel over a unix socket sharing the same contract handlers,
// without the window Bearer guard (filesystem permissions are the credential).
const unixDir = mkdtempSync(join(tmpdir(), 'sk-lh-'));
const unixSocketPath = join(unixDir, 'app.sock');
const unixHandler = createHandler({ services });
const unixServer = createHttpServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const response = await unixHandler(
    new Request(`http://local-app${req.url ?? '/'}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    }),
  );
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise((resolve) => unixServer.listen(unixSocketPath, resolve));
const unixTransport = createUnixClientTransport({ socketPath: unixSocketPath });

// In front of the host: the first connection of each path is closed after the
// request arrived and before any answer — what a host that restarts mid-call does.
const dropped = new Set();
const restarting = createServer((socket) => {
  socket.once('data', (chunk) => {
    const path = chunk.toString('latin1').split(' ')[1] ?? '';
    if (!dropped.has(path)) {
      dropped.add(path);
      socket.destroy();
      return;
    }
    const target = createConnection({ host: '127.0.0.1', port: upstream }, () => {
      target.write(chunk);
      socket.pipe(target).pipe(socket);
    });
    target.on('error', () => socket.destroy());
  });
  socket.on('error', () => undefined);
});
await new Promise((resolve) => restarting.listen(0, '127.0.0.1', resolve));
const front = `http://127.0.0.1:${restarting.address().port}`;

try {
  const window = createClient(host, {
    baseUrl: front,
    // One connection per call, so the restarting front sees every call's first byte.
    headers: { authorization: `Bearer ${secret}`, connection: 'close' },
  });
  const listed = await window.listTasks();
  const set = await window.setTaskDone({ id: 't1', done: true });
  const copy = await window.copyTranscription({ id: 'r1', locale: 'en' }).then(
    () => 'answered',
    () => 'failed',
  );
  const stranger = await fetch(new URL('/host/tasks', server.url)).then(
    (response) => response.status,
  );
  const unixClient = createClient(
    host,
    createHttpClient({
      baseUrl: 'http://local-app',
      fetch: unixTransport.fetch,
      headers: { 'x-client-name': 'consumer-lane-node' },
    }),
  );
  const unixTasks = await unixClient.listTasks();
  proof(
    'local host',
    listed.length === 1 &&
      set.ok === true &&
      tasks.get('t1')?.done === true &&
      copy === 'failed' &&
      handled.copyTranscription === 0 &&
      stranger === 401 &&
      unixTasks.length === 1 &&
      unixTasks[0]?.done === true,
    JSON.stringify({ listed, set, copy, handled, stranger, unixTasks }),
  );
} finally {
  await unixTransport.close();
  await new Promise((resolve) => unixServer.close(resolve));
  rmSync(unixDir, { recursive: true, force: true });
  restarting.close();
  await server.shutdown({ gracePeriodMs: 0, forceTimeoutMs: 200 });
}
