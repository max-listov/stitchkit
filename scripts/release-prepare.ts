import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RELEASE_TARGETS,
  ReleaseTargetSchema,
  type ReleaseTrain,
  ReleaseTrainSchema,
} from './release-train';

/**
 * A release is the next patch or the next minor with patch 0 of the version
 * the package carries. Calibre (breaking needs a minor) is judged against the
 * rolled changelog by `release-notes.ts`.
 */
export function assertNextReleaseVersion(previous: string, next: string): void {
  const parts = previous.split('.').map(Number);
  const [major, minor, patch] = parts;
  if (
    parts.length !== 3 ||
    major === undefined ||
    minor === undefined ||
    patch === undefined ||
    previous !== parts.join('.') ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0) ||
    !next
      .split('.')
      .every((part) => /^\d+$/.test(part) && Number.isSafeInteger(Number(part))) ||
    (next !== `${major}.${minor}.${patch + 1}` && next !== `${major}.${minor + 1}.0`)
  ) {
    throw new Error(`Release must be the next patch or minor after ${previous}; got ${next}`);
  }
}

/** Move the `[Unreleased]` notes under a dated version heading and leave an empty `[Unreleased]`. */
export function rollChangelog(source: string, version: string, date: string): string {
  const heading = /^## \[Unreleased\][^\n]*\n/m.exec(source);
  if (!heading) throw new Error('Changelog has no Unreleased heading');
  const start = heading.index + heading[0].length;
  const next = source.slice(start).search(/^## \[/m);
  const body = source.slice(start, next < 0 ? undefined : start + next).trim();
  if (!/^\s*-\s+\S/m.test(body))
    throw new Error(`Release ${version} needs real release notes`);
  return (
    `${source.slice(0, heading.index)}## [Unreleased]\n\n## [${version}] - ${date}\n\n` +
    source.slice(start).trimStart()
  );
}

/** Set the manifest `version` without reformatting the rest of the file. */
export function setManifestVersion(source: string, version: string): string {
  const pattern = /^(\s*"version":\s*")[^"]+(")/m;
  if (!pattern.test(source)) throw new Error('package manifest has no version field');
  return source.replace(pattern, `$1${version}$2`);
}

function currentVersion(source: string): string {
  const parsed: unknown = JSON.parse(source);
  const version =
    typeof parsed === 'object' && parsed !== null ? Reflect.get(parsed, 'version') : undefined;
  if (typeof version !== 'string') throw new Error('package manifest has no string version');
  return version;
}

/**
 * Write the release metadata of a train: each target's version and changelog
 * roll, and `release-train.json`. The lockfile follows from `bun install`, and
 * `release-plan.ts check` judges the result.
 */
export async function prepareTrain(
  root: string,
  releases: ReleaseTrain['releases'],
  date: string,
): Promise<void> {
  const writes: [string, string][] = [];
  for (const { target, version } of releases) {
    const info = RELEASE_TARGETS[target];
    const manifestPath = join(root, info.directory, 'package.json');
    const manifest = await readFile(manifestPath, 'utf8');
    assertNextReleaseVersion(currentVersion(manifest), version);
    const changelogPath = join(root, info.changelog);
    writes.push(
      [manifestPath, setManifestVersion(manifest, version)],
      [changelogPath, rollChangelog(await readFile(changelogPath, 'utf8'), version, date)],
    );
  }
  const train = ReleaseTrainSchema.parse({ schemaVersion: 1, releases });
  writes.push([join(root, 'release-train.json'), `${JSON.stringify(train, null, 2)}\n`]);
  // Every file is computed before the first is written: a refusal leaves the tree untouched.
  for (const [path, content] of writes) await writeFile(path, content);
}

/** Parse `target@version` arguments of the `prepare` command. */
export function parseTrainArguments(args: readonly string[]): ReleaseTrain['releases'] {
  return args.map((argument) => {
    const [target, version] = argument.split('@');
    const known = ReleaseTargetSchema.safeParse(target);
    if (!known.success || version === undefined || version === '') {
      throw new Error(
        `Expected <core|tui|create-stitchkit>@X.Y.Z, got ${JSON.stringify(argument)}`,
      );
    }
    return { target: known.data, version };
  });
}
