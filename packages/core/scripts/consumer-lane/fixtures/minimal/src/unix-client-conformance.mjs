import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnixClientTransport } from 'stitchkit/server';

const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-bun-unix-'));
const socketPath = join(root, 'daemon.sock');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let written = 0;
const frames = Array.from(
  { length: 64 },
  (_, index) => `${JSON.stringify({ index, data: 'x'.repeat(32 * 1024) })}\n`,
);
const server = createServer(async (request, response) => {
  if (request.url === '/fast') {
    try {
      for (const frame of frames) {
        if (!response.write(frame)) {
          await new Promise((resolve) => response.once('drain', resolve));
        }
        written += 1;
      }
      response.end();
    } catch {
      // Cancellation is the expected end of the stalled-reader proof.
    }
    return;
  }
  if (request.url === '/headers') {
    response.writeHead(200, { 'x-large': 'x'.repeat(2048) });
    response.end('{}');
    return;
  }
  if (request.url === '/stall') {
    response.writeHead(200);
    response.write('first');
    return;
  }
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({ runtime: process.versions.bun ? 'bun' : 'node', transport: 'unix' }),
  );
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});

try {
  const transport = createUnixClientTransport({ socketPath });
  const response = await transport.fetch('http://local/value');
  const runtime = process.versions.bun ? 'bun' : 'node';
  assert.deepEqual(await response.json(), { runtime, transport: 'unix' });
  const fast = await transport.fetch('http://local/fast');
  const reader = fast.body.getReader();
  const chunks = [];
  const first = await reader.read();
  if (first.value) chunks.push(first.value);
  await delay(200);
  assert.ok(written < frames.length, 'packed Bun adapter must pause a stalled producer');
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    chunks.push(next.value);
  }
  const actual = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString();
  assert.equal(actual, frames.join(''), 'packed Bun adapter must preserve chunk framing');
  assert.equal(written, frames.length, 'packed Bun adapter must resume the producer');
  await transport.close();

  const single = createUnixClientTransport({ socketPath, maxConnections: 1 });
  const stalled = await single.fetch('http://local/stall');
  const stalledReader = stalled.body.getReader();
  await stalledReader.read();
  await stalledReader.cancel();
  assert.deepEqual(await (await single.fetch('http://local/value')).json(), {
    runtime,
    transport: 'unix',
  });
  await single.close();

  const tooSmall = createUnixClientTransport({ socketPath, maxHeaderBytes: 256 });
  await assert.rejects(
    () => tooSmall.fetch('http://local/headers'),
    (error) =>
      error?.code === 'UNIX_HEADERS_TOO_LARGE' && error.delivery === 'response-received',
  );
  assert.deepEqual(await (await tooSmall.fetch('http://local/value')).json(), {
    runtime,
    transport: 'unix',
  });
  await tooSmall.close();
  const sufficient = createUnixClientTransport({ socketPath, maxHeaderBytes: 4096 });
  assert.equal(await (await sufficient.fetch('http://local/headers')).text(), '{}');
  await sufficient.close();

  const rawSocketPath = join(root, 'raw.sock');
  const rawHead = 'HTTP/1.1 200 OK\r\nX-A: 1234\r\n\r\n';
  const rawServer = createNetServer((socket) =>
    socket.once('data', () => socket.end(rawHead)),
  );
  await new Promise((resolve, reject) => {
    rawServer.once('error', reject);
    rawServer.listen(rawSocketPath, resolve);
  });
  try {
    // Bun owns the complete wire head (30 bytes here). Node delegates to its
    // native parser, whose maxHeaderSize accounting for this one field is 10.
    const exact = process.versions.bun ? Buffer.byteLength(rawHead) : 10;
    for (const [limit, accepted] of [
      [exact - 1, false],
      [exact, true],
      [exact + 1, true],
    ]) {
      const boundary = createUnixClientTransport({
        socketPath: rawSocketPath,
        maxHeaderBytes: limit,
      });
      try {
        if (accepted) assert.equal((await boundary.fetch('http://local/exact')).status, 200);
        else
          await assert.rejects(
            () => boundary.fetch('http://local/exact'),
            (error) => error?.code === 'UNIX_HEADERS_TOO_LARGE',
          );
      } finally {
        await boundary.close();
      }
    }
  } finally {
    await new Promise((resolve, reject) =>
      rawServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  console.log(`packed ${process.versions.bun ? 'Bun' : 'Node'} Unix client conformance: ok`);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await rm(root, { recursive: true, force: true });
}
