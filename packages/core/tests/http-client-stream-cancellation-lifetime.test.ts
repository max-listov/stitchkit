import { afterEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createClient, createHttpClient } from '../src';
import type { ClientConfig } from '../src/browser/client';
import { defineContract } from '../src/contract';
import { createUnixClientTransport } from '../src/server/unix-client';

const StreamValue = z.object({ value: z.number().int() }).strict();
const cancellationContract = defineContract(
  { prefix: 'lifetime' },
  {
    quiet: {
      method: 'GET',
      path: '/quiet',
      desc: 'Hold a quiet stream after its baseline',
      stream: { item: StreamValue },
    },
    normal: {
      method: 'GET',
      path: '/normal',
      desc: 'Finish a stream normally',
      stream: { item: StreamValue },
    },
    failed: {
      method: 'GET',
      path: '/failed',
      desc: 'Fail a stream after headers',
      stream: { item: StreamValue },
    },
    raw: {
      method: 'GET',
      path: '/raw',
      desc: 'Hold a raw response after its baseline',
      rawResponse: true,
    },
    ping: {
      method: 'GET',
      path: '/ping',
      desc: 'Prove the connection slot is reusable',
      output: z.object({ ok: z.literal(true) }).strict(),
    },
  },
);

type CancellationClient = ReturnType<
  typeof createClient<typeof cancellationContract.endpoints>
>;
type ClientFactory = (
  baseUrl: string,
  fetch: ClientConfig['fetch'],
  socketPath: string,
) => CancellationClient;

let socketCounter = 0;
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections();
    if (!server.listening) continue;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function startServer(): Promise<{
  socketPath: string;
  active: ReadonlySet<string>;
}> {
  socketCounter += 1;
  const socketPath = join(
    tmpdir(),
    `stitchkit-http-stream-cancellation-${process.pid}-${socketCounter}.sock`,
  );
  const active = new Set<string>();
  const server = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/lifetime/ping') {
      response.setHeader('content-type', 'application/json');
      response.end('{"ok":true}');
      return;
    }

    active.add(path);
    const release = (): void => void active.delete(path);
    request.socket.once('close', release);
    response.once('finish', release);
    response.writeHead(200, {
      'content-type':
        path === '/lifetime/raw' ? 'application/octet-stream' : 'application/x-ndjson',
    });
    if (path === '/lifetime/raw') {
      response.write('baseline');
      return;
    }
    response.write('{"type":"data","data":{"value":1}}\n');
    if (path === '/lifetime/normal') {
      response.end('{"type":"end"}\n');
      return;
    }
    if (path === '/lifetime/failed') {
      response.write('{"type":"error","error":{"code":"STREAM_FAILED"}}\n');
    }
  });
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve({ socketPath, active });
    });
  });
}

async function waitForRelease(active: ReadonlySet<string>, path: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (active.has(path) && Date.now() < deadline) await Bun.sleep(5);
  expect(active.has(path)).toBe(false);
}

const factories: Array<[string, ClientFactory]> = [
  [
    'configured HTTP adapter Unix option',
    (baseUrl, _fetch, socketPath) =>
      createClient(
        cancellationContract,
        createHttpClient({ baseUrl, unix: socketPath, timeout: 40, retry: { limit: 0 } }),
      ),
  ],
  [
    'configured HTTP adapter',
    (baseUrl, fetch) =>
      createClient(
        cancellationContract,
        createHttpClient({ baseUrl, fetch, timeout: 40, retry: { limit: 0 } }),
      ),
  ],
  [
    'Fetch config',
    (baseUrl, fetch) => createClient(cancellationContract, { baseUrl, fetch, timeout: 40 }),
  ],
];

describe.each(factories)('response-body cancellation lifetime — %s', (_name, makeClient) => {
  test('all terminal paths release server admission and the finite Unix slot', async () => {
    const { socketPath, active } = await startServer();
    const transport = createUnixClientTransport({
      socketPath,
      responseBodyMode: 'streaming',
      maxConnections: 1,
    });
    const client = makeClient('http://local', transport.fetch, socketPath);

    const quietAfterYield = await client.quiet();
    expect(await quietAfterYield.next()).toEqual({ done: false, value: { value: 1 } });
    await Bun.sleep(60);
    expect(active.has('/lifetime/quiet')).toBe(true);
    await quietAfterYield.return?.();
    await waitForRelease(active, '/lifetime/quiet');
    await expect(client.ping()).resolves.toEqual({ ok: true });

    const pendingController = new AbortController();
    const quietPending = await client.quiet.withOptions({ signal: pendingController.signal });
    expect(await quietPending.next()).toEqual({ done: false, value: { value: 1 } });
    const pendingNext = quietPending.next();
    pendingController.abort(new Error('caller stopped the subscription'));
    await pendingNext.catch(() => undefined);
    await waitForRelease(active, '/lifetime/quiet');
    await expect(client.ping()).resolves.toEqual({ ok: true });

    const beforeFirstNext = await client.quiet();
    await beforeFirstNext.return?.();
    await waitForRelease(active, '/lifetime/quiet');
    await expect(client.ping()).resolves.toEqual({ ok: true });

    const normal = await client.normal();
    await expect(Array.fromAsync(normal)).resolves.toEqual([{ value: 1 }]);
    await waitForRelease(active, '/lifetime/normal');
    await expect(client.ping()).resolves.toEqual({ ok: true });

    const failed = await client.failed();
    expect(await failed.next()).toEqual({ done: false, value: { value: 1 } });
    await expect(failed.next()).rejects.toMatchObject({ code: 'STREAM_FAILED' });
    await waitForRelease(active, '/lifetime/failed');
    await expect(client.ping()).resolves.toEqual({ ok: true });

    const rawController = new AbortController();
    const raw = await client.raw.withOptions({ signal: rawController.signal });
    const reader = raw.body?.getReader();
    expect(reader).toBeDefined();
    if (!reader) throw new Error('Raw response has no body');
    expect((await reader.read()).done).toBe(false);
    const pendingRawRead = reader.read();
    rawController.abort(new Error('caller stopped the raw body'));
    await pendingRawRead.catch(() => undefined);
    await waitForRelease(active, '/lifetime/raw');
    await expect(client.ping()).resolves.toEqual({ ok: true });

    await transport.close();
  });
});
