import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { Agent, createServer, get } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';

const run = promisify(execFile);
export async function execute(file, args = [], options = {}) {
  return run(file, args, { timeout: 90_000, maxBuffer: 128 * 1024, ...options });
}

export async function assertBinary(path, stamp) {
  const { stdout, stderr } = await execute(path, ['stamp', '--json']);
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), stamp);
  const version = await execute(path, ['--version']);
  assert.match(
    version.stdout,
    new RegExp(`${stamp.version.replaceAll('.', '\\.')}.*${stamp.commit.slice(0, 12)}`),
  );
}

/** Even a keep-alive client must receive independent connections for this file fixture. */
export async function assertIndependentConnections(baseUrl) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const request = () =>
    new Promise((resolve, reject) => {
      const pending = get(`${baseUrl}manifest.json`, { agent }, (response) => {
        const socket = response.socket;
        const connection = response.headers.connection;
        response.on('error', reject);
        response.resume();
        response.once('end', () => resolve({ socket, connection }));
      });
      pending.setTimeout(30_000, () =>
        pending.destroy(new Error('Fixture request timed out')),
      );
      pending.once('error', reject);
    });
  try {
    const first = await request();
    const second = await request();
    assert.equal(first.connection, 'close');
    assert.equal(second.connection, 'close');
    assert.notEqual(first.socket, second.socket);
  } finally {
    agent.destroy();
  }
}

export async function distributionServer(storageRoot) {
  let assetRequests = 0;
  let corrupt = false;
  let manifest;
  let nextSocket = 0;
  let nextRequest = 0;
  const socketIds = new WeakMap();
  const trace = [];
  const record = (event) => {
    trace.push(event);
    if (trace.length > 64) trace.shift();
  };
  const server = createServer(async (request, response) => {
    const requestId = ++nextRequest;
    const socketId = socketIds.get(request.socket);
    record({ requestId, socketId, event: 'request', path: request.url, corrupt });
    response.once('finish', () => record({ requestId, socketId, event: 'finish' }));
    response.once('close', () =>
      record({ requestId, socketId, event: 'close', finished: response.writableFinished }),
    );
    // This fixture qualifies signed files and rollback; every request owns its connection.
    response.setHeader('connection', 'close');
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/cli/manifest.json') {
        const body = manifest ?? (await readFile(join(storageRoot, 'manifest.json')));
        record({ requestId, socketId, event: 'send', bytes: Buffer.byteLength(body) });
        response.end(body);
      } else if (
        /^\/cli\/[\w.+-]+\/publisher-proof-(?:linux|darwin)-(?:x64|arm64)\.gz$/.test(
          url.pathname,
        )
      ) {
        assetRequests++;
        const body = corrupt
          ? gzipSync('untrusted replacement')
          : await readFile(join(storageRoot, url.pathname.slice('/cli/'.length)));
        record({ requestId, socketId, event: 'send', bytes: body.length });
        response.end(body);
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch (error) {
      record({ requestId, socketId, event: 'error', message: String(error) });
      response.writeHead(500);
      response.end();
    }
  });
  server.on('connection', (socket) => {
    const socketId = ++nextSocket;
    socketIds.set(socket, socketId);
    socket.once('close', (hadError) => record({ socketId, event: 'socket-close', hadError }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/cli/`,
    get trace() {
      return [...trace];
    },
    get assetRequests() {
      return assetRequests;
    },
    corrupt(value) {
      corrupt = value;
    },
    manifest(value) {
      manifest = value === undefined ? undefined : JSON.stringify(value);
    },
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
