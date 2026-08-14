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

// 1 — every server-side entrypoint must IMPORT cleanly under Node.
const entrypoints = [
  'stitchkit',
  'stitchkit/contract',
  'stitchkit/server',
  'stitchkit/tools',
  'stitchkit/node',
  'stitchkit/observability',
  'stitchkit/testing',
];
for (const name of entrypoints) {
  await import(name);
  console.log(`import ${name}: OK`);
}

const { createHttpClient, defineContract, defineRealtimeContract } = await import('stitchkit');
const { bindRealtimeServer, createHandler, createSocketIOServer, implement, serveNode } =
  await import('stitchkit/node');
const { createHandlerTestClient } = await import('stitchkit/testing');
const { z } = await import('zod');

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
await http.close();

// 3 — Node's native fetch classification remains intact when Stitchkit adds
// its narrow Bun adapter. The backend starts only after the first native fetch
// has rejected, so success proves a real second transport attempt.
const { createServer: createNativeNodeServer } = await import('node:http');
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
  console.log('Node network retry round-trip: OK');
} finally {
  globalThis.fetch = nativeFetch;
  if (lateServer) {
    await new Promise((resolve, reject) =>
      lateServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

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
client.close();
await realtime.close();

console.log('\n✅ Node smoke passed — stitchkit runs on Node (HTTP + Socket.IO).');
process.exit(0);
