import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SearchOutput } from '../src/agent-runtime/coding-search-contract';
import { boundSearchDiagnostics } from '../src/agent-runtime/coding-search-output';
import { ContainedScanBudget } from '../src/agent-runtime/contained-scan-budget';
import { compileWorkspaceGlob } from '../src/agent-runtime/workspace-glob';
import { openPinnedDirectory } from '../src/internal/contained-directory';
import { listAt } from '../src/internal/contained-files';
import { searchWorkspace } from './support/coding-search';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-search-review-'));
  roots.push(root);
  return root;
}

test('search pins the configured root before path authorization can replace its alias or identity', async () => {
  for (const alias of [true, false]) {
    const parent = await workspace();
    const inside = path.join(parent, 'inside');
    const outside = path.join(parent, 'outside');
    await mkdir(inside);
    await mkdir(outside);
    await writeFile(path.join(inside, 'inside.txt'), 'inside-needle');
    await writeFile(path.join(outside, 'outside.txt'), 'outside-needle');
    const root = alias ? path.join(parent, 'alias') : inside;
    if (alias) await symlink(inside, root);
    const run = searchWorkspace({
      root,
      authorize: () => true,
      authorizePath: async ({ path: candidate }) => {
        if (candidate === '.') {
          if (alias) await rm(root);
          else await rename(inside, path.join(parent, 'selected'));
          await symlink(outside, root);
        }
        return true;
      },
    });
    const result = await run();
    expect(result.matches).toEqual([{ path: 'inside.txt', line: 1, text: 'inside-needle' }]);
    expect(result.coverage.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain('outside-needle');
  }
});

test('host path policy failures reach error hooks instead of fabricated filesystem diagnostics', async () => {
  const root = await workspace();
  await writeFile(path.join(root, 'a.txt'), 'needle');
  const cause = new Error('private policy backend failure');
  const observed: unknown[] = [];
  const run = searchWorkspace(
    {
      root,
      authorize: () => true,
      authorizePath: ({ path: candidate }) => {
        if (candidate === 'a.txt') throw cause;
        return true;
      },
    },
    {
      onToolError: ({ error }) => {
        observed.push(error);
      },
    },
  );
  await expect(run()).rejects.toMatchObject({ output: { error: 'INTERNAL_SERVER_ERROR' } });
  expect(observed).toContain(cause);
});

test('cancelled directory enumeration starts no further reads after the active entry', async () => {
  const root = await workspace();
  for (let index = 0; index < 10; index += 1)
    await writeFile(path.join(root, `${index}`), 'x');
  const directory = await openPinnedDirectory(root);
  const abort = new AbortController();
  const budget = new ContainedScanBudget({ signal: abort.signal });
  let entries = 0;
  try {
    await expect(
      listAt(directory, 10, {
        entry: () => {
          entries += 1;
          abort.abort();
        },
        check: () => budget.check(),
      }),
    ).rejects.toThrow('cancelled');
    expect(entries).toBe(1);
  } finally {
    await directory.close();
  }
});

test('glob automaton checks the CPU deadline inside a large active state set', () => {
  const started = performance.now();
  const budget = new ContainedScanBudget({ deadline: started + 10 });
  const compiled = compileWorkspaceGlob('*'.repeat(4_096), () => budget.check());
  expect(() => compiled.test('a'.repeat(4_096))).toThrow('timeout');
  expect(performance.now() - started).toBeLessThan(1_000);
});

test('diagnostic finalization uses linear admission and honors an expired deadline', () => {
  let serializations = 0;
  const output: SearchOutput = {
    matches: [],
    truncated: true,
    scannedFiles: 0,
    skippedDirectories: 0,
    skippedSymlinks: 0,
    coverage: {
      complete: false,
      reasons: ['denied'],
      scope: { path: '.', include: '**', excludedDirectories: 'default', symlinks: 'skip' },
      visitedDirectories: 1,
      visitedEntries: 2_000,
      readBytes: 0,
      elapsedMs: 0,
    },
    denied: Array.from({ length: 2_000 }, (_, index) => {
      const entry: NonNullable<SearchOutput['denied']>[number] = {
        path: `${index}-${'x'.repeat(1_024)}`,
        kind: 'file',
      };
      Object.defineProperty(entry, 'toJSON', {
        value: () => {
          serializations += 1;
          return { path: entry.path, kind: entry.kind };
        },
      });
      return entry;
    }),
  };
  const budget = new ContainedScanBudget();
  boundSearchDiagnostics(output, budget, 1_024);
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(1_024);
  expect(output.denied).toEqual([]);
  expect(output.deniedTruncated).toBe(true);
  expect(budget.reasons.has('max-output-bytes')).toBe(true);
  expect(serializations).toBeLessThanOrEqual(2);
  output.denied = [{ path: 'a', kind: 'file' }];
  const expired = new ContainedScanBudget({ deadline: performance.now() - 1 });
  boundSearchDiagnostics(output, expired, 1_024);
  expect(expired.reasons.has('timeout')).toBe(true);
  expect(output.denied).toEqual([]);
  delete output.denied;
  const empty = new ContainedScanBudget({ deadline: performance.now() - 1 });
  boundSearchDiagnostics(output, empty, 1_024);
  expect(empty.reasons.has('timeout')).toBe(true);
});
