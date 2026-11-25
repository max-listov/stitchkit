/**
 * Cross-UID and pinned-owner coverage for `createUnixClientTransport`:
 * - eager validation of `expectedOwnerUid` (including `0`, negative, float, > uint32)
 * - same-UID default unchanged, mismatched `expectedOwnerUid` refused on both Bun and Node
 * - live Linux cross-UID test (UID 65534 connecting to root-owned `0750` dir + `0660` socket)
 *   verifying HTTP 200 on both Bun and Node paths, plus OS access refusals (`0700` dir ->
 *   `UNIX_TARGET_REFUSED`, `0600` socket -> `UNIX_CONNECT_FAILED`), group-writable dir refusal,
 *   and symlinked socket refusal.
 */
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNodeServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUnixClientTransport } from '../src/entrypoints/server';
import * as unixClientBun from '../src/server/unix-client-bun';
import { reapAfterEachTest, trackProcess } from './support/process-reaper';

reapAfterEachTest();

const root = mkdtempSync(join(tmpdir(), 'sk-owner-'));
const servers: Server[] = [];

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

afterAll(async () => {
  for (const server of servers.reverse()) await close(server);
  rmSync(root, { recursive: true, force: true });
});

describe('createUnixClientTransport expectedOwnerUid', () => {
  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000])(
    'refuses invalid expectedOwnerUid %p eagerly',
    (expectedOwnerUid) => {
      expect(() =>
        createUnixClientTransport({
          socketPath: join(root, 'bad.sock'),
          expectedOwnerUid,
        }),
      ).toThrow(TypeError);
    },
  );

  test('accepts matching caller UID and refuses mismatched expectedOwnerUid on both Bun and Node paths', async () => {
    const dir = join(root, 'same');
    mkdirSync(dir, { mode: 0o700 });
    const socketPath = join(dir, 'api.sock');
    const server = createNodeServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(server);
    await listen(server, socketPath);

    const selfUid = typeof process.getuid === 'function' ? process.getuid() : 0;
    const wrongUid = selfUid === 0 ? 1 : 0;

    for (const forceNode of [false, true]) {
      const spy = forceNode
        ? spyOn(unixClientBun, 'hasBunUnixRuntime').mockReturnValue(false)
        : undefined;
      try {
        const okClient = createUnixClientTransport({ socketPath, expectedOwnerUid: selfUid });
        try {
          const res = await okClient.fetch('http://local/ping');
          expect(res.status).toBe(200);
          expect(await res.json()).toEqual({ ok: true });
        } finally {
          await okClient.close();
        }

        const badClient = createUnixClientTransport({
          socketPath,
          expectedOwnerUid: wrongUid,
        });
        try {
          await expect(badClient.fetch('http://local/ping')).rejects.toMatchObject({
            code: 'UNIX_TARGET_REFUSED',
            delivery: 'not-dispatched',
          });
        } finally {
          await badClient.close();
        }
      } finally {
        spy?.mockRestore();
      }
    }
  });

  const canRunRootCrossUid =
    process.platform === 'linux' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0;

  test.if(canRunRootCrossUid)(
    'real Linux cross-UID client (UID 65534 -> root 0750 dir + 0660 socket) passes HTTP 200 on Bun and Node and enforces OS/policy refusals',
    async () => {
      const extRoot = mkdtempSync(join(tmpdir(), 'sk-xuid-'));
      chmodSync(extRoot, 0o755);
      const sockDir = join(extRoot, 'svc');
      mkdirSync(sockDir);
      chownSync(sockDir, 0, 65534);
      chmodSync(sockDir, 0o750);
      const socketPath = join(sockDir, 'api.sock');

      const server = createNodeServer((_req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ uid: 0, ok: true }));
      });
      servers.push(server);
      await listen(server, socketPath);
      chownSync(socketPath, 0, 65534);
      chmodSync(socketPath, 0o660);

      const built = await Bun.build({
        entrypoints: [new URL('../src/server/unix-client.ts', import.meta.url).pathname],
        outdir: extRoot,
        target: 'node',
        naming: 'unix-client-bundle.mjs',
      });
      expect(built.success).toBe(true);
      const bundlePath = join(extRoot, 'unix-client-bundle.mjs');
      chmodSync(bundlePath, 0o644);

      const probePath = join(extRoot, 'probe.mjs');
      writeFileSync(
        probePath,
        `
import { createUnixClientTransport } from ${JSON.stringify(bundlePath)};
const socketPath = process.argv[2];
const expected = process.argv[3] === 'none' ? undefined : Number(process.argv[3]);
const client = createUnixClientTransport({
  socketPath,
  ...(expected !== undefined && { expectedOwnerUid: expected }),
});
try {
  const res = await client.fetch('http://local/ping');
  const body = await res.json();
  console.log(JSON.stringify({ ok: true, status: res.status, body }));
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    code: error?.code ?? null,
    delivery: error?.delivery ?? null,
    message: error?.message ?? String(error),
  }));
} finally {
  await client.close();
}
`,
      );
      chmodSync(probePath, 0o644);

      const runAsNobody = (
        mode: 'bun' | 'node',
        target: string,
        expected: string,
      ): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const runtime = mode === 'node' ? 'node' : process.execPath;
          const child = spawn(runtime, [probePath, target, expected], {
            uid: 65534,
            gid: 65534,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          trackProcess(child.pid);
          let stdout = '';
          let stderr = '';
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
          });
          child.once('error', reject);
          child.once('close', (code) => {
            if (code !== 0) {
              reject(new Error(`probe exited ${String(code)}: ${stderr}`));
              return;
            }
            try {
              resolve(JSON.parse(stdout.trim()) as Record<string, unknown>);
            } catch (error) {
              reject(error);
            }
          });
        });

      try {
        expect(await runAsNobody('bun', socketPath, 'none')).toMatchObject({
          ok: false,
          code: 'UNIX_TARGET_REFUSED',
          delivery: 'not-dispatched',
        });

        expect(await runAsNobody('bun', socketPath, '0')).toEqual({
          ok: true,
          status: 200,
          body: { uid: 0, ok: true },
        });
        expect(await runAsNobody('node', socketPath, '0')).toEqual({
          ok: true,
          status: 200,
          body: { uid: 0, ok: true },
        });

        expect(await runAsNobody('bun', socketPath, '1')).toMatchObject({
          ok: false,
          code: 'UNIX_TARGET_REFUSED',
          delivery: 'not-dispatched',
        });

        const linkPath = join(sockDir, 'alias.sock');
        symlinkSync(socketPath, linkPath);
        expect(await runAsNobody('bun', linkPath, '0')).toMatchObject({
          ok: false,
          code: 'UNIX_TARGET_REFUSED',
          delivery: 'not-dispatched',
        });

        chmodSync(sockDir, 0o770);
        expect(await runAsNobody('bun', socketPath, '0')).toMatchObject({
          ok: false,
          code: 'UNIX_TARGET_REFUSED',
          delivery: 'not-dispatched',
        });
        chmodSync(sockDir, 0o750);

        chmodSync(socketPath, 0o600);
        expect(await runAsNobody('bun', socketPath, '0')).toMatchObject({
          ok: false,
          code: 'UNIX_CONNECT_FAILED',
          delivery: 'not-dispatched',
        });
        chmodSync(socketPath, 0o660);

        chmodSync(sockDir, 0o700);
        expect(await runAsNobody('bun', socketPath, '0')).toMatchObject({
          ok: false,
          code: 'UNIX_TARGET_REFUSED',
          delivery: 'not-dispatched',
        });
      } finally {
        chmodSync(sockDir, 0o750);
        rmSync(extRoot, { recursive: true, force: true });
      }
    },
  );
});
