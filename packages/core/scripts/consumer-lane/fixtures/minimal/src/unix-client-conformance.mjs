import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnixClientTransport } from 'stitchkit/server';

const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-bun-unix-'));
const socketPath = join(root, 'daemon.sock');
let written = 0;
const server = createServer(async (request, response) => {
  if (request.url === '/fast') {
    try {
      for (let index = 0; index < 512; index += 1) {
        if (!response.write(Buffer.alloc(32 * 1024))) {
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
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ runtime: 'bun', transport: 'unix' }));
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(socketPath, resolve);
});

try {
  const transport = createUnixClientTransport({ socketPath });
  const response = await transport.fetch('http://local/value');
  assert.deepEqual(await response.json(), { runtime: 'bun', transport: 'unix' });
  const fast = await transport.fetch('http://local/fast');
  const reader = fast.body.getReader();
  await reader.read();
  await Bun.sleep(200);
  assert.ok(written < 512, 'packed Bun adapter must pause a stalled producer');
  await reader.cancel();
  await transport.close();
  console.log('packed Bun Unix client conformance: ok');
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  server.closeAllConnections();
  await rm(root, { recursive: true, force: true });
}
