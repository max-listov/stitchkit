import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type PublishedTreeReader,
  type RequiredCompanion,
  readFromReleaseTags,
  requiredCompanions,
} from './release-companions';
import { CADENCE_GUIDE, promoteMigrationHeading, refreshCadence } from './release-derived';
import {
  RELEASE_TARGETS,
  ReleaseTargetSchema,
  type ReleaseTrain,
  ReleaseTrainSchema,
  releaseTagForTarget,
} from './release-train';
import { publishedEntrypoints } from './release-validate';

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

/** The date an earlier `prepare` already wrote on `## [version] - YYYY-MM-DD`, if present. */
function existingRolledDate(
  changelog: string | undefined,
  version: string,
): string | undefined {
  if (changelog === undefined) return undefined;
  const escaped = version.replaceAll('.', '\\.');
  return new RegExp(`^## \\[${escaped}\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm').exec(
    changelog,
  )?.[1];
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
 * The line a required companion's changelog gets: the range it now publishes
 * for the release that requires it. A host on the previous framework minor reads
 * here why installing the companion asks it to move, whether or not the
 * companion has changes of its own.
 */
function companionNote(required: RequiredCompanion): string {
  const companion = RELEASE_TARGETS[required.companion].packageName;
  const rider = RELEASE_TARGETS[required.requiredBy.target].packageName;
  const role = required.packed.field === 'peerDependencies' ? 'peer' : 'dependency';
  return `- \`${companion}\` accepts \`${rider}@${required.packed.range}\` as its ${role}, so a project installing both gets one copy of \`${rider}\`.`;
}

/** Bump a patch: the version a companion takes when it only rides along. */
function nextPatch(version: string): string {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

/** Add `note` as the last item of the `[Unreleased]` `### Changed` section, which it opens if there is none. */
function noteUnreleased(changelog: string, note: string): string {
  const heading = /^## \[Unreleased\][^\n]*\n/m.exec(changelog);
  if (!heading) throw new Error('Changelog has no Unreleased heading');
  const start = heading.index + heading[0].length;
  const next = changelog.slice(start).search(/^## \[/m);
  const end = next < 0 ? changelog.length : start + next;
  const body = changelog.slice(start, end);
  if (body.includes(note)) return changelog;
  const changed = /^### Changed[^\n]*\n/m.exec(body);
  let noted = `${body.trim()}\n\n### Changed\n\n${note}`;
  if (changed) {
    const after = changed.index + changed[0].length;
    const following = body.slice(after).search(/^### /m);
    const at = following < 0 ? body.length : after + following;
    noted = `${body.slice(0, at).trimEnd()}\n${note}\n\n${body.slice(at).trim()}`;
  }
  const rest = changelog.slice(end);
  return `${changelog.slice(0, start)}\n${noted.trim()}\n${rest === '' ? '' : `\n${rest}`}`;
}

/** Reads a file as the last commit holds it; `undefined` outside Git or for a new file. */
export type HeadReader = (path: string) => Promise<string | undefined>;

export function readFromHead(root: string): HeadReader {
  return async (path) => {
    const show = Bun.spawnSync(['git', '-C', root, 'show', `HEAD:${path}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return show.exitCode === 0 ? show.stdout.toString() : undefined;
  };
}

export interface PrepareDependencies {
  /** The committed state every derived file is computed from; defaults to `git show HEAD:`. */
  readHead?: HeadReader;
  /** Published siblings, for the companions the train must carry; defaults to release tags. */
  readPublished?: PublishedTreeReader;
}

/**
 * Write the release metadata of a train and return the paths it wrote.
 *
 * Every derived file is computed from the committed state, never from what an
 * earlier run left in the tree, so running `prepare` again writes the same
 * bytes instead of refusing (0.126.0 stumbled on that). A file that is neither
 * the committed state nor what `prepare` derives was edited after it, and the
 * run refuses rather than overwrite the edit. Derived: each target's version
 * and changelog roll; every sibling the train must carry — the next patch when
 * the train does not name it — with a line naming the range it now publishes;
 * each target's promoted migration headings (`RELEASE_TARGETS[…].migration`);
 * the maturity table's cadence; `release-train.json`. The lockfile follows from
 * `bun install`, and `release-plan.ts check` judges the result.
 */
export async function prepareTrain(
  root: string,
  requested: ReleaseTrain['releases'],
  date: string,
  dependencies: PrepareDependencies = {},
): Promise<string[]> {
  const readHead = dependencies.readHead ?? readFromHead(root);
  const live = async (path: string) => {
    const file = Bun.file(join(root, path));
    return (await file.exists()) ? file.text() : undefined;
  };
  const base = async (path: string) => {
    const committed = await readHead(path);
    if (committed !== undefined) return committed;
    const current = await live(path);
    if (current === undefined) throw new Error(`Release metadata file is missing: ${path}`);
    return current;
  };
  const readPublished = dependencies.readPublished ?? readFromReleaseTags(root);
  const releases = [...requested];
  const required = await requiredCompanions(
    ReleaseTrainSchema.parse({ schemaVersion: 1, releases }),
    async (path) => base(path),
    readPublished,
  );
  for (const { companion, version } of required)
    if (!requested.some((release) => release.target === companion))
      releases.push({ target: companion, version: nextPatch(version) });
  const derived = new Map<string, string>();
  for (const { target, version } of releases) {
    const info = RELEASE_TARGETS[target];
    const manifestPath = `${info.directory}/package.json`;
    const manifest = await base(manifestPath);
    assertNextReleaseVersion(currentVersion(manifest), version);
    let changelog = await base(info.changelog);
    const companionOf = required.find((entry) => entry.companion === target);
    if (companionOf !== undefined)
      changelog = noteUnreleased(changelog, companionNote(companionOf));
    derived.set(manifestPath, setManifestVersion(manifest, version));
    const rolledDate = existingRolledDate(await live(info.changelog), version) ?? date;
    derived.set(info.changelog, rollChangelog(changelog, version, rolledDate));
  }
  for (const { target, version } of releases) {
    const guide = RELEASE_TARGETS[target].migration.guidePath;
    if ((await live(guide)) !== undefined)
      derived.set(guide, promoteMigrationHeading(await base(guide), version));
  }
  const core = derived.get(RELEASE_TARGETS.core.changelog);
  const coreRelease = releases.find((release) => release.target === 'core');
  if (core !== undefined && coreRelease && (await live(CADENCE_GUIDE)) !== undefined) {
    const manifestPath = `${RELEASE_TARGETS.core.directory}/package.json`;
    const manifest = await base(manifestPath);
    const previous = await readPublished(
      releaseTagForTarget('core', currentVersion(manifest)),
      manifestPath,
    );
    // An entrypoint the previous release did not export ships in this one, and its row says so.
    const before = previous === undefined ? undefined : publishedEntrypoints(previous);
    const introduced = new Map(
      [...publishedEntrypoints(manifest)]
        .filter((name) => before !== undefined && !before.has(name))
        .map((name) => [name, coreRelease.version]),
    );
    derived.set(CADENCE_GUIDE, refreshCadence(await base(CADENCE_GUIDE), core, introduced));
  }
  const train = ReleaseTrainSchema.parse({ schemaVersion: 1, releases });
  derived.set('release-train.json', `${JSON.stringify(train, null, 2)}\n`);
  // Every file is computed and judged before the first is written: a refusal leaves the tree untouched.
  const edited: string[] = [];
  for (const [path, content] of derived) {
    const current = await live(path);
    const committed = await readHead(path);
    if (
      current !== undefined &&
      current !== content &&
      committed !== undefined &&
      current !== committed
    )
      edited.push(path);
  }
  if (edited.length > 0)
    throw new Error(
      `Changed after the last commit and not by prepare: ${edited.join(', ')}. Commit the change, or restore the file, and prepare again.`,
    );
  for (const [path, content] of derived) await writeFile(join(root, path), content);
  return [...derived.keys()];
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
