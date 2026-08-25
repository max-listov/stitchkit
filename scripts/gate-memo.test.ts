import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findGreenGate,
  type GreenGateRecord,
  gateMemoPath,
  greenGateKey,
  laneEnvironmentFingerprint,
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
});

describe('the memo knows what the lanes talk to, not only what ran them', () => {
  test('the browser set is part of the answer', async () => {
    // A tree hash and a runtime version cannot see a browser upgrade: same
    // files, same Bun, different Playwright — and the memo would have answered
    // for a run that happened under different conditions.
    const root = await scratch('gate-memo-browsers-');
    const before = await laneEnvironmentFingerprint({ PLAYWRIGHT_BROWSERS_PATH: root });
    await writeFile(join(root, 'chromium-9999'), '');
    const after = await laneEnvironmentFingerprint({ PLAYWRIGHT_BROWSERS_PATH: root });
    expect(after).not.toBe(before);
    expect(after).toContain('chromium-9999');
  });

  test('what cannot be measured gets a marker of its own, never a shared one', async () => {
    // Fail-safe in the right direction: an environment that cannot be read
    // produces a DIFFERENT key, so the outcome is a redundant full run rather
    // than a skip that should not have happened.
    const absent = await laneEnvironmentFingerprint({
      PLAYWRIGHT_BROWSERS_PATH: '/nowhere-that-exists',
      STARTER_TEST_DATABASE_ADMIN_URL: 'postgresql://nobody@127.0.0.1:1/none',
    });
    expect(absent).toContain('browsers:absent');
    expect(absent).toContain('pg:unreachable');

    const measured = await laneEnvironmentFingerprint({
      PLAYWRIGHT_BROWSERS_PATH: await scratch('gate-memo-empty-'),
      STARTER_TEST_DATABASE_ADMIN_URL: 'postgresql://nobody@127.0.0.1:1/none',
    });
    expect(measured).not.toBe(absent);
  });

  test('a different environment is a different key', async () => {
    const one = greenGateKey({ tree: 'same-tree', toolchain: 'bun:1 pg:16.15' });
    const two = greenGateKey({ tree: 'same-tree', toolchain: 'bun:1 pg:17.0' });
    expect(one).not.toBe(two);
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
