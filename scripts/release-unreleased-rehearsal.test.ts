import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import {
  PUBLIC_SURFACE_PATH,
  PUBLIC_SURFACE_PRODUCERS_PATH,
  previousCoreSurface,
} from './release-affects-names';
import { CADENCE_GUIDE } from './release-derived';
import { breakingMarkers, extractReleaseNotes } from './release-notes';
import { prepareTrain } from './release-prepare';
import {
  RELEASE_TARGETS,
  ReleaseTargetSchema,
  type ReleaseTrain,
  releasePlanForTag,
  releaseTagForTarget,
} from './release-train';
import { assertReleaseNotesMetadata, MATURITY_TABLE_PATH } from './release-validate';
import { readFromWorkingTree } from './starter-lockfile';

/**
 * The notes a release will check are written long before the release: an
 * author queues them under `[Unreleased]` and `## Unreleased migration: …`.
 * Nothing in the ordinary gate read them until `release:check`, so a companion
 * whose queued breaking section was malformed passed every push and failed the
 * train. This rehearsal copies the release metadata into a scratch tree, runs
 * the real `prepare` over every target with queued notes at the version their
 * content calls for, and runs the checks the release runs on what it wrote. A
 * derived file `prepare` forgets — a migration heading it does not promote — is
 * red here, not on the release.
 */

const root = resolve(import.meta.dir, '..');
const DATE = '2099-01-01';
const ManifestSchema = z.object({ version: z.string() });

const created: string[] = [];
afterAll(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

/** Every file `prepare` derives a train from and the release checks read, from the one target table. */
function metadataPaths(): string[] {
  const paths = new Set([
    CADENCE_GUIDE,
    MATURITY_TABLE_PATH,
    PUBLIC_SURFACE_PATH,
    PUBLIC_SURFACE_PRODUCERS_PATH,
  ]);
  for (const info of Object.values(RELEASE_TARGETS)) {
    paths.add(`${info.directory}/package.json`);
    paths.add(info.changelog);
    paths.add(info.migration.guidePath);
  }
  return [...paths];
}

function nextVersion(current: string, breaking: boolean): string {
  const [major, minor, patch] = current.split('.').map(Number);
  return breaking ? `${major}.${(minor ?? 0) + 1}.0` : `${major}.${minor}.${(patch ?? 0) + 1}`;
}

/** A target's version when its `[Unreleased]` notes are released, or `undefined` with none queued. */
async function queuedVersion(
  scratch: string,
  target: ReleaseTrain['releases'][number]['target'],
): Promise<string | undefined> {
  const info = RELEASE_TARGETS[target];
  const read = readFromWorkingTree(scratch);
  const manifest = ManifestSchema.parse(
    JSON.parse(await read(`${info.directory}/package.json`)),
  );
  const changelog = await read(info.changelog);
  const unreleased =
    /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[)/m.exec(changelog)?.[1] ?? '';
  if (!/^\s*-\s+\S/m.test(unreleased)) return undefined;
  return nextVersion(manifest.version, breakingMarkers(unreleased).length > 0);
}

/**
 * Copy the metadata `read` holds into a scratch tree and prepare one train of
 * every target with queued notes, as `release-plan.ts prepare` does. The copy is
 * the committed state, and no sibling is published: which companions a train
 * must carry is judged against the release tags by `release:check`.
 */
async function rehearse(
  read: (path: string) => Promise<string | undefined>,
): Promise<{ scratch: string; releases: ReleaseTrain['releases'] }> {
  const scratch = await mkdtemp(join(tmpdir(), 'release-rehearsal-'));
  created.push(scratch);
  for (const path of metadataPaths()) {
    const content = await read(path);
    if (content === undefined) continue;
    await mkdir(dirname(join(scratch, path)), { recursive: true });
    await writeFile(join(scratch, path), content);
  }
  const releases: ReleaseTrain['releases'] = [];
  for (const target of ReleaseTargetSchema.options) {
    const version = await queuedVersion(scratch, target);
    if (version !== undefined) releases.push({ target, version });
  }
  if (releases.length > 0)
    await prepareTrain(scratch, releases, DATE, {
      readHead: async () => undefined,
      readPublished: async () => undefined,
    });
  return { scratch, releases };
}

async function fromWorkingTree(path: string): Promise<string | undefined> {
  const file = Bun.file(join(root, path));
  return (await file.exists()) ? file.text() : undefined;
}

describe('queued release notes pass the release checks before the train', () => {
  const rehearsal = rehearse(fromWorkingTree);
  for (const target of ReleaseTargetSchema.options) {
    test(`${target}: [Unreleased] prepared at its next version passes the release checks`, async () => {
      const { scratch, releases } = await rehearsal;
      const release = releases.find((entry) => entry.target === target);
      if (release === undefined) return;
      const plan = releasePlanForTag(releaseTagForTarget(target, release.version));
      const read = readFromWorkingTree(scratch);
      const notes = await assertReleaseNotesMetadata(plan, read, () =>
        previousCoreSurface(root, plan.version),
      );
      expect(notes).toBe(extractReleaseNotes(await read(plan.changelog), plan.version));
    });
  }

  /** A tree of the three packages with `tui` carrying `files`; the others have nothing queued. */
  function tuiTree(files: Record<string, string>) {
    const tree: Record<string, string> = {
      'packages/core/package.json': '{\n  "name": "stitchkit",\n  "version": "0.9.0"\n}\n',
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [0.9.0] - 2026-11-21\n\n- old\n',
      'packages/create-stitchkit/package.json':
        '{\n  "name": "create-stitchkit",\n  "version": "0.1.0"\n}\n',
      'packages/create-stitchkit/CHANGELOG.md':
        '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-11-21\n\n- old\n',
      'packages/tui/package.json': '{\n  "name": "stitchkit-tui",\n  "version": "0.4.7"\n}\n',
      ...files,
    };
    return async (path: string) => tree[path];
  }

  async function rehearsedTui(files: Record<string, string>) {
    const { scratch, releases } = await rehearse(tuiTree(files));
    expect(releases).toEqual([{ target: 'tui', version: '0.5.0' }]);
    const plan = releasePlanForTag(releaseTagForTarget('tui', '0.5.0'));
    return assertReleaseNotesMetadata(plan, readFromWorkingTree(scratch), () =>
      Promise.reject(new Error('a tui release reads no core surface')),
    );
  }

  test("prepare promotes the companion's queued migration, so its breaking release passes", async () => {
    await expect(
      rehearsedTui({
        'packages/tui/CHANGELOG.md':
          '# Changelog\n\n## [Unreleased]\n\n### ⚠️ Breaking changes\n\n**Who must act:** hosts on Bun 1.3.\n\n- `stitchkit-tui` requires Bun 1.4.\n\n## [0.4.7] - 2026-11-21\n\n- old\n',
        'packages/tui/UPGRADING.md':
          '# Upgrading\n\n## Unreleased migration: bun-floor\n\n### Bun floor\n\n**Who must act:** hosts on Bun 1.3.\n',
      }),
    ).resolves.toContain('requires Bun 1.4');
  });

  test('a queued breaking section with an indented audience line is refused', async () => {
    await expect(
      rehearsedTui({
        'packages/tui/CHANGELOG.md':
          '# Changelog\n\n## [Unreleased]\n\n### ⚠️ Breaking changes\n\n- `stitchkit-tui` requires Bun 1.4.\n  **Who must act:** hosts on Bun 1.3.\n\n## [0.4.7] - 2026-11-21\n\n- old\n',
        'packages/tui/UPGRADING.md':
          '# Upgrading\n\n## Unreleased migration: bun-floor\n\n### Bun floor\n\n**Who must act:** hosts on Bun 1.3.\n',
      }),
    ).rejects.toThrow(/Who must act/);
  });

  test('a queued migration heading without its slug is refused', async () => {
    await expect(
      rehearsedTui({
        'packages/tui/CHANGELOG.md':
          '# Changelog\n\n## [Unreleased]\n\n### ⚠️ Breaking changes\n\n**Who must act:** hosts on Bun 1.3.\n\n- `stitchkit-tui` requires Bun 1.4.\n\n## [0.4.7] - 2026-11-21\n\n- old\n',
        'packages/tui/UPGRADING.md':
          '# Upgrading\n\n## Unreleased migration\n\n### Bun floor\n\n**Who must act:** hosts on Bun 1.3.\n',
      }),
    ).rejects.toThrow(/Released migration: 0\.5\.0/);
  });
});
