import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxBroker } from '../src/agent-runtime/sandbox-broker';
import { SandboxError } from '../src/agent-runtime/sandbox-contract';

const MAX = 1_048_576;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function setup(upstream: (req: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: upstream });
  cleanups.push(() => server.stop(true));
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-broker-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const origin = `http://127.0.0.1:${server.port}`;
  const failures: unknown[] = [];
  const broker = await createSandboxBroker(
    join(dir, 'broker.sock'),
    () => ({ allow: [{ origin }] }),
    (cause) => failures.push(cause),
  );
  cleanups.push(() => broker.close());
  const call = (body: Uint8Array | undefined) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: join(dir, 'broker.sock'),
          path: '/echo',
          method: 'POST',
          headers: { host: `127.0.0.1:${server.port}`, 'content-type': 'text/plain' },
        },
        (response) => {
          const parts: Buffer[] = [];
          response.on('data', (part: Buffer) => parts.push(part));
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              text: Buffer.concat(parts).toString('utf8'),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(body);
    });
  return { call, failures };
}

describe('the sandbox gateway bounds both directions', () => {
  test('a request and its response within the limit pass through', async () => {
    const { call, failures } = await setup(
      async (req) => new Response(`echo:${await req.text()}`),
    );
    const reply = await call(new TextEncoder().encode('hello'));
    expect(reply).toEqual({ status: 200, text: 'echo:hello' });
    expect(failures).toEqual([]);
  });

  test('a body of exactly the limit passes, one byte more is a generic 502 with SANDBOX_LIMIT', async () => {
    const { call, failures } = await setup(
      async (req) => new Response(String((await req.arrayBuffer()).byteLength)),
    );
    expect(await call(new Uint8Array(MAX))).toEqual({ status: 200, text: String(MAX) });
    const refused = await call(new Uint8Array(MAX + 1));
    expect(refused).toEqual({ status: 502, text: 'Sandbox upstream request failed' });
    const [cause] = failures;
    expect(cause).toBeInstanceOf(SandboxError);
    expect(cause).toMatchObject({ code: 'SANDBOX_LIMIT' });
  });

  test('an upstream response over the limit is a generic 502 with SANDBOX_LIMIT', async () => {
    const { call, failures } = await setup(() => new Response(new Uint8Array(MAX + 1)));
    expect(await call(undefined)).toEqual({
      status: 502,
      text: 'Sandbox upstream request failed',
    });
    expect(failures[0]).toMatchObject({ code: 'SANDBOX_LIMIT' });
  });
});
