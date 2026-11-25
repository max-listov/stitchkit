import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNextReleaseVersion,
  parseTrainArguments,
  prepareTrain,
  rollChangelog,
  setManifestVersion,
} from './release-prepare';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

describe('the next version', () => {
  test('a release advances exactly one patch or minor', () => {
    for (const next of ['0.103.4', '0.104.0'])
      expect(() => assertNextReleaseVersion('0.103.3', next)).not.toThrow();
    for (const next of [
      '0.103.3',
      '0.103.2',
      '0.103.5',
      '0.104.1',
      '0.105.0',
      '1.0.0',
      '0.104.0-rc.1',
      '0.104',
      '00.104.0',
      '0.104.9007199254740992',
    ]) {
      expect(() => assertNextReleaseVersion('0.103.3', next)).toThrow('next patch or minor');
    }
    for (const previous of [
      'bad',
      '0.103',
      '00.103.3',
      '0.-103.3',
      '0.103.9007199254740992',
    ]) {
      expect(() => assertNextReleaseVersion(previous, '0.104.0')).toThrow(
        'next patch or minor',
      );
    }
  });
});

describe('rolling a changelog', () => {
  test('the unreleased notes move under the dated version and substantive notes are required', () => {
    const notes =
      '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Reuse verified input.\n\n## [0.103.3] - 2026-10-01\n';
    const rolled = rollChangelog(notes, '0.103.4', '2026-10-01');
    expect(rolled).toContain('## [Unreleased]\n\n## [0.103.4] - 2026-10-01\n\n### Fixed');
    expect(rolled).toContain('## [0.103.3] - 2026-10-01');
    expect(() =>
      rollChangelog('## [Unreleased]\n\n## [0.103.3]\n', '0.103.4', '2026-10-01'),
    ).toThrow('real release notes');
    expect(() => rollChangelog('# Changelog\n', '0.103.4', '2026-10-01')).toThrow(
      'no Unreleased',
    );
  });
});

describe('the manifest version', () => {
  test('only the version line changes', () => {
    const source = '{\n  "name": "x",\n  "version": "0.1.0",\n  "files": ["dist"]\n}\n';
    expect(setManifestVersion(source, '0.1.1')).toBe(
      '{\n  "name": "x",\n  "version": "0.1.1",\n  "files": ["dist"]\n}\n',
    );
    expect(() => setManifestVersion('{}', '0.1.1')).toThrow('no version');
  });
});

describe('train arguments', () => {
  test('target@version pairs parse, anything else is refused', () => {
    expect(parseTrainArguments(['core@0.9.0', 'tui@0.1.1'])).toEqual([
      { target: 'core', version: '0.9.0' },
      { target: 'tui', version: '0.1.1' },
    ]);
    for (const bad of ['core', 'core@', 'starter@0.1.0', '@0.1.0'])
      expect(() => parseTrainArguments([bad])).toThrow(
        'Expected <core|tui|create-stitchkit>@X.Y.Z',
      );
  });
});

describe('preparing a train', () => {
  async function tree(coreChangelog: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'release-prepare-'));
    created.push(root);
    await mkdir(join(root, 'packages/core'), { recursive: true });
    await writeFile(join(root, 'packages/core/package.json'), '{\n  "version": "0.9.0"\n}\n');
    await writeFile(join(root, 'CHANGELOG.md'), coreChangelog);
    // The siblings a train may have to carry; none is published here.
    for (const sibling of ['packages/tui', 'packages/create-stitchkit']) {
      await mkdir(join(root, sibling), { recursive: true });
      await writeFile(join(root, sibling, 'package.json'), '{\n  "version": "0.1.0"\n}\n');
    }
    return root;
  }
  /** A tree with no published sibling and no Git: the committed state is the tree itself. */
  const NO_SIBLINGS = {
    readPublished: async () => undefined,
    readHead: async () => undefined,
  };
  const NOTES =
    '## [Unreleased]\n\n### Fixed\n\n- A real fix with substance.\n\n## [0.9.0] - 2026-10-01\n';

  test('writes the version, the rolled changelog and the train', async () => {
    const root = await tree(NOTES);
    await prepareTrain(
      root,
      [{ target: 'core', version: '0.9.1' }],
      '2026-10-05',
      NO_SIBLINGS,
    );
    expect(await readFile(join(root, 'packages/core/package.json'), 'utf8')).toBe(
      '{\n  "version": "0.9.1"\n}\n',
    );
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [Unreleased]\n\n## [0.9.1] - 2026-10-05\n\n### Fixed',
    );
    expect(JSON.parse(await readFile(join(root, 'release-train.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      releases: [{ target: 'core', version: '0.9.1' }],
    });
  });

  test('a refusal leaves every file untouched', async () => {
    const root = await tree('## [Unreleased]\n\n## [0.9.0] - 2026-10-01\n');
    await expect(
      prepareTrain(root, [{ target: 'core', version: '0.9.1' }], '2026-10-05', NO_SIBLINGS),
    ).rejects.toThrow('real release notes');
    expect(await readFile(join(root, 'packages/core/package.json'), 'utf8')).toBe(
      '{\n  "version": "0.9.0"\n}\n',
    );
    expect(await Bun.file(join(root, 'release-train.json')).exists()).toBe(false);
    const skipped = await tree(NOTES);
    await expect(
      prepareTrain(skipped, [{ target: 'core', version: '0.9.5' }], '2026-10-05', NO_SIBLINGS),
    ).rejects.toThrow('next patch or minor');
  });
});

describe('prepare derives everything and can run again', () => {
  const NOTES =
    '## [Unreleased]\n\n### ⚠️ Breaking changes\n\n- `stitchkit` A real break.\n\n## [0.9.0] - 2026-10-01\n';
  const TUI_NOTES = '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-10-01\n\n- First.\n';

  async function repository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'release-prepare-git-'));
    created.push(root);
    const write = async (path: string, content: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    };
    await write('packages/core/package.json', '{\n  "version": "0.9.0"\n}\n');
    await write('CHANGELOG.md', NOTES);
    await write('packages/tui/package.json', '{\n  "version": "0.1.0"\n}\n');
    await write('packages/tui/CHANGELOG.md', TUI_NOTES);
    await write('packages/create-stitchkit/package.json', '{\n  "version": "0.1.0"\n}\n');
    await write(
      'docs/guide/upgrading.md',
      '# Upgrading\n\n## Unreleased migration: a-real-break\n\nDo this.\n\n## Released migration: 0.9.0\n',
    );
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'gate@example.invalid'],
      ['config', 'user.name', 'gate'],
      ['add', '.'],
      ['commit', '-qm', 'work'],
    ])
      expect(Bun.spawnSync(['git', '-C', root, ...args]).exitCode).toBe(0);
    return root;
  }
  // The published terminal package accepts only the framework minor it was packed beside.
  const published = async (tag: string, path: string) => {
    if (tag !== 'stitchkit-tui-v0.1.0') return undefined;
    if (path === 'packages/tui/package.json')
      return '{ "version": "0.1.0", "peerDependencies": { "stitchkit": "workspace:^" } }';
    if (path === 'packages/core/package.json') return '{ "version": "0.9.0" }';
    return undefined;
  };
  const train = [{ target: 'core' as const, version: '0.10.0' }];

  test('a second run writes the same bytes, and the companion and migration come with it', async () => {
    const root = await repository();
    const first = await prepareTrain(root, train, '2026-10-05', { readPublished: published });
    const after = await Promise.all(first.map((path) => readFile(join(root, path), 'utf8')));
    const second = await prepareTrain(root, train, '2026-10-05', { readPublished: published });
    expect(second).toEqual(first);
    expect(
      await Promise.all(second.map((path) => readFile(join(root, path), 'utf8'))),
    ).toEqual(after);
    expect(first.sort()).toEqual(
      [
        'CHANGELOG.md',
        'docs/guide/upgrading.md',
        'packages/core/package.json',
        'packages/tui/CHANGELOG.md',
        'packages/tui/package.json',
        'release-train.json',
      ].sort(),
    );
    expect(
      JSON.parse(await readFile(join(root, 'release-train.json'), 'utf8')).releases,
    ).toEqual([
      { target: 'core', version: '0.10.0' },
      { target: 'tui', version: '0.1.1' },
    ]);
    expect(await readFile(join(root, 'packages/tui/CHANGELOG.md'), 'utf8')).toContain(
      '## [0.1.1] - 2026-10-05\n\n### Changed\n\n- `stitchkit-tui` accepts `stitchkit@^0.10.0` as its peer, so a project installing both gets one copy of `stitchkit`.\n\n## [0.1.0]',
    );
    expect(await readFile(join(root, 'docs/guide/upgrading.md'), 'utf8')).toContain(
      '## Released migration: 0.10.0\n\n### a-real-break\n',
    );
  });

  test('a companion named in the train with notes of its own still says which range it now publishes', async () => {
    const root = await repository();
    const ownNotes =
      '# Changelog\n\n## [Unreleased]\n\n### ⚠️ Breaking changes\n\n**Who must act:** hosts on Bun 1.3.\n\n- `stitchkit-tui` requires Bun 1.4.\n\n## [0.1.0] - 2026-10-01\n\n- First.\n';
    await writeFile(join(root, 'packages/tui/CHANGELOG.md'), ownNotes);
    expect(Bun.spawnSync(['git', '-C', root, 'commit', '-qam', 'tui notes']).exitCode).toBe(0);
    const both = [...train, { target: 'tui' as const, version: '0.2.0' }];
    await prepareTrain(root, both, '2026-10-05', { readPublished: published });
    const rolled = await readFile(join(root, 'packages/tui/CHANGELOG.md'), 'utf8');
    expect(rolled).toContain(
      '## [0.2.0] - 2026-10-05\n\n### ⚠️ Breaking changes\n\n**Who must act:** hosts on Bun 1.3.\n\n- `stitchkit-tui` requires Bun 1.4.\n\n### Changed\n\n- `stitchkit-tui` accepts `stitchkit@^0.10.0` as its peer, so a project installing both gets one copy of `stitchkit`.\n\n## [0.1.0]',
    );
    // A `### Changed` the author already wrote takes the line as its last item, once.
    const authored = await repository();
    await writeFile(
      join(authored, 'packages/tui/CHANGELOG.md'),
      ownNotes.replace('\n\n## [0.1.0]', '\n\n### Changed\n\n- Own change.\n\n## [0.1.0]'),
    );
    expect(
      Bun.spawnSync(['git', '-C', authored, 'commit', '-qam', 'tui change']).exitCode,
    ).toBe(0);
    await prepareTrain(authored, both, '2026-10-05', { readPublished: published });
    const appended = await readFile(join(authored, 'packages/tui/CHANGELOG.md'), 'utf8');
    expect(appended).toContain(
      '### Changed\n\n- Own change.\n- `stitchkit-tui` accepts `stitchkit@^0.10.0` as its peer, so a project installing both gets one copy of `stitchkit`.\n\n## [0.1.0]',
    );
    expect(appended.match(/accepts `stitchkit@/g)).toHaveLength(1);
  });

  test('a second run on a later UTC date writes the same bytes and does not refuse', async () => {
    const root = await repository();
    const first = await prepareTrain(root, train, '2026-10-05', { readPublished: published });
    const after = await Promise.all(first.map((path) => readFile(join(root, path), 'utf8')));
    const second = await prepareTrain(root, train, '2026-10-06', { readPublished: published });
    expect(second).toEqual(first);
    expect(
      await Promise.all(second.map((path) => readFile(join(root, path), 'utf8'))),
    ).toEqual(after);
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toContain(
      '## [0.10.0] - 2026-10-05',
    );
    expect(await readFile(join(root, 'packages/tui/CHANGELOG.md'), 'utf8')).toContain(
      '## [0.1.1] - 2026-10-05',
    );
  });

  test('a file edited after prepare is refused, never overwritten', async () => {
    const root = await repository();
    await prepareTrain(root, train, '2026-10-05', { readPublished: published });
    const edited = `${await readFile(join(root, 'CHANGELOG.md'), 'utf8')}\nhand edit\n`;
    await writeFile(join(root, 'CHANGELOG.md'), edited);
    const manifest = await readFile(join(root, 'packages/core/package.json'), 'utf8');
    await expect(
      prepareTrain(root, train, '2026-10-05', { readPublished: published }),
    ).rejects.toThrow('Changed after the last commit and not by prepare: CHANGELOG.md');
    expect(await readFile(join(root, 'CHANGELOG.md'), 'utf8')).toBe(edited);
    expect(await readFile(join(root, 'packages/core/package.json'), 'utf8')).toBe(manifest);
  });
});

describe('the maturity table dates a new entrypoint from the release that ships it', () => {
  const GUIDE_ROWS = [
    '| Import | Use in | Maturity | Holds |',
    '|--------|--------|----------|-------|',
    '| `stitchkit` | server | stable | the root |',
    '| `stitchkit/old` | server | evolving | an old leaf |',
    '| `stitchkit/new` | server | evolving | a new leaf |',
    '',
  ].join('\n');
  const manifest = (subpaths: string[]) =>
    `{\n  "version": "0.126.0",\n  "exports": {\n${subpaths.map((path) => `    "${path}": "./dist/x.js"`).join(',\n')}\n  }\n}\n`;

  async function repository(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'release-prepare-cadence-'));
    created.push(root);
    const write = async (path: string, content: string) => {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), content);
    };
    await write('packages/core/package.json', manifest(['.', './old', './new']));
    await write(
      'CHANGELOG.md',
      '## [Unreleased]\n\n### ⚠️ Breaking changes\n\n- `stitchkit/new` `stitchkit/old` a thing moved between them.\n\n## [0.126.0] - 2026-11-21\n\n### Fixed\n\n- A fix.\n',
    );
    await write('docs/guide/getting-started.md', GUIDE_ROWS);
    await write('packages/tui/package.json', '{\n  "version": "0.1.0"\n}\n');
    await write('packages/create-stitchkit/package.json', '{\n  "version": "0.1.0"\n}\n');
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'gate@example.invalid'],
      ['config', 'user.name', 'gate'],
      ['add', '.'],
      ['commit', '-qm', 'work'],
    ])
      expect(Bun.spawnSync(['git', '-C', root, ...args]).exitCode).toBe(0);
    return root;
  }
  // The previous release exported the root and `old`, not `new`.
  const published = async (tag: string, path: string) =>
    tag === 'v0.126.0' && path === 'packages/core/package.json'
      ? manifest(['.', './old'])
      : undefined;

  test('a surface the previous release did not export counts from this release, not from the floor', async () => {
    const root = await repository();
    await prepareTrain(root, [{ target: 'core', version: '0.127.0' }], '2026-11-25', {
      readPublished: published,
    });
    const guide = await readFile(join(root, 'docs/guide/getting-started.md'), 'utf8');
    expect(guide).toContain(
      '| `stitchkit/new` | server | evolving<br>_redefined in 0 of the 1 minor since 0.127.0_ |',
    );
    expect(guide).toContain(
      '| `stitchkit/old` | server | evolving<br>_redefined in 1 of the 2 minors since 0.94.0, most recently 0.127.0_ |',
    );
  });
});
