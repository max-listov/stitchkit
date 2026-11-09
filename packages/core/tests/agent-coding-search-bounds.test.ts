import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolSet } from 'ai';
import { SearchOutputSchema } from '../src/agent-runtime/coding-search-contract';
import { scanContainedFiles, walkContainedFiles } from '../src/agent-runtime/contained-scan';
import { ContainedScanBudget } from '../src/agent-runtime/contained-scan-budget';
import type { ScanStopReason } from '../src/agent-runtime/contained-scan-contract';
import {
  type AgentCodingToolLimits,
  createAgentCodingTools,
} from '../src/entrypoints/agent-runtime/coding-tools';
import { mountAgent } from '../src/entrypoints/tools/agent';
import { openPinnedDirectory } from '../src/internal/contained-directory';
import { listAt } from '../src/internal/contained-files';
import type { ContainedFileHandle } from '../src/internal/contained-handle';
import { readContainedUtf8Handle } from '../src/internal/contained-read';
import { searchWorkspace } from './support/coding-search';
import { reapAfterEachTest, trackPidFile } from './support/process-reaper';

reapAfterEachTest();
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-search-bounds-'));
  roots.push(root);
  return root;
}
function tool(tools: ToolSet, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`Missing ${name}`);
  return execute;
}
test('narrow search prunes unrelated branches before authorization or opening', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'docs'));
  await writeFile(path.join(root, 'docs', 'match.md'), 'needle');
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      mkdir(path.join(root, 'aaa-unrelated', `${index}`, 'deep'), { recursive: true }),
    ),
  );
  await mkdir(path.join(root, 'unreadable'));
  await chmod(path.join(root, 'unreadable'), 0);
  const asked: string[] = [];
  const result = await searchWorkspace({
    root,
    authorize: () => true,
    authorizePath: ({ path: candidate }) => {
      asked.push(candidate);
      return true;
    },
    limits: { maxSearchDirectories: 2 },
  })({ query: 'needle', include: 'docs/**' });
  expect(result.matches).toEqual([{ path: 'docs/match.md', line: 1, text: 'needle' }]);
  expect(result.coverage).toMatchObject({
    complete: true,
    visitedDirectories: 2,
    readBytes: 6,
  });
  expect(result.skippedDirectories).toBe(2);
  expect(asked).toEqual(['.', 'docs', 'docs/match.md']);
  await chmod(path.join(root, 'unreadable'), 0o755);
});

test('each search traversal limit changes coverage and bounded work', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'nested'));
  await writeFile(path.join(root, 'nested', 'c.txt'), 'xxx');
  await writeFile(path.join(root, 'a.txt'), 'xxx');
  await writeFile(path.join(root, 'b.txt'), 'xxx');
  const cases: { limits: Partial<AgentCodingToolLimits>; reason: ScanStopReason }[] = [
    { limits: { maxSearchDirectories: 1 }, reason: 'max-directories' },
    { limits: { maxSearchEntries: 1 }, reason: 'max-entries' },
    { limits: { maxSearchBytes: 3 }, reason: 'max-bytes' },
    { limits: { maxSearchFiles: 1 }, reason: 'max-files' },
    { limits: { maxSearchDepth: 0 }, reason: 'max-depth' },
    { limits: { maxReadBytes: 2 }, reason: 'max-file-bytes' },
  ];
  for (const { limits, reason } of cases) {
    const result = await searchWorkspace({ root, authorize: () => true, limits })();
    expect(result.matches).toEqual([]);
    expect(result.truncated).toBe(true);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.reasons).toContain(reason);
    if (limits.maxSearchBytes)
      expect(result.coverage.readBytes).toBeLessThanOrEqual(limits.maxSearchBytes);
    if (limits.maxSearchEntries)
      expect(result.coverage.visitedEntries).toBeLessThanOrEqual(limits.maxSearchEntries);
    if (limits.maxSearchDirectories)
      expect(result.coverage.visitedDirectories).toBeLessThanOrEqual(
        limits.maxSearchDirectories,
      );
    if (limits.maxReadBytes) expect(result.coverage.readBytes).toBe(0);
  }
  const complete = await searchWorkspace({ root, authorize: () => true })();
  expect(complete).toMatchObject({
    matches: [],
    truncated: false,
    coverage: { complete: true, reasons: [] },
  });
});

test('result cap stops before reading the next file and path mode reads no content', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'a.txt'), 'needle\nneedle');
  await writeFile(path.join(root, 'b.txt'), 'needle');
  const result = await searchWorkspace({
    root,
    authorize: () => true,
    limits: { maxSearchResults: 1 },
  })();
  expect(result.matches).toHaveLength(1);
  expect(result.scannedFiles).toBe(1);
  expect(result.coverage).toMatchObject({ readBytes: 13, reasons: ['max-results'] });
  const paths = await searchWorkspace({ root, authorize: () => true })({
    query: '.txt',
    mode: 'path',
  });
  expect(paths.matches).toHaveLength(2);
  expect(paths.coverage).toMatchObject({ readBytes: 0, complete: true });
});

test('search cancellation and deadlines release asynchronous host authorization', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'a.txt'), 'needle');
  let calls = 0;
  const result = await searchWorkspace({
    root,
    authorize: () => {
      calls += 1;
      return true;
    },
  })({ query: 'needle' }, AbortSignal.abort('private-reason'));
  expect(result.coverage).toMatchObject({
    reasons: ['cancelled'],
    visitedDirectories: 0,
    readBytes: 0,
  });
  expect(calls).toBe(0);
  const abort = new AbortController();
  const during = searchWorkspace({
    root,
    authorize: () => true,
    authorizePath: ({ path: candidate }) => {
      if (candidate === 'a.txt') {
        abort.abort('private-reason');
        return new Promise<boolean>(() => {
          /* The host never settles this authorization. */
        });
      }
      return true;
    },
  })({ query: 'needle' }, abort.signal);
  expect((await during).coverage).toMatchObject({ reasons: ['cancelled'], readBytes: 0 });
  const timed = await searchWorkspace({
    root,
    authorize: () =>
      new Promise<boolean>(() => {
        /* A deliberately stalled host policy. */
      }),
    limits: { searchTimeoutMs: 10 },
  })();
  expect(timed.coverage.reasons).toEqual(['timeout']);
  expect(timed.coverage.elapsedMs).toBeLessThan(500);
  expect(JSON.stringify(result)).not.toContain('private-reason');
});

test('serialized search budget covers escaped matches, large context and diagnostics', async () => {
  const root = await workspace();
  await writeFile(
    path.join(root, 'large-context.txt'),
    `${'\0'.repeat(500)}\nneedle\n${'😀'.repeat(500)}`,
  );
  const config = { root, authorize: () => true, limits: { maxSearchOutputBytes: 1_024 } };
  const result = await searchWorkspace(config)({ query: 'needle', context: 1 });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1_024);
  expect(result.coverage.reasons).toContain('max-output-bytes');
  for (let index = 0; index < 20; index += 1)
    await writeFile(path.join(root, `${index}-${'😀'.repeat(25)}.txt`), 'needle');
  const denied = await searchWorkspace({
    ...config,
    authorizePath: ({ path: candidate }) => candidate === '.',
  })();
  expect(Buffer.byteLength(JSON.stringify(denied))).toBeLessThanOrEqual(1_024);
  expect(denied.deniedTruncated).toBe(true);
  expect(denied.coverage.reasons).toContain('denied');
  let asked = false;
  await expect(
    searchWorkspace({
      ...config,
      authorize: () => {
        asked = true;
        return true;
      },
    })({ query: 'needle', include: '\n'.repeat(4_096) }),
  ).rejects.toMatchObject({ output: { error: 'BAD_REQUEST' } });
  expect(asked).toBe(false);
});

test('failed decoding consumes the shared read budget and long lines report incomplete coverage', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'a.bin'), Buffer.from([255, 255, 255]));
  await writeFile(path.join(root, 'b.txt'), 'needle');
  const invalid = await searchWorkspace({
    root,
    authorize: () => true,
    limits: { maxSearchBytes: 3 },
  })();
  expect(invalid.coverage.readBytes).toBe(3);
  expect(invalid.coverage.reasons).toEqual(
    expect.arrayContaining(['unreadable', 'max-bytes']),
  );
  expect(invalid.errors?.[0]).toMatchObject({ path: 'a.bin', operation: 'read-file' });
  await writeFile(path.join(root, 'long.txt'), 'n'.repeat(9_000));
  const long = await searchWorkspace({ root, authorize: () => true })({
    query: 'n',
    include: 'long.txt',
  });
  expect(long.coverage.reasons).toContain('max-line-bytes');
});

test('search regex runs repetition linearly and refuses backreferences before authorization', async () => {
  const root = await workspace();
  let called = false;
  const run = searchWorkspace({
    root,
    authorize: () => {
      called = true;
      return true;
    },
  });
  for (const query of ['(a)\\1', '(?<name>a)\\k<name>', 'a(?=b)', '(?<!a)b', 'a{1001}'])
    await expect(run({ query, regex: true })).rejects.toMatchObject({
      output: { error: 'BAD_REQUEST' },
    });
  expect(called).toBe(false);
  await writeFile(path.join(root, 'match.txt'), `abc123\nname = value\n${'a'.repeat(8_000)}!`);
  expect((await run({ query: '^abc[0-9]..$', regex: true })).matches).toHaveLength(1);
  expect((await run({ query: 'name.*value|zzz', regex: true })).matches).toMatchObject([
    { path: 'match.txt', line: 2 },
  ]);
  const started = performance.now();
  const bomb = await run({ query: '(a+)+$', regex: true });
  expect(bomb.matches).toEqual([]);
  expect(bomb.coverage.complete).toBe(true);
  expect(performance.now() - started).toBeLessThan(2_000);
  expect((await run({ query: '(a+)+$' })).matches).toEqual([]);
});

test('denied ancestors and substituted symlinks cannot disclose outside content', async () => {
  const root = await workspace();
  const outside = await workspace();
  await mkdir(path.join(root, 'private'));
  await writeFile(path.join(root, 'private', 'secret.txt'), 'needle');
  await writeFile(path.join(outside, 'outside.txt'), 'outside-needle');
  await symlink(outside, path.join(root, 'link'));
  const asked: string[] = [];
  const denied = await searchWorkspace({
    root,
    authorize: () => true,
    authorizePath: ({ path: candidate }) => {
      asked.push(candidate);
      return candidate !== 'private';
    },
  })();
  expect(asked).not.toContain('private/secret.txt');
  expect(denied.denied).toEqual([{ path: 'private', kind: 'directory' }]);
  expect(denied.skippedSymlinks).toBe(1);
  const changed = await searchWorkspace({
    root,
    authorize: () => true,
    authorizePath: async ({ path: candidate }) => {
      if (candidate === 'private') {
        await rename(path.join(root, 'private'), path.join(root, 'old-private'));
        await symlink(outside, path.join(root, 'private'));
      }
      return true;
    },
  })();
  expect(changed.matches).toEqual([]);
  expect(changed.errors?.[0]).toMatchObject({ path: 'private', operation: 'open-directory' });
  expect(changed.skippedSymlinks).toBe(1);
});

test('bounded directory reader and scanner preserve real descriptor read errors', async () => {
  const root = await workspace();
  for (let index = 0; index < 30; index += 1)
    await writeFile(path.join(root, `${index}`), 'x');
  const directory = await openPinnedDirectory(root);
  try {
    expect(await listAt(directory, 3)).toHaveLength(3);
  } finally {
    await directory.close();
  }
  const scan = await scanContainedFiles(
    { root, maxDepth: 1, maxFiles: 10, symlinks: 'skip', skipUnreadable: true },
    { openRoot: () => open(path.join(root, '0'), 'r'), list: listAt },
  );
  expect(scan.errors).toEqual([{ path: '.', operation: 'read-directory', code: 'ENOTDIR' }]);
  expect(scan.truncated).toBe(true);
  expect(scan.skippedSymlinks).toBe(0);
  await symlink('0', path.join(root, 'link'));
  await expect(walkContainedFiles({ root, maxDepth: 1, maxFiles: 100 })).rejects.toThrow(
    'symlink',
  );
  await expect(walkContainedFiles({ root, maxDepth: 1, maxFiles: 1 })).rejects.toThrow(
    'bounds',
  );
});

test('late opened capabilities are disposed after cancellation', async () => {
  const abort = new AbortController();
  const budget = new ContainedScanBudget({ signal: abort.signal });
  const root = await workspace();
  let complete: (fd: number) => void = () => {
    throw new Error('not started');
  };
  let disposed = false;
  const pending = budget.wait(
    () =>
      new Promise<number>((resolve) => {
        complete = resolve;
      }),
    (fd) => {
      closeSync(fd);
      disposed = true;
    },
  );
  abort.abort();
  await expect(pending).rejects.toThrow();
  complete(openSync(root, 'r'));
  await Promise.resolve();
  expect(disposed).toBe(true);
});

test('file read cancellation stops after one bounded chunk and counts consumed bytes', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'large.txt'), 'x'.repeat(100_000));
  const handle = await open(path.join(root, 'large.txt'), 'r');
  const abort = new AbortController();
  const budget = new ContainedScanBudget({ signal: abort.signal });
  let reads = 0;
  const observed: ContainedFileHandle = {
    fd: handle.fd,
    close: () => handle.close(),
    stat: () => handle.stat(),
    read: async (buffer, offset, length, position) => {
      reads += 1;
      const result = await handle.read(buffer, offset, length, position);
      abort.abort();
      return result;
    },
  };
  try {
    await expect(
      readContainedUtf8Handle(observed, 100_000, {
        check: () => budget.check(),
        readBytes: (bytes) => {
          budget.readBytes += bytes;
        },
        wait: (operation) => budget.wait(operation),
      }),
    ).rejects.toThrow('cancelled');
    await Promise.resolve();
    expect(reads).toBe(1);
    expect(budget.readBytes).toBe(16_384);
  } finally {
    await handle.close();
  }
});

test('permission denied is reported as a directory error on the mounted public tool', async () => {
  const root = await workspace();
  await chmod(root, 0o755);
  await mkdir(path.join(root, 'denied'));
  await writeFile(path.join(root, 'denied', 'secret.txt'), 'needle');
  await chmod(path.join(root, 'denied'), 0);
  const pidFile = path.join(root, 'probe.pid');
  trackPidFile(pidFile);
  try {
    const child = spawnSync(
      process.execPath,
      [path.join(import.meta.dir, 'fixtures/coding-search-permissions.ts'), root, pidFile],
      { encoding: 'utf8', timeout: 5_000 },
    );
    expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
    const result = SearchOutputSchema.parse(JSON.parse(child.stdout));
    expect(result.errors).toEqual([
      { path: 'denied', operation: 'open-directory', code: 'EACCES' },
    ]);
    expect(result.skippedSymlinks).toBe(0);
    expect(result.coverage.reasons).toContain('unreadable');
  } finally {
    await chmod(path.join(root, 'denied'), 0o755);
  }
});

test('scoped glob does not exhaust its file budget outside the requested subtree', async () => {
  const root = await workspace();
  await mkdir(path.join(root, 'z-docs'));
  await writeFile(path.join(root, 'a.txt'), 'unrelated');
  await writeFile(path.join(root, 'z-docs', 'match.md'), 'needle');
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root,
      authorize: () => true,
      limits: { maxSearchFiles: 1 },
    }),
  });
  const result = await tool(tools, 'glob')(
    { path: 'z-docs', pattern: '*.md' },
    { toolCallId: 'glob', messages: [], context: undefined },
  );
  expect(result).toMatchObject({
    paths: ['z-docs/match.md'],
    scannedFiles: 1,
    truncated: false,
  });
});

test('an abort reaches a search between lines of one file, not only between files', async () => {
  const root = await workspace();
  // Each line costs the native engine a noticeable slice of CPU; one file holds all of them.
  await writeFile(
    path.join(root, 'slow.txt'),
    Array.from({ length: 200 }, () => 'a'.repeat(256)).join('\n'),
  );
  const run = searchWorkspace({ root, authorize: () => true });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = performance.now();
  const result = await run({ query: '(?:a?){11}x', regex: true }, controller.signal);
  expect(result.coverage.reasons).toContain('cancelled');
  expect(performance.now() - started).toBeLessThan(2_000);
});
