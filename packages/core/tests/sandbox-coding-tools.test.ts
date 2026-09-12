import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createBubblewrapSandboxBackend,
  createSandboxCodingTools,
} from '../src/agent-runtime-sandbox';
import { mountAgent } from '../src/tools';

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
const options = { toolCallId: 'test', messages: [], context: undefined };
describe.skipIf(probe.status !== 0)('sandbox coding composition', () => {
  test('the maintained profile shares workspace, authorization, command bounds and lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-coding-'));
    const backend = await createBubblewrapSandboxBackend({
      stateDirectory: root,
      maxConcurrentCommands: 1,
      onBrokerError: console.error,
    });
    const template = await backend.prewarm({ template: 'coding' });
    const h = await backend.create({ template: template.templateKey, network: 'deny-all' });
    try {
      const tools = mountAgent([], {
        runtimeTools: createSandboxCodingTools(h, {
          authorize: () => true,
          authorizePath: ({ path }) => path !== 'secret',
          executables: { shell: '/usr/bin/sh', yes: '/usr/bin/yes', sleep: '/usr/bin/sleep' },
          limits: { maxShellOutputBytes: 16, shellTimeoutMs: 30 },
        }),
      });
      const write = tools.write_file?.execute;
      const read = tools.read_file?.execute;
      const run = tools.run_command?.execute;
      if (!write || !read || !run) throw new Error('missing profile tools');
      await write({ path: 'hello', content: 'hello' }, options);
      expect(await h.session.readTextFile('hello')).toBe('hello');
      expect(await read({ path: 'hello' }, options)).toMatchObject({ text: 'hello' });
      await expect(read({ path: 'secret' }, options)).rejects.toThrow();
      expect(await run({ executable: 'shell', args: ['-c', 'pwd'] }, options)).toMatchObject({
        stdout: '/workspace\n',
        outcome: 'exited',
      });
      expect(await run({ executable: 'yes' }, options)).toMatchObject({
        outcome: 'output-limit',
      });
      expect(await run({ executable: 'sleep', args: ['10'] }, options)).toMatchObject({
        outcome: 'timeout',
      });
      const denied = mountAgent([], {
        runtimeTools: createSandboxCodingTools(h, {
          authorize: () => false,
          executables: { shell: '/usr/bin/sh' },
        }),
      }).run_command?.execute;
      if (!denied) throw new Error('missing denied tool');
      await expect(
        denied({ executable: 'shell', args: ['-c', 'touch denied'] }, options),
      ).rejects.toThrow();
      await expect(h.session.readTextFile('denied')).rejects.toThrow();
      const state = h.captureState();
      await h.stop();
      await expect(read({ path: 'hello' }, options)).rejects.toThrow('SANDBOX_UNAVAILABLE');
      const resumed = await backend.create({
        template: template.templateKey,
        state,
        network: 'deny-all',
      });
      try {
        expect(await resumed.session.readTextFile('hello')).toBe('hello');
      } finally {
        await resumed.delete();
      }
    } finally {
      await h.stop();
      await rm(root, { recursive: true, force: true });
    }
  });
  test('coding launches share concurrency admission and reject stale network preparations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-coding-owner-'));
    const backend = await createBubblewrapSandboxBackend({
      stateDirectory: root,
      maxConcurrentCommands: 1,
      onBrokerError: console.error,
    });
    const t = await backend.prewarm({ template: 'owner' });
    const h = await backend.create({ template: t.templateKey, network: 'deny-all' });
    try {
      const binding = h.coding;
      if (!binding?.adapter.spawn) throw new Error('missing binding');
      const prepared = await binding.adapter.prepare({
        executable: '/usr/bin/true',
        args: [],
        cwd: binding.root,
        environment: {},
      });
      await h.session.setNetworkPolicy('allow-all');
      expect(() =>
        binding.adapter.spawn?.({
          ...prepared,
          cwd: binding.root,
          environment: prepared.environment ?? {},
        }),
      ).toThrow('policy changed');
      expect(() =>
        binding.adapter.prepare({
          executable: '/usr/bin/true',
          args: [],
          cwd: binding.root,
          environment: {},
          required: ['network-denied'],
        }),
      ).toThrow();
      await h.session.setNetworkPolicy('deny-all');
      const started = Promise.withResolvers<void>();
      const launch = binding.adapter.spawn;
      binding.adapter.spawn = (input) => {
        const child = launch(input);
        started.resolve();
        return child;
      };
      const run = mountAgent([], {
        runtimeTools: createSandboxCodingTools(h, {
          authorize: () => true,
          executables: { sleep: '/usr/bin/sleep' },
        }),
      }).run_command?.execute;
      if (!run) throw new Error('missing run');
      const pending = run({ executable: 'sleep', args: ['10'] }, options);
      await started.promise;
      await expect(h.session.run({ executable: '/usr/bin/true' })).rejects.toMatchObject({
        code: 'SANDBOX_BUSY',
      });
      await expect(h.session.setNetworkPolicy('allow-all')).rejects.toMatchObject({
        code: 'SANDBOX_BUSY',
      });
      await h.stop();
      expect(await pending).toMatchObject({ signal: 'SIGKILL' });
    } finally {
      await h.delete();
      await rm(root, { recursive: true, force: true });
    }
  });
});
