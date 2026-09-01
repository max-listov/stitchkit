import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { ShellOutputSchema } from '../src/agent-runtime/coding-tool-contract';
import {
  type AgentCodingToolAuthorization,
  createAgentCodingTools,
} from '../src/agent-runtime-coding-tools';
import { mountAgent } from '../src/tools';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function executable(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`descendant process ${pid} remained alive`);
}

describe('host-authorized Agent coding tools', () => {
  test('searches bounded content and applies one digest-guarded atomic patch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-patch-'));
    roots.push(root);
    await writeFile(path.join(root, 'source.txt'), 'alpha\nbeta\n');
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });
    const options = { toolCallId: 'patch', messages: [], context: undefined };
    expect(
      await executable(tools, 'search_files')({ query: 'beta', mode: 'content' }, options),
    ).toEqual({
      matches: [{ path: 'source.txt', line: 2, text: 'beta' }],
      truncated: false,
      scannedFiles: 1,
      skippedDirectories: 0,
      skippedSymlinks: 0,
    });
    const baseSha256 = createHash('sha256').update('alpha\nbeta\n').digest('hex');
    const dryRun = await executable(tools, 'edit_file')(
      {
        path: 'source.txt',
        expectedSha256: baseSha256,
        oldText: 'beta',
        newText: 'gamma',
        dryRun: true,
      },
      options,
    );
    expect(dryRun).toMatchObject({ path: 'source.txt', applied: false, replacements: 1 });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\nbeta\n');
    expect(
      await executable(tools, 'edit_file')(
        {
          path: 'source.txt',
          expectedSha256: baseSha256,
          oldText: 'beta',
          newText: 'gamma',
          dryRun: false,
        },
        options,
      ),
    ).toMatchObject({ path: 'source.txt', applied: true, replacements: 1 });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\ngamma\n');
    const originalError = console.error;
    console.error = () => undefined;
    const stale = executable(tools, 'edit_file')(
      {
        path: 'source.txt',
        expectedSha256: baseSha256,
        oldText: 'gamma',
        newText: 'stale',
        dryRun: false,
      },
      options,
    );
    console.error = originalError;
    await expect(stale).rejects.toMatchObject({ output: { error: 'CONFLICT' } });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\ngamma\n');
  });

  test('searches an installed workspace without following dependency symlinks or runtime state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-search-'));
    roots.push(root);
    await mkdir(path.join(root, 'node_modules', '.bin'), { recursive: true });
    await mkdir(path.join(root, '.stitchkit'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(path.join(root, '.stitchkit', 'agent.sqlite'), 'not utf-8: \xff');
    await symlink('/usr/bin/printf', path.join(root, 'node_modules', '.bin', 'printf'));
    await symlink('/etc/passwd', path.join(root, 'outside-link'));
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
    });

    await expect(
      executable(tools, 'search_files')(
        { query: 'package.json', mode: 'path' },
        { toolCallId: 'search', messages: [], context: undefined },
      ),
    ).resolves.toEqual({
      matches: [{ path: 'package.json' }],
      truncated: false,
      scannedFiles: 1,
      skippedDirectories: 2,
      skippedSymlinks: 1,
    });
  });

  test('omits command execution when the host declares no executable aliases', () => {
    const definitions = createAgentCodingTools({ root: '/tmp', authorize: () => true });
    expect(definitions.map(({ name }) => name)).not.toContain('run_command');
  });

  test('serializes exact patch authorization and rejects a concurrent stale base', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-race-'));
    roots.push(root);
    await writeFile(path.join(root, 'source.txt'), 'base');
    const authorizations: AgentCodingToolAuthorization[] = [];
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: (request) => {
          authorizations.push(request);
          return true;
        },
      }),
    });
    const execute = executable(tools, 'edit_file');
    const options = { toolCallId: 'race', messages: [], context: undefined };
    const baseSha256 = createHash('sha256').update('base').digest('hex');
    const originalError = console.error;
    console.error = () => undefined;
    const results = await Promise.allSettled([
      execute(
        {
          path: 'source.txt',
          expectedSha256: baseSha256,
          oldText: 'base',
          newText: 'one',
          dryRun: false,
        },
        options,
      ),
      execute(
        {
          path: 'source.txt',
          expectedSha256: baseSha256,
          oldText: 'base',
          newText: 'two',
          dryRun: false,
        },
        options,
      ),
    ]);
    console.error = originalError;
    expect(
      results.filter((result) => result.status === 'fulfilled' && result.value.applied),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.status === 'rejected' && result.reason?.output?.error === 'CONFLICT',
      ),
    ).toHaveLength(1);
    expect(['one', 'two']).toContain(await readFile(path.join(root, 'source.txt'), 'utf8'));
    const patchAuthorizations = authorizations.filter(
      (request): request is Extract<AgentCodingToolAuthorization, { operation: 'edit' }> =>
        request.operation === 'edit',
    );
    // One, not two: the loser's stale digest is refused inside the lock BEFORE
    // the host is asked. Authorization describes a mutation that will happen,
    // and an edit built on a superseded read never will.
    expect(patchAuthorizations).toHaveLength(1);
    expect(patchAuthorizations.every((request) => request.resultBytes === 3)).toBe(true);
    expect(patchAuthorizations.every((request) => request.resultSha256.length === 64)).toBe(
      true,
    );
  });

  if (process.platform !== 'win32') {
    test('refuses read, new-file write and patch when authorization loses parent identity', async () => {
      const operation = async (kind: 'read' | 'write' | 'edit') => {
        const fixture = await mkdtemp(path.join(tmpdir(), `stitchkit-coding-parent-${kind}-`));
        roots.push(fixture);
        const root = path.join(fixture, 'workspace');
        const nested = path.join(root, 'nested');
        const original = path.join(root, 'original-nested');
        const outside = path.join(fixture, 'outside');
        await mkdir(root);
        await mkdir(nested);
        await mkdir(outside);
        await writeFile(path.join(nested, 'source.txt'), 'inside');
        await writeFile(path.join(outside, 'source.txt'), 'outside');
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const tools = mountAgent([], {
          runtimeTools: createAgentCodingTools({
            root,
            authorize: async () => {
              entered.resolve();
              await release.promise;
              return true;
            },
          }),
        });
        const options = { toolCallId: `parent-${kind}`, messages: [], context: undefined };
        const baseSha256 = createHash('sha256').update('inside').digest('hex');
        const call =
          kind === 'read'
            ? executable(tools, 'read_file')({ path: 'nested/source.txt' }, options)
            : kind === 'write'
              ? executable(tools, 'write_file')(
                  { path: 'nested/new.txt', content: 'escaped', overwrite: false },
                  options,
                )
              : executable(tools, 'edit_file')(
                  {
                    path: 'nested/source.txt',
                    expectedSha256: baseSha256,
                    oldText: 'inside',
                    newText: 'changed',
                    dryRun: false,
                  },
                  options,
                );
        const settled = call.then(
          (value: unknown) => ({ status: 'fulfilled', value }),
          (reason: unknown) => ({ status: 'rejected', reason }),
        );
        await entered.promise;
        await rename(nested, original);
        await symlink(outside, nested, 'dir');
        const originalError = console.error;
        console.error = () => undefined;
        release.resolve();
        const result = await settled;
        console.error = originalError;
        // Fails closed — that is the property. The code is no longer
        // `INTERNAL_SERVER_ERROR` for every one of these: an ordinary outcome now
        // says what it is, and a swapped parent reads as a segment that is not a
        // directory. What must never change is that the refusal happens and that
        // it names nothing outside the workspace.
        expect(result).toMatchObject({ status: 'rejected' });
        expect(String((result as { reason: unknown }).reason)).not.toContain(fixture);
        expect(await readFile(path.join(outside, 'source.txt'), 'utf8')).toBe('outside');
        expect(await readFile(path.join(original, 'source.txt'), 'utf8')).toBe('inside');
        expect(existsSync(path.join(outside, 'new.txt'))).toBeFalse();
        expect(existsSync(path.join(original, 'new.txt'))).toBeFalse();
      };

      await operation('read');
      await operation('write');
      await operation('edit');
    });

    test('search skips a parent replaced by an outside symlink after authorization', async () => {
      const fixture = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-search-parent-'));
      roots.push(fixture);
      const root = path.join(fixture, 'workspace');
      const nested = path.join(root, 'nested');
      const outside = path.join(fixture, 'outside');
      await mkdir(root);
      await mkdir(nested);
      await mkdir(outside);
      await writeFile(path.join(nested, 'inside.txt'), 'inside-only');
      await writeFile(path.join(outside, 'outside.txt'), 'outside-secret');
      const tools = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: async (request) => {
            if (request.operation === 'search') {
              await rename(nested, path.join(root, 'original-nested'));
              await symlink(outside, nested, 'dir');
            }
            return true;
          },
        }),
      });
      const result = await executable(tools, 'search_files')(
        { query: 'outside-secret', mode: 'content' },
        { toolCallId: 'search-parent', messages: [], context: undefined },
      );
      expect(result.matches).toEqual([]);
      expect(result.skippedSymlinks).toBe(1);
    });
  }

  test('preserves large shell output behind an opaque readable artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-artifact-'));
    roots.push(root);
    const artifacts = new Map<string, Uint8Array>();
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf' },
        artifacts: {
          write: ({ data }) => {
            artifacts.set('artifact-1', data);
            return { reference: 'artifact-1' };
          },
          read: ({ reference, offset, maxBytes }) => {
            const data = artifacts.get(reference);
            if (!data) throw new Error('missing artifact');
            return {
              data: data.subarray(offset, offset + maxBytes),
              totalBytes: data.byteLength,
            };
          },
        },
        limits: { maxShellOutputBytes: 8, maxArtifactBytes: 128 },
      }),
    });
    const options = { toolCallId: 'artifact', messages: [], context: undefined };
    const output = await executable(tools, 'run_command')(
      { executable: 'printf', args: ['0123456789abcdef'] },
      options,
    );
    expect(output).toMatchObject({
      stdout: '01234567',
      outcome: 'exited',
      artifact: { reference: 'artifact-1', truncated: false },
    });
    expect(artifacts.get('artifact-1')?.byteLength).toBeLessThanOrEqual(128);
    expect(
      await executable(tools, 'read_output')(
        { reference: 'artifact-1', offset: 0, maxBytes: 64 },
        options,
      ),
    ).toMatchObject({
      reference: 'artifact-1',
      text: expect.stringContaining('0123456789abcdef'),
    });
  });

  test('preserves direct identities across bounded read, write, patch and command calls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-'));
    roots.push(root);
    await writeFile(path.join(root, 'source.txt'), 'alpha beta');
    const authorizations: AgentCodingToolAuthorization[] = [];
    const lifecycle: string[] = [];
    const definitions = createAgentCodingTools({
      root,
      authorize: (request) => {
        authorizations.push(request);
        return true;
      },
      executables: { printf: '/usr/bin/printf' },
      limits: {
        maxReadBytes: 64,
        maxWriteBytes: 64,
        maxShellOutputBytes: 64,
      },
    });
    const tools = mountAgent([], {
      runtimeTools: definitions,
      lifecycle: {
        beforeHandle: (_context, operation) => {
          if (!operation.toolName) throw new Error('expected direct coding tool identity');
          lifecycle.push(operation.toolName);
        },
      },
    });
    const options = { toolCallId: 'coding', messages: [], context: undefined };

    expect(
      await executable(tools, 'read_file')({ path: 'source.txt', maxBytes: 5 }, options),
    ).toEqual({
      path: 'source.txt',
      text: 'alpha',
      bytes: 5,
      sha256: createHash('sha256').update('alpha beta').digest('hex'),
      truncated: true,
      nextOffset: 5,
    });
    expect(
      await executable(tools, 'write_file')(
        { path: 'created.txt', content: 'one two' },
        options,
      ),
    ).toEqual({ path: 'created.txt', bytes: 7, createdDirectories: [] });
    expect(
      await executable(tools, 'edit_file')(
        {
          path: 'created.txt',
          expectedSha256: createHash('sha256').update('one two').digest('hex'),
          oldText: 'two',
          newText: 'three',
          dryRun: false,
        },
        options,
      ),
    ).toMatchObject({ path: 'created.txt', replacements: 1, bytes: 9, applied: true });
    expect(await readFile(path.join(root, 'created.txt'), 'utf8')).toBe('one three');
    expect(
      await executable(tools, 'run_command')(
        { executable: 'printf', args: ['shell-ok'] },
        options,
      ),
    ).toEqual({
      executable: 'printf',
      exitCode: 0,
      signal: null,
      stdout: 'shell-ok',
      stderr: '',
      outcome: 'exited',
    });

    expect(lifecycle).toEqual(['read_file', 'write_file', 'edit_file', 'run_command']);
    expect(authorizations.map(({ operation }) => operation)).toEqual([
      'read',
      'write',
      'edit',
      'shell',
    ]);
  });

  test('fails closed on denied operations, path escapes and symlink escapes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-root-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-outside-'));
    roots.push(root, outside);
    await writeFile(path.join(root, 'denied.txt'), 'unchanged');
    await writeFile(path.join(outside, 'secret.txt'), 'outside');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: (request) => request.operation === 'read',
      }),
    });
    const options = { toolCallId: 'denied', messages: [], context: undefined };
    const originalError = console.error;
    console.error = () => undefined;
    await expect(
      executable(tools, 'write_file')(
        { path: 'denied.txt', content: 'changed', overwrite: true },
        options,
      ),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    // Both escapes are still refused, and now they say so. An empty server
    // fault taught a model nothing about the one boundary it must learn.
    await expect(
      executable(tools, 'read_file')({ path: '../outside.txt' }, options),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    await expect(
      executable(tools, 'read_file')({ path: 'escape.txt' }, options),
    ).rejects.toMatchObject({ output: { error: 'FORBIDDEN' } });
    console.error = originalError;
    expect(await readFile(path.join(root, 'denied.txt'), 'utf8')).toBe('unchanged');
  });

  test('bounds shell output, timeout and cancellation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-shell-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf', sleep: '/usr/bin/sleep' },
        limits: { maxShellOutputBytes: 8, shellTimeoutMs: 20 },
      }),
    });
    const options = { toolCallId: 'shell', messages: [], context: undefined };
    const limited = await executable(tools, 'run_command')(
      { executable: 'printf', args: ['0123456789abcdef'] },
      options,
    );
    expect(limited).toMatchObject({
      executable: 'printf',
      stdout: '01234567',
      outcome: 'output-limit',
    });
    const timedOut = await executable(tools, 'run_command')(
      { executable: 'sleep', args: ['1'] },
      options,
    );
    expect(timedOut).toMatchObject({ executable: 'sleep', outcome: 'timeout' });

    const controller = new AbortController();
    const cancelled = executable(tools, 'run_command')(
      { executable: 'sleep', args: ['1'] },
      {
        toolCallId: 'cancelled',
        messages: [],
        context: undefined,
        abortSignal: controller.signal,
      },
    );
    controller.abort();
    expect(await cancelled).toMatchObject({ executable: 'sleep', outcome: 'cancelled' });
  });

  test('does not spawn a command for a pre-aborted invocation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-pre-abort-'));
    roots.push(root);
    const marker = path.join(root, 'spawned.txt');
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { bash: '/bin/bash' },
      }),
    });
    const controller = new AbortController();
    controller.abort();
    const result = await executable(tools, 'run_command')(
      { executable: 'bash', args: ['-c', 'printf spawned > "$1"', '--', marker] },
      {
        toolCallId: 'pre-aborted',
        messages: [],
        context: undefined,
        abortSignal: controller.signal,
      },
    );
    expect(result).toMatchObject({ executable: 'bash', outcome: 'cancelled' });
    expect(existsSync(marker)).toBeFalse();

    const brokenTools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { missing: path.join(root, 'missing-executable') },
        limits: { shellTimeoutMs: 20, shellTerminationGraceMs: 20 },
      }),
    });
    const originalError = console.error;
    console.error = () => undefined;
    const failedAt = performance.now();
    await expect(
      executable(brokenTools, 'run_command')(
        { executable: 'missing', args: [] },
        { toolCallId: 'spawn-error', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });
    console.error = originalError;
    expect(performance.now() - failedAt).toBeLessThan(500);
  });

  if (process.platform !== 'win32') {
    test('kills owned descendants and bounds retained pipes on exit, timeout, abort and output limit', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-process-group-'));
      roots.push(root);
      const tools = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: () => true,
          executables: { bash: '/bin/bash' },
          limits: {
            maxShellOutputBytes: 64,
            shellTimeoutMs: 40,
            shellTerminationGraceMs: 80,
          },
        }),
      });
      const options = { toolCallId: 'process-group', messages: [], context: undefined };

      const startedAt = performance.now();
      const timedOut = ShellOutputSchema.parse(
        await executable(tools, 'run_command')(
          { executable: 'bash', args: ['-c', 'sleep 10 & echo $!; wait'] },
          options,
        ),
      );
      expect(performance.now() - startedAt).toBeLessThan(500);
      expect(timedOut).toMatchObject({ executable: 'bash', outcome: 'timeout' });
      const timeoutPid = Number(timedOut.stdout.trim());
      expect(Number.isSafeInteger(timeoutPid)).toBeTrue();
      await expectProcessGone(timeoutPid);

      const controller = new AbortController();
      const abortStartedAt = performance.now();
      const cancelled = executable(tools, 'run_command')(
        { executable: 'bash', args: ['-c', 'sleep 10 & echo $!; wait'] },
        {
          toolCallId: 'process-group-abort',
          messages: [],
          context: undefined,
          abortSignal: controller.signal,
        },
      );
      setTimeout(() => controller.abort(), 20);
      const cancelledResult = ShellOutputSchema.parse(await cancelled);
      expect(performance.now() - abortStartedAt).toBeLessThan(500);
      expect(cancelledResult).toMatchObject({ executable: 'bash', outcome: 'cancelled' });
      const cancelledPid = Number(cancelledResult.stdout.trim());
      expect(Number.isSafeInteger(cancelledPid)).toBeTrue();
      await expectProcessGone(cancelledPid);

      const exitedAt = performance.now();
      const exited = ShellOutputSchema.parse(
        await executable(tools, 'run_command')(
          { executable: 'bash', args: ['-c', 'sleep 10 & echo $!'] },
          options,
        ),
      );
      expect(performance.now() - exitedAt).toBeLessThan(500);
      expect(exited).toMatchObject({ executable: 'bash', outcome: 'exited', exitCode: 0 });
      const exitedPid = Number(exited.stdout.trim());
      expect(Number.isSafeInteger(exitedPid)).toBeTrue();
      await expectProcessGone(exitedPid);

      const limitedTools = mountAgent([], {
        runtimeTools: createAgentCodingTools({
          root,
          authorize: () => true,
          executables: { bash: '/bin/bash' },
          limits: {
            maxShellOutputBytes: 4,
            shellTimeoutMs: 2_000,
            shellTerminationGraceMs: 80,
          },
        }),
      });
      const limitedAt = performance.now();
      const limited = ShellOutputSchema.parse(
        await executable(limitedTools, 'run_command')(
          { executable: 'bash', args: ['-c', 'printf 12345; sleep 10 & wait'] },
          options,
        ),
      );
      expect(performance.now() - limitedAt).toBeLessThan(500);
      expect(limited).toMatchObject({ executable: 'bash', outcome: 'output-limit' });
    });
  }

  test('rejects shell arguments whose aggregate encoding exceeds its byte budget', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-coding-args-'));
    roots.push(root);
    const tools = mountAgent([], {
      runtimeTools: createAgentCodingTools({
        root,
        authorize: () => true,
        executables: { printf: '/usr/bin/printf' },
        limits: { maxShellArgumentBytes: 4 },
      }),
    });
    const originalError = console.error;
    console.error = () => undefined;
    await expect(
      executable(tools, 'run_command')(
        { executable: 'printf', args: ['12345'] },
        { toolCallId: 'args', messages: [], context: undefined },
      ),
    ).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });
    console.error = originalError;
  });
});
