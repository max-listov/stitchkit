import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bubblewrapArgs } from '../src/agent-runtime/sandbox-bubblewrap-args';
import { sandboxPath } from '../src/agent-runtime/sandbox-session';
import {
  createBubblewrapSandboxBackend,
  SandboxError,
  SandboxNetworkPolicySchema,
} from '../src/agent-runtime-sandbox';

const probe = spawnSync('/usr/bin/bwrap', [
  '--unshare-all',
  '--ro-bind',
  '/usr',
  '/usr',
  '--ro-bind',
  '/lib',
  '/lib',
  '--ro-bind',
  '/lib64',
  '/lib64',
  '--',
  '/usr/bin/true',
]);
const supported = process.platform === 'linux' && probe.status === 0;

test('sandbox policy and paths reject ambiguous authority', () => {
  expect(() =>
    SandboxNetworkPolicySchema.parse({
      allow: [{ origin: 'https://example.com' }, { origin: 'http://example.com' }],
    }),
  ).toThrow();
  expect(() =>
    SandboxNetworkPolicySchema.parse({
      allow: [{ origin: 'https://example.com', headers: { Host: 'other.invalid' } }],
    }),
  ).toThrow();
  expect(() =>
    SandboxNetworkPolicySchema.parse({
      allow: [{ origin: 'https://example.com', headers: { authorization: 'bad\r\nvalue' } }],
    }),
  ).toThrow();
  expect(() => sandboxPath('../escape')).toThrow();
  expect(() => sandboxPath('/etc/passwd')).toThrow();
  expect(() =>
    SandboxNetworkPolicySchema.parse({
      allow: [{ origin: 'http://user:password@example.com' }],
    }),
  ).toThrow();
  expect(() =>
    SandboxNetworkPolicySchema.parse({ allow: [{ origin: 'file:///tmp/x' }] }),
  ).toThrow();
  const args = bubblewrapArgs({
    workspace: '/tmp/work',
    socket: '/tmp/broker',
    network: 'deny-all',
    command: { executable: '/usr/bin/true' },
  });
  expect(args).toContain('--unshare-all');
  expect(args).not.toContain('--share-net');
});

describe.skipIf(!supported)('real Bubblewrap sandbox', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'sk-sandbox-test-'));
    const diagnostics: unknown[] = [];
    const backend = await createBubblewrapSandboxBackend({
      stateDirectory: root,
      onBrokerError(cause) {
        diagnostics.push(cause);
      },
    });
    const template = await backend.prewarm({
      template: 'fixture',
      files: { 'seed.txt': new TextEncoder().encode('initial') },
    });
    return { root, backend, template: template.templateKey, diagnostics };
  }
  test('template identity includes backend and contents, while prewarm reuses an exact template', async () => {
    const f = await fixture();
    try {
      const same = await f.backend.prewarm({
        template: 'fixture',
        files: { 'seed.txt': new TextEncoder().encode('initial') },
      });
      expect(same).toEqual({ reused: true, templateKey: f.template });
      const changed = await f.backend.prewarm({
        template: 'fixture',
        files: { 'seed.txt': new TextEncoder().encode('different') },
      });
      expect(changed.templateKey).not.toBe(f.template);
      const other = await createBubblewrapSandboxBackend({
        stateDirectory: f.root,
        name: 'other',
        onBrokerError: console.error,
      });
      const foreign = await other.prewarm({
        template: 'fixture',
        files: { 'seed.txt': new TextEncoder().encode('initial') },
      });
      expect(foreign.templateKey).not.toBe(f.template);
      const bytes = Buffer.from('snapshot');
      const pending = f.backend.prewarm({ template: 'mutable', files: { value: bytes } });
      bytes.fill(0);
      const snapshot = await pending;
      const session = await f.backend.create({
        template: snapshot.templateKey,
        network: 'deny-all',
      });
      try {
        expect(await session.session.readTextFile('value')).toBe('snapshot');
      } finally {
        await session.delete();
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  test('binary/text I/O, bounded commands and stop/reattach preserve one session', async () => {
    const f = await fixture();
    const handle = await f.backend.create({ template: f.template, network: 'deny-all' });
    try {
      expect(await handle.session.readTextFile('seed.txt')).toBe('initial');
      await handle.session.writeBinaryFile('dir/raw', new Uint8Array([0, 255, 10]));
      expect(await handle.session.readBinaryFile('dir/raw')).toEqual(
        new Uint8Array([0, 255, 10]),
      );
      await handle.session.writeTextFile('seed.txt', 'changed');
      const state = handle.captureState();
      await expect(
        f.backend.create({ template: f.template, state, network: 'deny-all' }),
      ).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
      await handle.stop();
      await expect(handle.session.run({ executable: '/usr/bin/true' })).rejects.toMatchObject({
        code: 'SANDBOX_STOPPED',
      });
      const reopened = await createBubblewrapSandboxBackend({
        stateDirectory: f.root,
        onBrokerError(cause) {
          console.error(cause);
        },
      });
      const resumed = await reopened.create({
        template: f.template,
        state,
        network: 'deny-all',
      });
      try {
        expect(resumed.session.id).toBe(state.sessionId);
        expect(await resumed.session.readTextFile('seed.txt')).toBe('changed');
        await expect(handle.delete()).rejects.toMatchObject({ code: 'SANDBOX_BUSY' });
        await expect(
          resumed.session.run({ executable: '/usr/bin/yes', maxOutputBytes: 32 }),
        ).rejects.toMatchObject({ code: 'SANDBOX_LIMIT' });
        await expect(
          resumed.session.run({ executable: '/usr/bin/sleep', args: ['5'], timeoutMs: 20 }),
        ).rejects.toMatchObject({ code: 'SANDBOX_LIMIT' });
      } finally {
        await resumed.delete();
      }
      const fresh = await f.backend.create({ template: f.template, network: 'deny-all' });
      try {
        expect(await fresh.session.readTextFile('seed.txt')).toBe('initial');
      } finally {
        await fresh.delete();
      }
    } finally {
      await handle.shutdown();
      await rm(f.root, { recursive: true, force: true });
    }
  });
  test('network namespace denies TCP and DNS while the host broker injects credentials', async () => {
    const f = await fixture();
    let calls = 0;
    let authorized = false;
    const echo = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        calls++;
        if (new URL(req.url).pathname === '/redirect')
          return Response.redirect('http://forbidden.invalid', 302);
        authorized = req.headers.get('authorization') === 'Bearer sandbox-fixture-secret';
        return Response.json({ authorized });
      },
    });
    const origin = echo.url.origin;
    const h = await f.backend.create({ template: f.template, network: 'deny-all' });
    const curl = (args: string[]) =>
      h.session.run({
        executable: '/usr/bin/curl',
        args: ['--silent', '--show-error', '--max-time', '1', ...args],
      });
    try {
      expect((await curl([origin])).exitCode).not.toBe(0);
      expect(calls).toBe(0);
      const dns = await h.session.run({
        executable: '/usr/bin/python3',
        args: [
          '-c',
          "import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.settimeout(.1); s.sendto(b'query',('1.1.1.1',53)); s.recv(10)",
        ],
      });
      expect(dns.exitCode).not.toBe(0);
      expect(
        (await curl(['--unix-socket', '/run/stitchkit-network.sock', origin])).stdout,
      ).toBe('Sandbox network denied');
      await h.session.setNetworkPolicy({
        allow: [{ origin, headers: { authorization: 'Bearer sandbox-fixture-secret' } }],
      });
      const reply = await curl(['--unix-socket', '/run/stitchkit-network.sock', origin]);
      expect(reply.exitCode).toBe(0);
      expect(JSON.parse(reply.stdout)).toEqual({ authorized: true });
      expect(authorized).toBe(true);
      const redirect = await curl([
        '--unix-socket',
        '/run/stitchkit-network.sock',
        `${origin}/redirect`,
      ]);
      expect(redirect.stdout).toBe('Sandbox upstream request failed');
      expect(f.diagnostics).toHaveLength(1);
      expect(f.diagnostics[0]).toMatchObject({ code: 'SANDBOX_NETWORK_DENIED' });
      expect(
        (
          await curl([
            '--unix-socket',
            '/run/stitchkit-network.sock',
            'http://forbidden.invalid',
          ])
        ).stdout,
      ).toBe('Sandbox network denied');
      expect((await h.session.run({ executable: '/usr/bin/env' })).stdout).not.toContain(
        'sandbox-fixture-secret',
      );
      expect(JSON.stringify(h.captureState())).not.toContain('sandbox-fixture-secret');
      const hidden = await h.session.run({ executable: '/usr/bin/ls', args: ['/root'] });
      expect(hidden.exitCode).not.toBe(0);
      await h.session.setNetworkPolicy('allow-all');
      expect((await curl([origin])).exitCode).toBe(0);
      await h.session.setNetworkPolicy('deny-all');
      expect((await curl([origin])).exitCode).not.toBe(0);
    } finally {
      await h.delete();
      echo.stop(true);
      await rm(f.root, { recursive: true, force: true });
    }
  });
  test('stop settles live children, caller abort works and backend identity fences reconnect', async () => {
    const f = await fixture();
    const h = await f.backend.create({ template: f.template, network: 'deny-all' });
    try {
      const abort = new AbortController();
      const p = await h.session.spawn(
        { executable: '/usr/bin/sleep', args: ['5'] },
        { signal: abort.signal },
      );
      abort.abort(new Error('caller stopped'));
      await expect(p.result).rejects.toThrow('caller stopped');
      const running = await h.session.spawn({ executable: '/usr/bin/sleep', args: ['5'] });
      await expect(h.session.setNetworkPolicy('allow-all')).rejects.toMatchObject({
        code: 'SANDBOX_BUSY',
      });
      await h.stop();
      expect((await running.result).exitCode).not.toBe(0);
      await expect(
        f.backend.create({
          template: f.template,
          state: { ...h.captureState(), backend: 'other' },
          network: 'deny-all',
        }),
      ).rejects.toMatchObject({ code: 'SANDBOX_STATE_MISMATCH' });
    } finally {
      await h.delete();
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

test('missing sandbox executable refuses create instead of running on the host', async () => {
  if (process.platform !== 'linux') return;
  const root = await mkdtemp(join(tmpdir(), 'sk-sandbox-missing-'));
  const backend = await createBubblewrapSandboxBackend({
    stateDirectory: root,
    executable: '/no-such-bubblewrap',
    onBrokerError(cause) {
      console.error(cause);
    },
  });
  try {
    const t = await backend.prewarm({ template: 'empty' });
    await expect(
      backend.create({ template: t.templateKey, network: 'deny-all' }),
    ).rejects.toBeInstanceOf(SandboxError);
    const [namespace] = await readdir(root);
    expect(namespace).toBeDefined();
    expect(await readdir(join(root, namespace ?? '', 'sessions'))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
