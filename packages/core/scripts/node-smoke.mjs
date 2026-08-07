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
];
for (const name of entrypoints) {
  await import(name);
  console.log(`import ${name}: OK`);
}

const { defineContract } = await import('stitchkit');
const { createSocketIOServer, implement, serveNode } = await import('stitchkit/node');
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

// 3 — serveNode + Socket.IO round-trip (WebSocket).
const { io: ioClient } = await import('socket.io-client');
const socket = await createSocketIOServer({ cors: { origin: '*' } });
socket.io.on('connection', (s) => s.on('ping', (n) => s.emit('pong', n + 1)));
const realtime = await serveNode({ socket, port: 0 });

const client = ioClient(realtime.url, { transports: ['websocket'] });
const pong = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('socket round-trip timed out')), 8000);
  client.on('connect', () => client.emit('ping', 41));
  client.on('pong', (n) => {
    clearTimeout(timer);
    resolve(n);
  });
  client.on('connect_error', (e) => {
    clearTimeout(timer);
    reject(e);
  });
});
assert.equal(pong, 42, 'Socket.IO round-trip should pong 42');
console.log('serveNode Socket.IO round-trip: OK');
client.close();
await realtime.close();

console.log('\n✅ Node smoke passed — stitchkit runs on Node (HTTP + Socket.IO).');
process.exit(0);
