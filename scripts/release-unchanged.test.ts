import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { RELEASE_TARGETS, ReleaseTargetSchema, type ReleaseTrain } from './release-train';
import {
  assertPackagesChanged,
  changedPackedFiles,
  packedClosurePathspecs,
  previousReleaseTag,
} from './release-unchanged';
import { readFromWorkingTree } from './starter-lockfile';

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stderr: 'pipe', stdout: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

const manifest = (version: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ name: 'stitchkit', version, files: ['dist'], ...extra }, null, 2)}\n`;

const FILES: Record<string, string> = {
  'packages/core/package.json': manifest('0.9.0'),
  'packages/core/src/a.ts': 'export const a = 1;\n',
  'packages/core/tests/a.test.ts': 'test\n',
  'packages/core/CHANGELOG.md': '# copy\n',
  'packages/tui/package.json': `${JSON.stringify({ name: 'stitchkit-tui', version: '0.1.0', dependencies: { stitchkit: 'workspace:^' } }, null, 2)}\n`,
  'packages/tui/src/a.ts': 'export const t = 1;\n',
  'docs/architecture/gates.md': 'gates\n',
  'docs/guide/cli.md': 'cli\n',
  'CHANGELOG.md': '## [Unreleased]\n\n## [0.9.0]\n',
  'release-train.json': '{}\n',
};

/** A repository whose first commit is tagged `v0.9.0` and `stitchkit-tui-v0.1.0`. */
async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'release-unchanged-'));
  created.push(root);
  git(root, 'init', '-q', '-b', 'master');
  git(root, 'config', 'user.email', 'a@example.com');
  git(root, 'config', 'user.name', 'a');
  git(root, 'config', 'commit.gpgsign', 'false');
  await write(root, FILES);
  git(root, 'add', '--all');
  git(root, 'commit', '-q', '-m', 'chore: first');
  git(root, 'tag', 'v0.9.0');
  git(root, 'tag', 'stitchkit-tui-v0.1.0');
  return root;
}

async function write(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

/** The edits every release makes: the version and the changelog. */
const BUMP: Record<string, string> = {
  'packages/core/package.json': manifest('0.9.1'),
  'CHANGELOG.md': '## [Unreleased]\n\n## [0.9.1]\n\n## [0.9.0]\n',
  'packages/core/CHANGELOG.md': '# copy of the new changelog\n',
};
const CORE_TRAIN: ReleaseTrain = {
  schemaVersion: 1,
  releases: [{ target: 'core', version: '0.9.1' }],
};

const verdict = async (root: string, train: ReleaseTrain = CORE_TRAIN, ref?: string) =>
  assertPackagesChanged(root, train, readFromWorkingTree(root), ref);

describe('a package identical to its previous release is refused before the commit', () => {
  test('control: a version bump with an architecture-doc edit changes nothing consumers receive', async () => {
    const root = await repository();
    await write(root, { ...BUMP, 'docs/architecture/gates.md': 'gates, reworded\n' });
    await expect(verdict(root)).rejects.toThrow(
      /stitchkit@0\.9\.1 would publish the same files as v0\.9\.0/,
    );
  });

  test('a release that edits only tests and the package changelog copy is refused too', async () => {
    const root = await repository();
    await write(root, { ...BUMP, 'packages/core/tests/a.test.ts': 'a changed test\n' });
    await expect(verdict(root)).rejects.toThrow(/same files as v0\.9\.0/);
  });

  test('a source change passes', async () => {
    const root = await repository();
    await write(root, { ...BUMP, 'packages/core/src/a.ts': 'export const a = 2;\n' });
    await expect(verdict(root)).resolves.toBeUndefined();
  });

  test('a new untracked source file passes', async () => {
    const root = await repository();
    await write(root, { ...BUMP, 'packages/core/src/b.ts': 'export const b = 1;\n' });
    await expect(verdict(root)).resolves.toBeUndefined();
  });

  test('a guide edit passes, because the guides build the packed llms files', async () => {
    const root = await repository();
    await write(root, { ...BUMP, 'docs/guide/cli.md': 'cli, extended\n' });
    await expect(verdict(root)).resolves.toBeUndefined();
  });

  test('a manifest change other than the version passes', async () => {
    const root = await repository();
    await write(root, {
      ...BUMP,
      'packages/core/package.json': manifest('0.9.1', { peerDependencies: { zod: '^4.0.0' } }),
    });
    await expect(verdict(root)).resolves.toBeUndefined();
  });

  test('key order in the manifest is not a change', async () => {
    const root = await repository();
    const reordered = `${JSON.stringify({ files: ['dist'], version: '0.9.1', name: 'stitchkit' }, null, 2)}\n`;
    await write(root, { ...BUMP, 'packages/core/package.json': reordered });
    await expect(verdict(root)).rejects.toThrow(/same files/);
  });

  test('a committed change is judged against the ref, not the working tree', async () => {
    const root = await repository();
    await write(root, { ...BUMP, 'packages/core/src/a.ts': 'export const a = 3;\n' });
    git(root, 'add', '--all');
    git(root, 'commit', '-q', '-m', 'feat(core): change a');
    const head = git(root, 'rev-parse', 'HEAD');
    await expect(verdict(root, CORE_TRAIN, head)).resolves.toBeUndefined();
    expect(await changedPackedFiles(root, 'core', 'v0.9.0', head)).toEqual([
      'packages/core/src/a.ts',
    ]);
  });

  test('a target released for the first time has nothing to compare with', async () => {
    const root = await repository();
    await write(root, BUMP);
    const train: ReleaseTrain = {
      schemaVersion: 1,
      releases: [{ target: 'create-stitchkit', version: '0.1.0' }],
    };
    await expect(verdict(root, train)).resolves.toBeUndefined();
  });

  test('a package that follows a bumped workspace sibling changes with it', async () => {
    const root = await repository();
    await write(root, BUMP);
    const train: ReleaseTrain = {
      schemaVersion: 1,
      releases: [{ target: 'tui', version: '0.1.1' }],
    };
    await write(root, {
      'packages/tui/package.json': `${JSON.stringify({ name: 'stitchkit-tui', version: '0.1.1', dependencies: { stitchkit: 'workspace:^' } }, null, 2)}\n`,
    });
    await expect(verdict(root, train)).resolves.toBeUndefined();
    // Core at its previous version: nothing in the tui tarball differs.
    git(root, 'checkout', '-q', '--', 'packages/core/package.json');
    await expect(verdict(root, train)).rejects.toThrow(
      /stitchkit-tui@0\.1\.1 would publish the same files/,
    );
  });
});

describe('the previous tag', () => {
  test('is the newest earlier version of the same namespace', () => {
    const tags = [
      'v0.9.0',
      'v0.10.0',
      'v0.9.1',
      'v0.10.1',
      'create-stitchkit-v0.50.0',
      'v0.10.1-rc.1',
    ];
    expect(previousReleaseTag(tags, 'core', '0.10.1')).toBe('v0.10.0');
    expect(previousReleaseTag(tags, 'core', '0.11.0')).toBe('v0.10.1');
    expect(previousReleaseTag(tags, 'core', '0.9.0')).toBeUndefined();
    expect(previousReleaseTag(tags, 'create-stitchkit', '0.51.0')).toBe(
      'create-stitchkit-v0.50.0',
    );
    expect(previousReleaseTag(tags, 'tui', '0.1.0')).toBeUndefined();
  });
});

describe('the packed closure is declared against the real manifests', () => {
  const root = resolve(import.meta.dir, '..');
  const ManifestSchema = z.object({ files: z.array(z.string()) });

  test('no path declared as never packed is listed in `files`, except the changelog', async () => {
    for (const target of ReleaseTargetSchema.options) {
      const info = RELEASE_TARGETS[target];
      const { files } = ManifestSchema.parse(
        JSON.parse(await readFile(join(root, info.directory, 'package.json'), 'utf8')),
      );
      for (const unpacked of info.unpackedPaths.filter((path) => path !== 'CHANGELOG.md')) {
        const packed = files.filter(
          (entry) =>
            !entry.startsWith('!') &&
            (entry === unpacked ||
              entry.startsWith(`${unpacked}/`) ||
              unpacked.startsWith(`${entry}/`)),
        );
        expect({ target, unpacked, packed }).toEqual({ target, unpacked, packed: [] });
      }
    }
  });

  test('the closure excludes the manifest and the unpacked paths and includes external inputs', () => {
    const specs = packedClosurePathspecs('core');
    expect(specs).toContain('packages/core');
    expect(specs).toContain('docs/guide');
    expect(specs).toContain(':(exclude)packages/core/package.json');
    expect(specs).toContain(':(exclude)packages/core/tests');
  });
});
