import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findGreenGate,
  type GreenGateRecord,
  gateMemoPath,
  greenGateKey,
  parseGateMemo,
  readGreenGates,
  rememberGreenGate,
  worktreeTreeHash,
  writeGreenGate,
} from './gate-memo';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(await new Response(child.stderr).text());
  return text.trim();
}

async function repository(): Promise<string> {
  const root = await scratch('gate-memo-repo-');
  await git(root, ['init', '--quiet']);
  await git(root, ['config', 'user.email', 'gate@example.test']);
  await git(root, ['config', 'user.name', 'Gate']);
  await writeFile(join(root, 'a.txt'), 'one\n');
  await writeFile(join(root, '.gitignore'), 'ignored.txt\n');
  return root;
}

function record(overrides: Partial<GreenGateRecord> = {}): GreenGateRecord {
  return {
    tree: 'tree-1',
    toolchain: 'bun:1',
    at: '2026-08-25T00:00:00.000Z',
    commit: 'abc',
    ...overrides,
  };
}

describe('a gate remembers what it checked, not when it ran', () => {
  test('the key is the tree and the toolchain, and nothing else', () => {
    const base = record();
    const sameTreeLaterRun = { ...base, at: 'later', commit: 'different' };
    expect(greenGateKey(sameTreeLaterRun)).toBe(greenGateKey(base));
    expect(greenGateKey({ ...base, tree: 'tree-2' })).not.toBe(greenGateKey(base));
    expect(greenGateKey({ ...base, toolchain: 'bun:2' })).not.toBe(greenGateKey(base));
  });

  test('a repeated key replaces its entry instead of growing the history', () => {
    const first = rememberGreenGate([], record());
    const second = rememberGreenGate(first, record({ at: 'later' }));
    expect(second).toHaveLength(1);
    expect(second[0]?.at).toBe('later');
  });

  test('history is bounded and newest first', () => {
    let history: GreenGateRecord[] = [];
    for (let index = 0; index < 12; index += 1) {
      history = rememberGreenGate(history, record({ tree: `tree-${index}` }), 8);
    }
    expect(history).toHaveLength(8);
    expect(history[0]?.tree).toBe('tree-11');
    expect(findGreenGate(history, greenGateKey(record({ tree: 'tree-0' })))).toBeUndefined();
    expect(findGreenGate(history, greenGateKey(record({ tree: 'tree-11' })))?.tree).toBe(
      'tree-11',
    );
  });

  test('a damaged memo reads as no memo — it never authorises a skip', () => {
    expect(parseGateMemo('not json at all', 'verify')).toEqual([]);
    expect(parseGateMemo('{"gates":{"verify":"a string"}}', 'verify')).toEqual([]);
    expect(parseGateMemo('{"gates":{"verify":[{"tree":1}]}}', 'verify')).toEqual([]);
    const mixed = JSON.stringify({ gates: { bad: 'x', good: [record()] } });
    expect(parseGateMemo(mixed, 'bad')).toEqual([]);
    expect(parseGateMemo(mixed, 'good')).toEqual([record()]);
    expect(parseGateMemo('{"gates":{"other":[]}}', 'verify')).toEqual([]);
  });

  test('the memo lives outside the repository', () => {
    expect(gateMemoPath({ XDG_CACHE_HOME: '/cache' }, '/home/someone')).toBe(
      '/cache/stitchkit/green-gates.json',
    );
    expect(gateMemoPath({}, '/home/someone')).toBe(
      '/home/someone/.cache/stitchkit/green-gates.json',
    );
  });

  test('a written record comes back, and one gate does not overwrite another', async () => {
    const directory = await scratch('gate-memo-file-');
    const path = join(directory, 'nested', 'green-gates.json');
    await writeGreenGate('verify', record(), path);
    await writeGreenGate('verify:fast', record({ tree: 'tree-9' }), path);
    expect((await readGreenGates('verify', path))[0]?.tree).toBe('tree-1');
    expect((await readGreenGates('verify:fast', path))[0]?.tree).toBe('tree-9');
    expect(await readGreenGates('verify', join(directory, 'absent.json'))).toEqual([]);
  });

  test('concurrent writers retain every independent gate', async () => {
    const directory = await scratch('gate-memo-concurrent-');
    const path = join(directory, 'green-gates.json');
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        writeGreenGate(`gate-${index}`, record(), path),
      ),
    );
    for (let index = 0; index < 12; index += 1)
      expect(await readGreenGates(`gate-${index}`, path)).toHaveLength(1);
  });
});

describe('the tree hash is of the working tree, through nobody else’s index', () => {
  test('editing any file changes the answer', async () => {
    const root = await repository();
    const before = await worktreeTreeHash(root);
    await writeFile(join(root, 'a.txt'), 'two\n');
    expect(await worktreeTreeHash(root)).not.toBe(before);
    await writeFile(join(root, 'a.txt'), 'one\n');
    expect(await worktreeTreeHash(root)).toBe(before);
  });

  test('a new file counts, and an ignored one does not', async () => {
    const root = await repository();
    const before = await worktreeTreeHash(root);
    await writeFile(join(root, 'ignored.txt'), 'build output\n');
    expect(await worktreeTreeHash(root)).toBe(before);
    await writeFile(join(root, 'added.txt'), 'source\n');
    expect(await worktreeTreeHash(root)).not.toBe(before);
  });

  test('tracked ignored bytes and deletion count without changing the caller index', async () => {
    for (const name of ['board.sqlite', 'é-data.sqlite', ' edge\n\t.sqlite ']) {
      const root = await repository();
      await mkdir(join(root, '.data'));
      await writeFile(join(root, '.gitignore'), 'ignored.txt\n.data/\n');
      const path = join('.data', name);
      await writeFile(join(root, path), 'reviewed data\n');
      await git(root, ['add', '--force', '--', path]);
      const indexPath = join(root, '.git/index');
      const indexBytes = await readFile(indexPath);
      const indexMetadata = await stat(indexPath, { bigint: true });
      const before = await worktreeTreeHash(root);
      await writeFile(join(root, '.data/untracked.sqlite'), 'ignored output\n');
      expect(await worktreeTreeHash(root)).toBe(before);
      await writeFile(join(root, path), 'current data\n');
      expect(await worktreeTreeHash(root)).not.toBe(before);
      await writeFile(join(root, path), 'reviewed data\n');
      expect(await worktreeTreeHash(root)).toBe(before);
      await rm(join(root, path));
      expect(await worktreeTreeHash(root)).not.toBe(before);
      expect(await readFile(indexPath)).toEqual(indexBytes);
      const afterMetadata = await stat(indexPath, { bigint: true });
      expect(afterMetadata.mtimeNs).toBe(indexMetadata.mtimeNs);
      expect(afterMetadata.ctimeNs).toBe(indexMetadata.ctimeNs);
    }
  });

  test('the real index is not touched — not even transiently', async () => {
    // The falsification that matters. `git write-tree` needs an index, and the
    // obvious implementation reaches for the repository's own — the one holding
    // exactly the changes its owner reviewed and chose. Staging on their behalf
    // to answer a question about the working tree is not a side effect, it is
    // taking their decision. This proves the scratch index is real.
    const root = await repository();
    await writeFile(join(root, 'staged.txt'), 'deliberately staged\n');
    await git(root, ['add', 'staged.txt']);
    const staged = await git(root, ['status', '--short']);
    expect(staged).toContain('A  staged.txt');
    expect(staged).toContain('?? a.txt');

    await worktreeTreeHash(root);

    expect(await git(root, ['status', '--short'])).toBe(staged);
  });
});
