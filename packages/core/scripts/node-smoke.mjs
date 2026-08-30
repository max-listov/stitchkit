/**
 * Node-runtime smoke test — run under `node` (NOT bun), against the built `dist/`.
 *
 * The bun test-suite runs on Bun, so it cannot catch a Bun-only dependency that
 * leaks into a supposedly runtime-agnostic entrypoint (a top-level
 * `@socket.io/bun-engine` import once crashed the whole `stitchkit/server`
 * barrel on Node). This smoke:
 *   1. imports every server-side entrypoint — INCLUDING `stitchkit/server` — so a
 *      Bun-only eager import is caught at load;
 *   2. drives a real `serveNode` HTTP round-trip (srvx adapter);
 *   3. drives a Socket.IO round-trip over WebSocket (io.attach to the node server).
 *
 * Resolves `stitchkit/*` via the package's own `exports` map (Node self-reference).
 */
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 1 — every server-side entrypoint must IMPORT cleanly under Node.
const entrypoints = [
  'stitchkit',
  'stitchkit/contract',
  'stitchkit/server',
  'stitchkit/tools',
  'stitchkit/remote',
  'stitchkit/node',
  'stitchkit/observability',
  'stitchkit/application',
  'stitchkit/application/grammy',
  'stitchkit/application/opentelemetry',
  'stitchkit/agent-runtime',
  'stitchkit/agent-runtime/harness',
  'stitchkit/agent-runtime/coding-tools',
  'stitchkit/agent-runtime/openrouter',
  'stitchkit/agent-runtime/sqlite/node',
  'stitchkit/testing',
  'stitchkit/files',
];
for (const name of entrypoints) {
  await import(name);
  console.log(`import ${name}: OK`);
}

const { createHttpClient, defineContract, defineRealtimeContract } = await import('stitchkit');
const {
  bindRealtimeServer,
  createHandler,
  createSocketIOServer,
  createUnixClientTransport,
  implement,
  serveNode,
} = await import('stitchkit/node');
const { createHandlerTestClient } = await import('stitchkit/testing');
const { createManagedFileBoundary } = await import('stitchkit/files');
const { createObservability } = await import('stitchkit/observability');
const { createMemoryAgentRuntimeStore } = await import('stitchkit/agent-runtime');
const { createNodeSqliteAgentRuntimeStore } = await import(
  'stitchkit/agent-runtime/sqlite/node'
);
const { z } = await import('zod');

const agentStore = createMemoryAgentRuntimeStore();
const emptyAgentSnapshot = await agentStore.loadSnapshot('node-smoke');
assert.equal(emptyAgentSnapshot.version, 0);

const sqliteRoot = await mkdtemp(join(tmpdir(), 'stitchkit-node-sqlite-'));
try {
  const sqlite = createNodeSqliteAgentRuntimeStore({
    filename: join(sqliteRoot, 'agent-runtime.sqlite'),
  });
  assert.equal((await sqlite.store.loadSnapshot('node-smoke')).version, 0);
  await sqlite.close();
} finally {
  await rm(sqliteRoot, { recursive: true, force: true });
}

const fileRoot = await mkdtemp(join(tmpdir(), 'stitchkit-node-files-'));
try {
  const ownedRoot = join(fileRoot, 'owned');
  await assert.rejects(createManagedFileBoundary({ root: ownedRoot }), {
    code: 'FILE_NOT_FOUND',
  });
  const files = await createManagedFileBoundary({
    root: ownedRoot,
    createRoot: true,
    maxReadBytes: 3,
    inspectionBytes: 2,
    inspect: ({ prefix, name, signal }) => {
      assert.equal(prefix.byteLength <= 2, true);
      assert.equal(signal instanceof AbortSignal, true);
      if (name === 'mutable.bin') prefix[0] = 99;
      return name === 'existing.bin'
        ? { mediaType: 'application/smoke', name: 'inspected.bin' }
        : {};
    },
  });
  assert.deepEqual(await files.write('one.bin', new Uint8Array([1, 2, 3])), {
    path: 'one.bin',
    size: 3,
  });
  await assert.rejects(files.write('one.bin', new Uint8Array([9])), {
    code: 'FILE_EXISTS',
  });
  assert.deepEqual(
    new Uint8Array(await readFile(join(ownedRoot, 'one.bin'))),
    new Uint8Array([1, 2, 3]),
  );
  await files.write('one.bin', new Uint8Array([4, 5]), { replace: true, durable: true });
  assert.deepEqual((await files.read('one.bin')).bytes, new Uint8Array([4, 5]));
  await writeFile(join(ownedRoot, 'existing.bin'), new Uint8Array([8, 9]));
  assert.deepEqual((await files.read('existing.bin')).ref, {
    path: 'existing.bin',
    size: 2,
    mediaType: 'application/smoke',
    name: 'inspected.bin',
  });
  await writeFile(join(ownedRoot, 'large.bin'), new Uint8Array([1, 2, 3, 4]));
  await assert.rejects(files.read('large.bin'), { code: 'FILE_TOO_LARGE' });
  await writeFile(join(ownedRoot, 'mutable.bin'), new Uint8Array([7, 8]));
  assert.deepEqual((await files.read('mutable.bin')).bytes, new Uint8Array([7, 8]));
  await writeFile(join(fileRoot, 'secret.bin'), new Uint8Array([9]));
  await symlink(join(fileRoot, 'secret.bin'), join(ownedRoot, 'outside.bin'));
  await assert.rejects(files.read('outside.bin'), { code: 'FILE_OUTSIDE_ROOT' });
  await assert.rejects(files.read('../secret.bin'), { code: 'FILE_INVALID_PATH' });
  const aborted = new AbortController();
  aborted.abort(new Error('node smoke abort'));
  await assert.rejects(
    files.write('aborted.bin', new Uint8Array([1]), { signal: aborted.signal }),
    /node smoke abort/,
  );
  console.log('managed file boundary parity: OK');
} finally {
  await rm(fileRoot, { recursive: true, force: true });
}

// 2 — serveNode HTTP round-trip.
const contract = defineContract(
  { prefix: 'smoke' },
  {
    ping: {
      method: 'GET',
      path: '/',
      desc: 'ping',
      output: z.object({ ok: z.boolean() }),
      responseMeta: { status: 201 },
    },
  },
);
const service = implement(contract, {
  ping: ({ response }) => {
    response.headers.append('Set-Cookie', 'smoke=one; Path=/');
    response.headers.append('Set-Cookie', 'smoke=two; Path=/');
    return { ok: true };
  },
});

const inProcessHandler = createHandler({
  groups: [{ pathPrefix: '/api', services: [service] }],
});
const inProcessApi = createHandlerTestClient({
  contract,
  handler: inProcessHandler,
  pathPrefix: 'api',
});
assert.deepEqual(
  await inProcessApi.ping(),
  { ok: true },
  'testing entrypoint should drive the generated client through a Fetch handler on Node',
);
console.log('in-process generated-client round-trip: OK');

// Port 0 — the kernel picks a free one and the handle reports it back. A fixed
// number is a scheduled flake: an ephemeral range that starts at 1024 lets any
// outgoing connection on the machine hold it.
const http = await serveNode({
  groups: [{ pathPrefix: '/api', services: [service] }],
  port: 0,
});
const res = await fetch(`${http.url}/api/smoke`);
assert.equal(res.status, 201, 'serveNode HTTP should return the declared success status');
assert.deepEqual(
  res.headers.getSetCookie(),
  ['smoke=one; Path=/', 'smoke=two; Path=/'],
  'serveNode HTTP should preserve repeated Set-Cookie fields',
);
assert.deepEqual(
  await res.json(),
  { ok: true },
  'serveNode HTTP should return the typed body',
);
console.log('serveNode HTTP round-trip: OK');
await http.shutdown({ gracePeriodMs: 0 });

// A physical peer close is a neutral transport cancellation, not an
// application failure. Drive the real srvx bridge with node:net so this cannot
// pass through an in-process Fetch Request whose signal the test owns itself.
let resolveDisconnectAdmitted;
const disconnectAdmitted = new Promise((resolve) => {
  resolveDisconnectAdmitted = resolve;
});
let resolveDisconnectAborted;
const disconnectAborted = new Promise((resolve) => {
  resolveDisconnectAborted = resolve;
});
let resolveDisconnectCompleted;
const disconnectCompleted = new Promise((resolve) => {
  resolveDisconnectCompleted = resolve;
});
const disconnectEvents = [];
const disconnectObservability = createObservability({
  request: {
    includeCancelled: true,
    write: (event) => disconnectEvents.push(event),
  },
});
let disconnectOnErrorCalls = 0;
const disconnectServer = await serveNode({
  port: 0,
  rawRoutes: [
    {
      method: 'GET',
      path: '/disconnect',
      handler(req) {
        resolveDisconnectAdmitted();
        return new Promise((_resolve, reject) => {
          const abort = () => {
            resolveDisconnectAborted();
            reject(
              req.signal.reason ?? new DOMException('The connection was closed', 'AbortError'),
            );
          };
          if (req.signal.aborted) abort();
          else req.signal.addEventListener('abort', abort, { once: true });
        });
      },
    },
  ],
  hooks: {
    onError: () => {
      disconnectOnErrorCalls += 1;
      return undefined;
    },
  },
  logging: {
    logger: {
      debug: () => undefined,
      info: (_message, fields) => {
        if (fields?.status === 499) resolveDisconnectCompleted();
      },
      warn: () => undefined,
      error: () => undefined,
    },
  },
  observability: disconnectObservability.request,
});
const disconnectClient = createConnection({
  host: '127.0.0.1',
  port: disconnectServer.port,
});
disconnectClient.on('error', () => undefined);
await new Promise((resolve) => disconnectClient.once('connect', resolve));
disconnectClient.write(
  'GET /disconnect HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
);
await disconnectAdmitted;
disconnectClient.destroy();
let disconnectTimer;
try {
  await Promise.race([
    Promise.all([disconnectAborted, disconnectCompleted]),
    new Promise((_resolve, reject) => {
      disconnectTimer = setTimeout(
        () => reject(new Error('Node physical disconnect did not reach Request.signal')),
        5_000,
      );
    }),
  ]);
} finally {
  clearTimeout(disconnectTimer);
}
await disconnectObservability.flush();
assert.equal(disconnectOnErrorCalls, 0);
assert.equal(disconnectEvents.length, 1);
assert.equal(disconnectEvents[0].outcome, 'cancelled');
assert.equal(disconnectEvents[0].statusCode, 499);
assert.equal(disconnectEvents[0].errorCode, undefined);
assert.equal((await disconnectServer.shutdown({ gracePeriodMs: 1_000 })).outcome, 'clean');
await disconnectObservability.close();
console.log('serveNode physical client disconnect cancellation: OK');

// 3 — Node's native fetch classification remains intact when Stitchkit adds
// its narrow Bun adapter. The backend starts only after the first native fetch
// has rejected, so success proves a real second transport attempt.
const { createServer: createNativeNodeServer } = await import('node:http');

// The installed Node entrypoint must select the Unix listener structurally,
// keep redirects on it and pause a fast producer when the body reader stalls.
const unixSmokeRoot = await mkdtemp(join(tmpdir(), 'stitchkit-node-unix-'));
const unixSmokePath = join(unixSmokeRoot, 'daemon.sock');
let unixTcpRequests = 0;
let unixFastWrites = 0;
const unixTcpSentinel = createNativeNodeServer((_request, response) => {
  unixTcpRequests += 1;
  response.end('wrong transport');
});
await new Promise((resolve, reject) => {
  unixTcpSentinel.once('error', reject);
  unixTcpSentinel.listen(0, '127.0.0.1', resolve);
});
const unixTcpAddress = unixTcpSentinel.address();
assert.equal(typeof unixTcpAddress, 'object');
assert.notEqual(unixTcpAddress, null);
const unixResponder = createNativeNodeServer(async (request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, {
      location: `http://127.0.0.1:${unixTcpAddress.port}/final`,
    });
    response.end();
    return;
  }
  if (request.url === '/fast') {
    try {
      for (let index = 0; index < 512; index += 1) {
        if (!response.write(Buffer.alloc(32 * 1024))) {
          await new Promise((resolve) => response.once('drain', resolve));
        }
        unixFastWrites += 1;
      }
      response.end();
    } catch {
      // The stalled-reader proof cancels this response deliberately.
    }
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ transport: 'unix' }));
});
await new Promise((resolve, reject) => {
  unixResponder.once('error', reject);
  unixResponder.listen(unixSmokePath, resolve);
});
const unixTransport = createUnixClientTransport({ socketPath: unixSmokePath });
const unixRedirected = await unixTransport.fetch(
  `http://127.0.0.1:${unixTcpAddress.port}/redirect`,
);
assert.deepEqual(await unixRedirected.json(), { transport: 'unix' });
assert.equal(unixTcpRequests, 0);
const unixFast = await unixTransport.fetch('http://local/fast');
const unixFastReader = unixFast.body.getReader();
await unixFastReader.read();
await new Promise((resolve) => setTimeout(resolve, 200));
assert.ok(unixFastWrites < 512, 'Node Unix response must stop a stalled fast producer');
await unixFastReader.cancel();
await unixTransport.close();
const missingUnix = createUnixClientTransport({
  socketPath: join(unixSmokeRoot, 'missing.sock'),
});
await assert.rejects(missingUnix.fetch('http://local/missing'), {
  code: 'UNIX_CONNECT_FAILED',
  delivery: 'not-dispatched',
});
await missingUnix.close();
unixResponder.closeAllConnections();
unixTcpSentinel.closeAllConnections();
await Promise.all([
  new Promise((resolve, reject) =>
    unixResponder.close((error) => (error ? reject(error) : resolve())),
  ),
  new Promise((resolve, reject) =>
    unixTcpSentinel.close((error) => (error ? reject(error) : resolve())),
  ),
]);
await rm(unixSmokeRoot, { recursive: true, force: true });
console.log('portable bounded Unix client on Node: OK');

const reservation = createNativeNodeServer((_request, response) => response.end());
await new Promise((resolve, reject) => {
  reservation.once('error', reject);
  reservation.listen(0, '127.0.0.1', resolve);
});
const reservedAddress = reservation.address();
assert.notEqual(reservedAddress, null, 'port reservation should expose an address');
assert.equal(typeof reservedAddress, 'object', 'port reservation should expose a TCP address');
const retryPort = reservedAddress.port;
await new Promise((resolve, reject) =>
  reservation.close((error) => (error ? reject(error) : resolve())),
);

const nativeFetch = globalThis.fetch;
let nativeAttempts = 0;
const retrySignals = [];
let resolveFirstFailure = () => undefined;
const firstFailure = new Promise((resolve) => {
  resolveFirstFailure = resolve;
});
let resolveServerListening = () => undefined;
let rejectServerListening = () => undefined;
const serverListening = new Promise((resolve, reject) => {
  resolveServerListening = resolve;
  rejectServerListening = reject;
});
globalThis.fetch = async (input, init) => {
  nativeAttempts += 1;
  retrySignals.push(init?.signal instanceof AbortSignal);
  try {
    return await nativeFetch(input, init);
  } catch (error) {
    if (nativeAttempts === 1) {
      resolveFirstFailure(error);
      await serverListening;
    }
    throw error;
  }
};

let lateServer;
try {
  const retryClient = createHttpClient({ baseUrl: `http://127.0.0.1:${retryPort}` });
  const pendingRetry = retryClient.get('/retry');
  void pendingRetry.catch(() => undefined);
  let failureTimer;
  try {
    await Promise.race([
      firstFailure,
      new Promise((_resolve, reject) => {
        failureTimer = setTimeout(
          () => reject(new Error('first Node fetch did not fail')),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(failureTimer);
  }
  lateServer = createNativeNodeServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  });
  try {
    await new Promise((resolve, reject) => {
      lateServer.once('error', reject);
      lateServer.listen(retryPort, '127.0.0.1', resolve);
    });
    resolveServerListening();
  } catch (error) {
    rejectServerListening(error);
    throw error;
  }
  let retryTimer;
  let retryResult;
  try {
    retryResult = await Promise.race([
      pendingRetry,
      new Promise((_resolve, reject) => {
        retryTimer = setTimeout(
          () => reject(new Error('Node network retry did not complete')),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(retryTimer);
  }
  assert.deepEqual(retryResult, { ok: true });
  assert.equal(nativeAttempts, 2, 'Node retry should perform exactly two native fetches');
  assert.deepEqual(
    retrySignals,
    [false, true],
    'only the Node retry should expose its current Request signal in fetch init',
  );
  console.log('Node network retry round-trip: OK');
} finally {
  globalThis.fetch = nativeFetch;
  if (lateServer) {
    await new Promise((resolve, reject) =>
      lateServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

// An opt-in body-method retry must preserve the stream body and Undici's
// `duplex: "half"` requirement when the adapter materializes URL + init.
let bodyAttempts = 0;
const bodyServer = createNativeNodeServer(async (request, response) => {
  bodyAttempts += 1;
  let body = '';
  for await (const chunk of request) body += chunk;
  if (bodyAttempts === 1) {
    response.writeHead(503);
    response.end('retry');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ body }));
});
await new Promise((resolve, reject) => {
  bodyServer.once('error', reject);
  bodyServer.listen(0, '127.0.0.1', resolve);
});
const bodyAddress = bodyServer.address();
assert.notEqual(bodyAddress, null);
assert.equal(typeof bodyAddress, 'object');
try {
  const bodyClient = createHttpClient({
    baseUrl: `http://127.0.0.1:${bodyAddress.port}`,
    retry: { limit: 1, methods: ['put'], statusCodes: [503] },
  });
  assert.deepEqual(await bodyClient.put('/body', { value: 'preserved' }), {
    body: '{"value":"preserved"}',
  });
  assert.equal(bodyAttempts, 2);
  console.log('Node body-method retry round-trip: OK');
} finally {
  await new Promise((resolve, reject) =>
    bodyServer.close((error) => (error ? reject(error) : resolve())),
  );
}

// A clean result waits for ServerResponse.finish, not merely for the handler to
// return its streaming Response.
let resolveStreamStarted;
const streamStarted = new Promise((resolve) => {
  resolveStreamStarted = resolve;
});
let releaseStream;
const streamRelease = new Promise((resolve) => {
  releaseStream = resolve;
});
const streamingServer = await serveNode({
  port: 0,
  rawRoutes: [
    {
      method: 'GET',
      path: '/stream',
      handler: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('started'));
              resolveStreamStarted();
              void streamRelease.then(() => controller.close());
            },
          }),
        ),
    },
  ],
});
const streamingResponse = await fetch(`${streamingServer.url}/stream`);
await streamStarted;
const streamingShutdown = streamingServer.shutdown({ gracePeriodMs: 1_000 });
assert.equal(streamingServer.status.pendingRequests, 1);
releaseStream();
assert.equal(await streamingResponse.text(), 'started');
const streamingResult = await streamingShutdown;
assert.equal(streamingResult.outcome, 'clean');
assert.equal(streamingResult.pendingRequests, 0);
console.log('serveNode streaming response physical clean finish: OK');

// 4 — serveNode + Socket.IO round-trip (WebSocket).
const { io: ioClient } = await import('socket.io-client');
const socket = await createSocketIOServer({ cors: { origin: '*' } });
const realtimeContract = defineRealtimeContract({
  serverToClient: { pong: { args: z.tuple([z.number()]) } },
  clientToServer: {
    ping: {
      args: z.tuple([z.number()]),
      ack: z.object({ accepted: z.boolean() }),
    },
  },
});
bindRealtimeServer(realtimeContract, socket).onConnection(({ events }) => {
  events.on('ping', (n, acknowledge) => {
    acknowledge({ accepted: true });
    events.emit('pong', n + 1);
  });
});
const realtime = await serveNode({ socket, port: 0 });

const client = ioClient(realtime.url, { transports: ['websocket'] });
const roundTrip = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('socket round-trip timed out')), 8000);
  let acknowledgement;
  let pong;
  const finish = () => {
    if (!acknowledgement || pong === undefined) return;
    clearTimeout(timer);
    resolve({ acknowledgement, pong });
  };
  client.on('connect', () =>
    client.emit('ping', 41, (value) => {
      acknowledgement = value;
      finish();
    }),
  );
  client.on('pong', (n) => {
    pong = n;
    finish();
  });
  client.on('connect_error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
});
assert.deepEqual(
  roundTrip,
  { acknowledgement: { accepted: true }, pong: 42 },
  'Socket.IO round-trip should validate its acknowledgement and pong 42',
);
console.log('serveNode Socket.IO acknowledgement round-trip: OK');
const cleanDisconnect = new Promise((resolve) => client.once('disconnect', resolve));
const cleanRealtimeResult = await realtime.shutdown({ gracePeriodMs: 1_000 });
await cleanDisconnect;
assert.equal(cleanRealtimeResult.outcome, 'clean');
assert.equal(cleanRealtimeResult.pendingWebSockets, 0);
console.log('serveNode Socket.IO physical clean close: OK');

// The forced path snapshots and destroys an upgraded socket before resolving.
const forcedSocket = await createSocketIOServer({
  cors: { origin: '*' },
  transports: ['websocket'],
});
const forcedRealtime = await serveNode({ socket: forcedSocket, port: 0 });
const forcedClient = ioClient(forcedRealtime.url, {
  transports: ['websocket'],
  reconnection: false,
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('forced socket connect timed out')), 5_000);
  forcedClient.once('connect', () => {
    clearTimeout(timer);
    resolve();
  });
  forcedClient.once('connect_error', reject);
});
assert.equal(forcedRealtime.status.pendingWebSockets, 1);
const forcedDisconnect = new Promise((resolve) => forcedClient.once('disconnect', resolve));
const forceController = new AbortController();
forceController.abort();
const forcedRealtimeResult = await forcedRealtime.shutdown({
  gracePeriodMs: 10_000,
  signal: forceController.signal,
});
await forcedDisconnect;
assert.equal(forcedRealtimeResult.outcome, 'forced');
assert.equal(forcedRealtimeResult.pendingWebSocketsAtForce, 1);
assert.equal(forcedRealtimeResult.forcedWebSockets, 1);
assert.equal(forcedRealtimeResult.pendingWebSockets, 0);
console.log('serveNode Socket.IO physical forced close: OK');

// A handshake after the shutdown boundary is rejected by the transport policy
// and never enters application admission/accounting.
let resolveHeldRequest;
const heldRequestStarted = new Promise((resolve) => {
  resolveHeldRequest = resolve;
});
let releaseHeldRequest;
const heldRequestRelease = new Promise((resolve) => {
  releaseHeldRequest = resolve;
});
let shutdownPolicyCalls = 0;
const boundarySocket = await createSocketIOServer({
  cors: { origin: '*' },
  transports: ['websocket'],
  allowRequest: () => {
    shutdownPolicyCalls += 1;
    return true;
  },
});
const boundaryServer = await serveNode({
  socket: boundarySocket,
  port: 0,
  rawRoutes: [
    {
      method: 'GET',
      path: '/hold',
      async handler() {
        resolveHeldRequest();
        await heldRequestRelease;
        return new Response('done');
      },
    },
  ],
});
const heldRequest = fetch(`${boundaryServer.url}/hold`);
await heldRequestStarted;
const boundaryShutdown = boundaryServer.shutdown({ gracePeriodMs: 1_000 });
const rejectedClient = ioClient(boundaryServer.url, {
  transports: ['websocket'],
  reconnection: false,
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(
    () => reject(new Error('post-boundary handshake timed out')),
    5_000,
  );
  rejectedClient.once('connect_error', () => {
    clearTimeout(timer);
    resolve();
  });
});
assert.equal(shutdownPolicyCalls, 1);
assert.equal(boundaryServer.status.acceptedRequests, 1);
rejectedClient.close();
releaseHeldRequest();
assert.equal(await (await heldRequest).text(), 'done');
assert.equal((await boundaryShutdown).outcome, 'clean');
console.log('serveNode post-boundary Socket.IO handshake rejection: OK');

// 5 — a real SIGTERM reaches an active HTTP + Socket.IO Node subprocess. The
// child must leave naturally after one managed shutdown chain (no process.exit).
const signalChild = spawn(
  process.execPath,
  [fileURLToPath(new URL('./node-shutdown-signal.mjs', import.meta.url))],
  {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let signalOutput = '';
let signalError = '';
let signalSent = false;
signalChild.stdout.on('data', (chunk) => {
  signalOutput += chunk.toString();
  if (!signalSent && signalOutput.includes('READY\n')) {
    signalSent = true;
    signalChild.kill('SIGTERM');
  }
});
signalChild.stderr.on('data', (chunk) => {
  signalError += chunk.toString();
});
const signalTimer = setTimeout(() => signalChild.kill('SIGKILL'), 5_000);
const signalExit = await new Promise((resolve) => signalChild.once('exit', resolve)).finally(
  () => clearTimeout(signalTimer),
);
assert.equal(signalExit, 0, signalError);
const signalResultLine = signalOutput.split('\n').find((line) => line.startsWith('RESULT '));
assert(signalResultLine, `Node SIGTERM fixture returned no result:\n${signalOutput}`);
const signalResult = JSON.parse(signalResultLine.slice('RESULT '.length));
assert.equal(signalResult.outcome, 'clean');
assert.equal(signalResult.pendingRequests, 0);
assert.equal(signalResult.pendingWebSockets, 0);
assert.equal(signalResult.signalCount, 1);
console.log('serveNode real SIGTERM shutdown: OK');

console.log('\n✅ Node smoke passed — stitchkit runs on Node (HTTP + Socket.IO).');
process.exit(0);
