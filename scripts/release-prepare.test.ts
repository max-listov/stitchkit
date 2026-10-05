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
    return root;
  }
  const NOTES =
    '## [Unreleased]\n\n### Fixed\n\n- A real fix with substance.\n\n## [0.9.0] - 2026-10-01\n';

  test('writes the version, the rolled changelog and the train', async () => {
    const root = await tree(NOTES);
    await prepareTrain(root, [{ target: 'core', version: '0.9.1' }], '2026-10-05');
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
      prepareTrain(root, [{ target: 'core', version: '0.9.1' }], '2026-10-05'),
    ).rejects.toThrow('real release notes');
    expect(await readFile(join(root, 'packages/core/package.json'), 'utf8')).toBe(
      '{\n  "version": "0.9.0"\n}\n',
    );
    expect(await Bun.file(join(root, 'release-train.json')).exists()).toBe(false);
    const skipped = await tree(NOTES);
    await expect(
      prepareTrain(skipped, [{ target: 'core', version: '0.9.5' }], '2026-10-05'),
    ).rejects.toThrow('next patch or minor');
  });
});
