import { afterEach, expect, test } from 'bun:test';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentCodingToolConfig } from '../src/entrypoints/agent-runtime/coding-tools';
import { createAgentCodingTools } from '../src/entrypoints/agent-runtime/coding-tools';
import { mountAgent } from '../src/entrypoints/tools/agent';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-tree-'));
  roots.push(root);
  return root;
}
function mounted(config: AgentCodingToolConfig) {
  const tools = mountAgent([], { runtimeTools: createAgentCodingTools(config) });
  return async (name: string, input: Record<string, unknown>, signal?: AbortSignal) => {
    const execute = tools[name]?.execute;
    if (!execute) throw new Error(`Missing ${name}`);
    return execute(input, {
      toolCallId: 'tree-review',
      messages: [],
      context: undefined,
      abortSignal: signal,
    });
  };
}

for (const tool of [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'glob',
  'search_files',
  'run_command',
]) {
  for (const callback of tool === 'run_command' ? ['operation'] : ['path', 'operation']) {
    test(`${tool} pins root before ${callback} policy for both aliases and concrete roots`, async () => {
      for (const alias of [false, true]) {
        const parent = await workspace();
        const inside = path.join(parent, 'inside');
        const outside = path.join(parent, 'outside');
        const selected = path.join(parent, 'selected');
        await mkdir(inside);
        await mkdir(outside);
        await writeFile(path.join(inside, 'file.txt'), 'inside-needle');
        await writeFile(path.join(outside, 'file.txt'), 'outside-needle');
        await writeFile(path.join(outside, 'outside.txt'), 'outside-needle');
        const root = alias ? path.join(parent, 'alias') : inside;
        if (alias) await symlink(inside, root);
        let swapped = false;
        const swap = async () => {
          if (swapped) return true;
          swapped = true;
          if (alias) await rm(root);
          else await rename(inside, selected);
          await symlink(outside, root);
          return true;
        };
        const run = mounted({
          root,
          executables: { pwd: '/bin/pwd' },
          authorize: callback === 'operation' ? swap : () => true,
          authorizePath: callback === 'path' ? swap : () => true,
        });
        const args =
          tool === 'read_file'
            ? { path: 'file.txt' }
            : tool === 'write_file'
              ? { path: 'file.txt', content: 'changed', overwrite: true }
              : tool === 'edit_file'
                ? { path: 'file.txt', oldText: 'inside-needle', newText: 'changed' }
                : tool === 'glob'
                  ? { pattern: '**' }
                  : tool === 'search_files'
                    ? { query: 'needle' }
                    : tool === 'run_command'
                      ? { executable: 'pwd', args: [] }
                      : {};
        const result = await run(tool, args);
        expect(swapped).toBe(true);
        expect(JSON.stringify(result)).not.toContain('outside');
        expect(await readFile(path.join(outside, 'file.txt'), 'utf8')).toBe('outside-needle');
        if (tool === 'read_file') expect(result.text).toBe('inside-needle');
        if (tool === 'write_file' || tool === 'edit_file')
          expect(
            await readFile(path.join(alias ? inside : selected, 'file.txt'), 'utf8'),
          ).toBe('changed');
        if (tool === 'run_command')
          expect(result.stdout.trim()).toBe(alias ? inside : selected);
      }
    });
  }
}

for (const tool of ['list_directory', 'glob']) {
  test(`${tool} bounds raw enumeration, policy work and serialized output`, async () => {
    const root = await workspace();
    for (let i = 0; i < 12; i++) {
      await mkdir(path.join(root, `dir-${i}`));
      await writeFile(path.join(root, `file-${i}.txt`), 'x');
    }
    let policies = 0;
    const run = mounted({
      root,
      authorize: () => true,
      authorizePath: () => {
        policies++;
        return true;
      },
      limits: { maxSearchEntries: 1, maxSearchDirectories: 1, maxListEntries: 1 },
    });
    const result = await run(tool, tool === 'glob' ? { pattern: '**' } : {});
    expect(result.coverage.visitedEntries).toBe(1);
    expect(result.coverage.visitedDirectories).toBe(1);
    expect(result.coverage.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(policies).toBeLessThanOrEqual(2);
    const wide = await workspace();
    for (let i = 0; i < 40; i++)
      await writeFile(path.join(wide, `${i}-${'x'.repeat(180)}`), 'x');
    const bounded = await mounted({
      root: wide,
      authorize: () => true,
      limits: { maxSearchOutputBytes: 1024 },
    })(tool, tool === 'glob' ? { pattern: '**' } : {});
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(1024);
    expect(bounded.coverage.reasons).toContain('max-output-bytes');
  });
  test(`${tool} releases a stalled policy on cancellation and timeout`, async () => {
    for (const timeout of [false, true]) {
      const root = await workspace();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<boolean>();
      const abort = new AbortController();
      const run = mounted({
        root,
        authorize: () => {
          entered.resolve();
          return release.promise;
        },
        limits: { searchTimeoutMs: timeout ? 20 : 1000 },
      });
      const pending = run(tool, tool === 'glob' ? { pattern: '**' } : {}, abort.signal);
      await entered.promise;
      if (!timeout) abort.abort();
      try {
        const result = await Promise.race([
          pending,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('policy did not stop')), 300),
          ),
        ]);
        expect(result.coverage.reasons).toContain(timeout ? 'timeout' : 'cancelled');
        expect(result.coverage.complete).toBe(false);
      } finally {
        release.resolve(true);
        await pending;
      }
    }
  });
}

test('mounted glob enforces its CPU deadline and rejects oversized patterns before policy', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'a'.repeat(200)), 'x');
  const run = mounted({ root, authorize: () => true, limits: { searchTimeoutMs: 5 } });
  const result = await run('glob', { pattern: '*a'.repeat(2000) });
  expect(result.coverage.reasons).toContain('timeout');
  let called = false;
  const bounded = mounted({
    root,
    authorize: () => {
      called = true;
      return true;
    },
  });
  await expect(bounded('glob', { pattern: '*'.repeat(4097) })).rejects.toMatchObject({
    output: { error: 'VALIDATION_ERROR' },
  });
  expect(called).toBe(false);
});

for (const tool of ['list_directory', 'glob'])
  test(`${tool} charges canonical spelling enumeration to the same entry budget`, async () => {
    const root = await workspace();
    for (const name of ['plain', 'foo', 'FOO']) await mkdir(path.join(root, name));
    for (let i = 0; i < 16; i++) await writeFile(path.join(root, `noise-${i}`), 'x');
    const run = mounted({
      root,
      authorize: () => true,
      limits: { maxSearchEntries: 1, maxSearchDirectories: 10 },
    });
    const control = await run(
      tool,
      tool === 'glob' ? { path: 'plain', pattern: '**' } : { path: 'plain' },
    );
    expect(control.coverage.complete).toBe(true);
    expect(control.coverage.visitedEntries).toBe(0);
    const folded = await run(
      tool,
      tool === 'glob' ? { path: 'foo', pattern: '**' } : { path: 'foo' },
    );
    expect(folded.coverage.visitedEntries).toBe(1);
    expect(folded.coverage.complete).toBe(false);
    expect(folded.coverage.reasons).toContain('max-entries');
  });

for (const tool of ['list_directory', 'glob'])
  test(`${tool} returns measured cancellation before entering host policy`, async () => {
    const root = await workspace();
    let called = false;
    const abort = new AbortController();
    abort.abort();
    const result = await mounted({
      root,
      authorize: () => {
        called = true;
        return true;
      },
    })(tool, tool === 'glob' ? { pattern: '**' } : {}, abort.signal);
    expect(called).toBe(false);
    expect(result.coverage.reasons).toContain('cancelled');
    expect(result.coverage.visitedDirectories).toBe(0);
  });

test('search timeout uses the canonical timer ceiling while native entry counts keep their own range', async () => {
  const { AgentCodingToolLimitsSchema } = await import(
    '../src/entrypoints/agent-runtime/coding-tools'
  );
  const { MAX_TIMER_MS } = await import('../src/internal/timers');
  const { searchTimeoutMs, maxSearchEntries } = AgentCodingToolLimitsSchema.shape;
  expect(searchTimeoutMs.safeParse(MAX_TIMER_MS).success).toBe(true);
  expect(searchTimeoutMs.safeParse(MAX_TIMER_MS + 1).success).toBe(false);
  expect(maxSearchEntries.safeParse(0x7fffffff).success).toBe(true);
  expect(maxSearchEntries.safeParse(0x80000000).success).toBe(false);
});

for (const tool of ['list_directory', 'glob'])
  test(`${tool} starts no later ancestor policy after cancellation`, async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'a', 'b'), { recursive: true });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const abort = new AbortController();
    const calls: string[] = [];
    const run = mounted({
      root,
      authorize: () => true,
      authorizePath: ({ path: relative }) => {
        calls.push(relative);
        if (relative === 'a') {
          entered.resolve();
          return release.promise;
        }
        return true;
      },
    });
    const pending = run(
      tool,
      tool === 'glob' ? { path: 'a/b', pattern: '**' } : { path: 'a/b' },
      abort.signal,
    );
    try {
      await entered.promise;
      abort.abort();
      const result = await pending;
      expect(result.coverage.reasons).toContain('cancelled');
      expect(calls).toEqual(['a']);
      release.resolve(true);
      await Bun.sleep(1);
      expect(calls).toEqual(['a']);
    } finally {
      release.resolve(true);
      await pending;
    }
  });

test('native boundary model exhausts observed spelling entries even when stat drops deleted names', () => {
  const fixture = path.join(import.meta.dir, 'fixtures/contained-spelling-budget.ts');
  const result = Bun.spawnSync([process.execPath, fixture], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 2000,
  });
  expect(result.exitCode).toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toBe('');
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    observed: 1,
    reasons: ['max-entries'],
  });
});

test('directory arguments that cannot be opened refuse in words, never as a server fault', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'sub'));
  await writeFile(path.join(root, 'file.txt'), 'x');
  await symlink(path.join(root, 'sub'), path.join(root, 'link'));
  const run = mounted({ root, executables: { pwd: '/bin/pwd' }, authorize: () => true });
  const refusal = async (name: string, input: Record<string, unknown>) => {
    try {
      await run(name, input);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error(`${name} accepted ${JSON.stringify(input)}`);
  };
  const cases: [tool: string, input: Record<string, unknown>, code: string, says: string][] = [
    ['glob', { pattern: '**', path: 'missing' }, 'NOT_FOUND', 'does not exist'],
    ['glob', { pattern: '**', path: 'file.txt' }, 'BAD_REQUEST', 'not a directory'],
    ['glob', { pattern: '**', path: 'link' }, 'BAD_REQUEST', 'symlinks are not followed'],
    ['list_directory', { path: 'link' }, 'BAD_REQUEST', 'symlinks are not followed'],
    [
      'run_command',
      { executable: 'pwd', args: [], cwd: 'link' },
      'BAD_REQUEST',
      'symlinks are not followed',
    ],
    [
      'run_command',
      { executable: 'pwd', args: [], cwd: 'missing' },
      'NOT_FOUND',
      'does not exist',
    ],
    [
      'run_command',
      { executable: 'pwd', args: [], cwd: 'file.txt' },
      'BAD_REQUEST',
      'not a directory',
    ],
  ];
  for (const [tool, input, code, says] of cases) {
    const envelope = await refusal(tool, input);
    expect({ tool, input, envelope }).toMatchObject({
      envelope: expect.stringContaining(`"${code}"`),
    });
    expect(envelope).toContain(says);
    expect(envelope).not.toContain('INTERNAL_SERVER_ERROR');
  }
  expect(
    (await run('run_command', { executable: 'pwd', args: [], cwd: 'sub' })).stdout.trim(),
  ).toBe(path.join(root, 'sub'));
});

test('run_command keeps a pathname working directory where contained descriptors do not exist', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'sub'));
  const run = mounted({ root, executables: { pwd: '/bin/pwd' }, authorize: () => true });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  // Only the working-directory choice reads the platform here; the launcher is the real one.
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    expect(
      (await run('run_command', { executable: 'pwd', args: [], cwd: 'sub' })).stdout.trim(),
    ).toBe(path.join(root, 'sub'));
    await expect(
      run('run_command', { executable: 'pwd', args: [], cwd: 'missing' }),
    ).rejects.toThrow('does not exist');
    await symlink(path.join(root, 'sub'), path.join(root, 'alias'));
    await symlink(tmpdir(), path.join(root, 'out'));
    await expect(
      run('run_command', { executable: 'pwd', args: [], cwd: 'out' }),
    ).rejects.toThrow('symlinks are not followed');
    await expect(
      run('run_command', { executable: 'pwd', args: [], cwd: 'alias' }),
    ).rejects.toThrow('symlinks are not followed');
    // A policy that swaps the directory for a link outside is caught before launch.
    const outside = await workspace();
    let swapped = false;
    const swapping = mounted({
      root,
      executables: { pwd: '/bin/pwd' },
      authorize: async () => {
        if (!swapped) {
          swapped = true;
          await rename(path.join(root, 'sub'), path.join(root, 'sub-old'));
          await symlink(outside, path.join(root, 'sub'));
        }
        return true;
      },
    });
    await expect(
      swapping('run_command', { executable: 'pwd', args: [], cwd: 'sub' }),
    ).rejects.toThrow('CONFLICT');
    expect(swapped).toBe(true);
  } finally {
    if (platform) Object.defineProperty(process, 'platform', platform);
  }
});

test.if(process.platform === 'linux' || process.platform === 'darwin')(
  'run_command enters the pinned directory within a short budget; Linux starts no guard process',
  async () => {
    const root = await workspace();
    const outside = await workspace();
    await mkdir(path.join(root, 'sub'));
    let swapped = false;
    const run = mounted({
      root,
      executables: { sh: '/bin/sh' },
      limits: { shellTimeoutMs: 40 },
      authorize: async () => {
        if (!swapped) {
          swapped = true;
          await rename(path.join(root, 'sub'), path.join(root, 'sub-old'));
          await symlink(outside, path.join(root, 'sub'));
        }
        return true;
      },
    });
    const result = await run('run_command', {
      executable: 'sh',
      args: ['-c', 'echo "$PPID"; pwd -P'],
      cwd: 'sub',
    });
    expect(swapped).toBe(true);
    // The 40 ms budget is the command's own: a guard's start (macOS) does not use it.
    expect(result.outcome).toBe('exited');
    const [parent, directory] = result.stdout.trim().split('\n');
    expect(directory).toBe(await realpath(path.join(root, 'sub-old')));
    if (process.platform === 'linux') expect(parent).toBe(String(process.pid));
  },
);
