import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createHttpClient, defineContract } from 'stitchkit';
import { createUnixClientTransport } from 'stitchkit/server';
import { z } from 'zod';

const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-bun-unix-'));
const socketPath = join(root, 'daemon.sock');
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let written = 0;
let streamed = 0;
let activeCancellations = 0;
const frames = Array.from(
  { length: 64 },
  (_, index) => `${JSON.stringify({ index, data: 'x'.repeat(32 * 1024) })}\n`,
);
const offered = 17_000;
const streamData = 'x'.repeat(1000);
const streamFrame = (index) =>
  `${JSON.stringify({ type: 'data', data: { index, data: streamData } })}\n`;
const terminalFrame = `${JSON.stringify({ type: 'end' })}\n`;
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
  if (request.url === '/oversized') {
    response.end('x'.repeat(17 * 1024 * 1024));
    return;
  }
  if (request.url === '/feed' || request.url === '/feed/') {
    streamed = 0;
    try {
      for (let index = 0; index < offered; index += 1) {
        if (!response.write(streamFrame(index))) {
          await new Promise((resolve) => response.once('drain', resolve));
        }
        streamed += 1;
      }
      response.end(terminalFrame);
    } catch {
      // Reader cancellation intentionally closes the producer.
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
  if (request.url === '/cancel/stream' || request.url === '/cancel/raw') {
    activeCancellations += 1;
    request.socket.once('close', () => {
      activeCancellations -= 1;
    });
    response.writeHead(200, {
      'content-type':
        request.url === '/cancel/raw' ? 'application/octet-stream' : 'application/x-ndjson',
    });
    response.write(
      request.url === '/cancel/raw' ? 'baseline' : '{"type":"data","data":{"value":1}}\n',
    );
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
  assert.throws(
    () =>
      createUnixClientTransport({
        socketPath,
        responseBodyMode: 'streaming',
        maxResponseBytes: 1024,
      }),
    /cannot be combined/,
  );
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

  const bounded = createUnixClientTransport({ socketPath });
  await assert.rejects(
    async () => {
      const oversized = await bounded.fetch('http://local/oversized');
      for await (const _chunk of oversized.body) {
        // The default must reject on its cumulative unary ceiling.
      }
    },
    (error) => error?.code === 'UNIX_RESPONSE_TOO_LARGE',
  );
  await bounded.close();

  const streamContract = defineContract(
    { prefix: '/feed' },
    {
      subscribe: {
        method: 'GET',
        path: '/',
        desc: 'Read a long-lived Unix stream',
        stream: {
          item: z.object({ index: z.number().int(), data: z.string() }).strict(),
        },
      },
    },
  );
  const cancellationContract = defineContract(
    { prefix: '/cancel' },
    {
      stream: {
        method: 'GET',
        path: '/stream',
        desc: 'Cancel a response after its headers',
        stream: { item: z.object({ value: z.number().int() }).strict() },
      },
      raw: {
        method: 'GET',
        path: '/raw',
        desc: 'Cancel a raw body after its headers',
        rawResponse: true,
      },
    },
  );
  const streaming = createUnixClientTransport({
    socketPath,
    responseBodyMode: 'streaming',
    maxConnections: 1,
  });
  const streamClient = createClient(streamContract, {
    baseUrl: 'http://local',
    fetch: streaming.fetch,
  });
  const items = await streamClient.subscribe();
  const firstItem = await items.next();
  assert.equal(firstItem.done, false);
  assert.deepEqual(firstItem.value, { index: 0, data: streamData });
  let streamWireBytes = Buffer.byteLength(streamFrame(0)) + Buffer.byteLength(terminalFrame);
  await delay(200);
  assert.ok(streamed < offered, 'streaming mode must pause a stalled producer');
  let received = 1;
  for (;;) {
    const next = await items.next();
    if (next.done) break;
    assert.equal(next.value.index, received);
    assert.equal(next.value.data, streamData);
    streamWireBytes += Buffer.byteLength(streamFrame(received));
    received += 1;
  }
  assert.equal(received, offered);
  assert.ok(
    streamWireBytes > 16 * 1024 * 1024,
    'packed stream proof must cross the unary default ceiling',
  );
  await streaming.close();

  const single = createUnixClientTransport({
    socketPath,
    responseBodyMode: 'streaming',
    maxConnections: 1,
  });
  const stalled = await single.fetch('http://local/stall');
  const stalledReader = stalled.body.getReader();
  await stalledReader.read();
  await stalledReader.cancel();
  assert.deepEqual(await (await single.fetch('http://local/value')).json(), {
    runtime,
    transport: 'unix',
  });
  await single.close();

  const waitForCancellationRelease = async () => {
    const deadline = Date.now() + 1_000;
    while (activeCancellations > 0 && Date.now() < deadline) await delay(5);
    assert.equal(activeCancellations, 0, 'cancelled response must release its server source');
  };
  for (const kind of ['configured', 'fetch-config']) {
    const owned = createUnixClientTransport({
      socketPath,
      responseBodyMode: 'streaming',
      maxConnections: 1,
    });
    const cancellationClient = createClient(
      cancellationContract,
      kind === 'configured'
        ? createHttpClient({
            baseUrl: 'http://local',
            fetch: owned.fetch,
            retry: { limit: 0 },
          })
        : { baseUrl: 'http://local', fetch: owned.fetch },
    );
    const streamController = new AbortController();
    const ownedStream = await cancellationClient.stream.withOptions({
      signal: streamController.signal,
    });
    assert.deepEqual(await ownedStream.next(), { done: false, value: { value: 1 } });
    const pendingStreamRead = ownedStream.next();
    streamController.abort(new Error('packed caller stopped stream'));
    await pendingStreamRead.catch(() => undefined);
    await waitForCancellationRelease();
    assert.deepEqual(await (await owned.fetch('http://local/value')).json(), {
      runtime,
      transport: 'unix',
    });

    const rawController = new AbortController();
    const rawResponse = await cancellationClient.raw.withOptions({
      signal: rawController.signal,
    });
    const rawReader = rawResponse.body.getReader();
    assert.equal((await rawReader.read()).done, false);
    const pendingRawRead = rawReader.read();
    rawController.abort(new Error('packed caller stopped raw body'));
    await pendingRawRead.catch(() => undefined);
    await waitForCancellationRelease();
    assert.deepEqual(await (await owned.fetch('http://local/value')).json(), {
      runtime,
      transport: 'unix',
    });
    await owned.close();
  }

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
