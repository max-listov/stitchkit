import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
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

export async function distributionServer(storageRoot) {
  let assetRequests = 0;
  let corrupt = false;
  let manifest;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/cli/manifest.json') {
        response.end(manifest ?? (await readFile(join(storageRoot, 'manifest.json'))));
      } else if (
        /^\/cli\/[\w.+-]+\/publisher-proof-(?:linux|darwin)-(?:x64|arm64)\.gz$/.test(
          url.pathname,
        )
      ) {
        assetRequests++;
        response.end(
          corrupt
            ? gzipSync('untrusted replacement')
            : await readFile(join(storageRoot, url.pathname.slice('/cli/'.length))),
        );
      } else {
        response.writeHead(404);
        response.end();
      }
    } catch {
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/cli/`,
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
