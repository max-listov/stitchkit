import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  AFFECTS_NAMES_SINCE,
  affectsNameViolations,
  assertAffectsNamesExist,
  PUBLIC_SURFACE_PATH,
  type PublicSurface,
  parsePublicSurface,
  previousCoreSurface,
} from './release-affects-names';

const root = resolve(import.meta.dir, '..');

const surface = (entries: Record<string, string[]>): PublicSurface =>
  new Map(Object.entries(entries).map(([entry, names]) => [entry, new Set(names)]));

/** The tree after a release renamed `createSqliteAgentChildManager` to `createAgentChildManager`. */
const surfaces = {
  tree: surface({
    'stitchkit/agent-runtime': ['createAgentChildManager', 'createAgentSpillStore'],
    'stitchkit/process': ['runNativeCommand'],
  }),
  previous: surface({
    'stitchkit/agent-runtime': [
      'createSqliteAgentChildManager',
      'createSqliteAgentSpillStore',
    ],
    'stitchkit/process': ['runNativeCommand'],
  }),
};

const breaking = (affects: string) =>
  `### ⚠️ Breaking changes\n\n- \`stitchkit/agent-runtime\` a change.\n  **Affects:** ${affects}\n\n### Added\n\n- x\n`;
const fixed = (affects: string) =>
  `### Fixed\n\n- \`stitchkit/agent-runtime\` a fix.\n  **Affects:** ${affects}\n`;
const names = (notes: string) =>
  affectsNameViolations(notes, surfaces).map(
    ({ section, entrypoint, name, removed, exportedBy }) => ({
      section,
      entrypoint,
      name,
      removed,
      exportedBy,
    }),
  );

describe('every export an "**Affects:**" line names exists where its item needs it', () => {
  test('a fix naming an export this release removed is refused: nobody receives that fix', () => {
    expect(
      names(
        fixed(
          '`stitchkit/agent-runtime` createAgentChildManager(listChildBlocking), createSqliteAgentChildManager(listChildBlocking)',
        ),
      ),
    ).toEqual([
      {
        section: 'fixed',
        entrypoint: 'stitchkit/agent-runtime',
        name: 'createSqliteAgentChildManager',
        removed: true,
        exportedBy: [],
      },
    ]);
  });

  test('a breaking item may name an export it removes; a fix names what the tree ships', () => {
    expect(names(breaking('`stitchkit/agent-runtime` createSqliteAgentChildManager'))).toEqual(
      [],
    );
    expect(
      names(fixed('`stitchkit/agent-runtime` createAgentChildManager(stopChildren)')),
    ).toEqual([]);
  });

  test('a name exported nowhere, or by another entrypoint, is refused in either section', () => {
    expect(names(breaking('`stitchkit/agent-runtime` createSqliteAgentChildManagr'))).toEqual([
      {
        section: 'breaking',
        entrypoint: 'stitchkit/agent-runtime',
        name: 'createSqliteAgentChildManagr',
        removed: false,
        exportedBy: [],
      },
    ]);
    expect(names(fixed('`stitchkit/agent-runtime` runNativeCommand'))).toEqual([
      {
        section: 'fixed',
        entrypoint: 'stitchkit/agent-runtime',
        name: 'runNativeCommand',
        removed: false,
        exportedBy: ['stitchkit/process'],
      },
    ]);
  });

  test('every entrypoint of a target is judged; behaviour, * and a malformed line are left to their own rules', () => {
    expect(
      names(fixed('`stitchkit/process`, `stitchkit/agent-runtime` runNativeCommand')),
    ).toMatchObject([{ entrypoint: 'stitchkit/agent-runtime', name: 'runNativeCommand' }]);
    expect(
      names(breaking('`stitchkit/agent-runtime` behaviour; `stitchkit/old-leaf` *')),
    ).toEqual([]);
    expect(names(fixed('createAgentChildManager'))).toEqual([]);
  });

  test('the refusal lists every violation with what the name is', () => {
    const notes = `${breaking('`stitchkit/agent-runtime` createAgentChildManagr')}${fixed('`stitchkit/agent-runtime` createSqliteAgentSpillStore; `stitchkit/agent-runtime` runNativeCommand')}`;
    expect(() => assertAffectsNamesExist(notes, '0.127.0', surfaces)).toThrow(
      /createAgentChildManagr — exported by no entrypoint[\s\S]*createSqliteAgentSpillStore — removed by this release[\s\S]*runNativeCommand — exported by `stitchkit\/process`/,
    );
    expect(() =>
      assertAffectsNamesExist(
        fixed('`stitchkit/agent-runtime` createAgentSpillStore'),
        '0.127.0',
        surfaces,
      ),
    ).not.toThrow();
  });

  test('a security item names exports of this tree, as a fix does', () => {
    const security = (affects: string) =>
      `### Security\n\n- \`stitchkit/agent-runtime\` a hole closed.\n  **Affects:** ${affects}\n`;
    expect(names(security('`stitchkit/agent-runtime` createAgentChildManagr'))).toMatchObject([
      {
        section: 'security',
        entrypoint: 'stitchkit/agent-runtime',
        name: 'createAgentChildManagr',
      },
    ]);
    expect(
      names(security('`stitchkit/agent-runtime` createSqliteAgentChildManager')),
    ).toMatchObject([
      { section: 'security', name: 'createSqliteAgentChildManager', removed: true },
    ]);
    expect(names(security('`stitchkit/agent-runtime` createAgentChildManager'))).toEqual([]);
  });

  test('the rule starts at 0.127.0', () => {
    expect(AFFECTS_NAMES_SINCE).toBe('0.127.0');
  });
});

describe('the surfaces come from the tree and the previous release tag', () => {
  const created: string[] = [];
  afterAll(async () => {
    for (const path of created) await rm(path, { recursive: true, force: true });
  });
  const run = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  };
  const snapshot = (names: string[]) =>
    `${JSON.stringify({ 'stitchkit/agent-runtime': names })}\n`;

  /** A repository with core releases 0.125.0 and 0.126.0, each with its own surface, and a working commit after them. */
  async function repository(): Promise<string> {
    const at = await mkdtemp(join(tmpdir(), 'release-affects-names-'));
    created.push(at);
    run(at, 'init', '-q', '-b', 'master');
    run(at, 'config', 'user.email', 'gate@example.invalid');
    run(at, 'config', 'user.name', 'gate');
    await mkdir(dirname(join(at, PUBLIC_SURFACE_PATH)), { recursive: true });
    for (const [version, names] of [
      ['0.125.0', ['createSqliteAgentRuntime']],
      ['0.126.0', ['createSqliteAgentChildManager']],
      ['0.127.0-work', ['createAgentChildManager']],
    ] as const) {
      await writeFile(join(at, PUBLIC_SURFACE_PATH), snapshot([...names]));
      run(at, 'add', '--all');
      run(at, 'commit', '-q', '-m', version);
      if (!version.endsWith('-work')) run(at, 'tag', `v${version}`);
    }
    return at;
  }

  test('the tree surface is the exact export snapshot of this repository', () => {
    const tree = parsePublicSurface(readFileSync(join(root, PUBLIC_SURFACE_PATH), 'utf8'));
    expect(tree.get('stitchkit/agent-runtime')?.has('createAgentChildManager')).toBe(true);
  });

  test('the previous surface is read from the newest earlier core tag', async () => {
    const at = await repository();
    const previous = await previousCoreSurface(at, '0.127.0');
    expect([...(previous.get('stitchkit/agent-runtime') ?? [])]).toEqual([
      'createSqliteAgentChildManager',
    ]);
    expect([
      ...((await previousCoreSurface(at, '0.126.0')).get('stitchkit/agent-runtime') ?? []),
    ]).toEqual(['createSqliteAgentRuntime']);
    await expect(previousCoreSurface(at, '0.0.1')).rejects.toThrow(
      /No core release tag before 0\.0\.1/,
    );
  });

  test('a clone made without tags is refused and told how to get them', async () => {
    const at = await repository();
    const clone = await mkdtemp(join(tmpdir(), 'release-affects-names-clone-'));
    created.push(clone);
    run(clone, 'clone', '-q', '--depth', '1', '--no-tags', `file://${at}`, '.');
    await expect(previousCoreSurface(clone, '0.127.0')).rejects.toThrow(
      /No local release tags matching "v\*"[\s\S]*git fetch origin --tags[\s\S]*fetch-depth: 0/,
    );
    // A workflow checkout of a pushed tag holds that tag alone.
    const pushed = await mkdtemp(join(tmpdir(), 'release-affects-names-tag-'));
    created.push(pushed);
    run(
      pushed,
      'clone',
      '-q',
      '--depth',
      '1',
      '--no-tags',
      '--branch',
      'v0.126.0',
      `file://${at}`,
      '.',
    );
    await expect(previousCoreSurface(pushed, '0.126.0')).rejects.toThrow(
      /No core release tag before 0\.126\.0[\s\S]*fetch-depth: 0/,
    );
    run(clone, 'fetch', '-q', '--depth', '1', 'origin', 'tag', 'v0.126.0');
    expect(
      (await previousCoreSurface(clone, '0.127.0')).get('stitchkit/agent-runtime')?.size,
    ).toBe(1);
  });
});
