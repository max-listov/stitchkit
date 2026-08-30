import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolSet } from 'ai';
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
      matches: [{ path: 'source.txt', line: 2 }],
      truncated: false,
      scannedFiles: 1,
      skippedDirectories: 0,
      skippedSymlinks: 0,
    });
    const baseSha256 = createHash('sha256').update('alpha\nbeta\n').digest('hex');
    const dryRun = await executable(tools, 'apply_patch')(
      {
        path: 'source.txt',
        baseSha256,
        oldText: 'beta',
        newText: 'gamma',
        dryRun: true,
      },
      options,
    );
    expect(dryRun).toMatchObject({ path: 'source.txt', applied: false, replacements: 1 });
    expect(await readFile(path.join(root, 'source.txt'), 'utf8')).toBe('alpha\nbeta\n');
    expect(
      await executable(tools, 'apply_patch')(
        {
          path: 'source.txt',
          baseSha256,
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
    const stale = await executable(tools, 'apply_patch')(
      {
        path: 'source.txt',
        baseSha256,
        oldText: 'gamma',
        newText: 'stale',
        dryRun: false,
      },
      options,
    );
    console.error = originalError;
    expect(stale).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
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
    const execute = executable(tools, 'apply_patch');
    const options = { toolCallId: 'race', messages: [], context: undefined };
    const baseSha256 = createHash('sha256').update('base').digest('hex');
    const originalError = console.error;
    console.error = () => undefined;
    const results = await Promise.all([
      execute(
        { path: 'source.txt', baseSha256, oldText: 'base', newText: 'one', dryRun: false },
        options,
      ),
      execute(
        { path: 'source.txt', baseSha256, oldText: 'base', newText: 'two', dryRun: false },
        options,
      ),
    ]);
    console.error = originalError;
    expect(results.filter((result) => 'applied' in result && result.applied)).toHaveLength(1);
    expect(results.filter((result) => 'error' in result)).toHaveLength(1);
    expect(['one', 'two']).toContain(await readFile(path.join(root, 'source.txt'), 'utf8'));
    const patchAuthorizations = authorizations.filter(
      (request): request is Extract<AgentCodingToolAuthorization, { operation: 'patch' }> =>
        request.operation === 'patch',
    );
    expect(patchAuthorizations).toHaveLength(2);
    expect(patchAuthorizations.every((request) => request.resultBytes === 3)).toBe(true);
    expect(patchAuthorizations.every((request) => request.resultSha256.length === 64)).toBe(
      true,
    );
  });

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
    ).toEqual({ path: 'created.txt', bytes: 7 });
    expect(
      await executable(tools, 'apply_patch')(
        {
          path: 'created.txt',
          baseSha256: createHash('sha256').update('one two').digest('hex'),
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

    expect(lifecycle).toEqual(['read_file', 'write_file', 'apply_patch', 'run_command']);
    expect(authorizations.map(({ operation }) => operation)).toEqual([
      'read',
      'write',
      'patch',
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
    const denied = await executable(tools, 'write_file')(
      { path: 'denied.txt', content: 'changed', overwrite: true },
      options,
    );
    const traversal = await executable(tools, 'read_file')(
      { path: '../outside.txt' },
      options,
    );
    const symlinkEscape = await executable(tools, 'read_file')(
      { path: 'escape.txt' },
      options,
    );
    console.error = originalError;

    expect(denied).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(traversal).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(symlinkEscape).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
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
    const result = await executable(tools, 'run_command')(
      { executable: 'printf', args: ['12345'] },
      { toolCallId: 'args', messages: [], context: undefined },
    );
    console.error = originalError;
    expect(result).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
  });
});
