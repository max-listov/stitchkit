import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A starter release is two halves, and only one of them was ever checked.
 *
 * `AGENTS.md` has always said "update the template's single `catalog.stitchkit`
 * target **and lockfile**". `assertCatalogIsTheOnlyStitchkitRange` holds the
 * first half — the range is written in exactly one place. Nothing held the
 * second, and 0.4.1 shipped with a range of `^0.60.0` and a lockfile pinning
 * 0.60.0 on the day 0.60.1 existed. The published scaffolder then installed the
 * previous framework, which reading the manifest could not reveal and only a
 * real `bunx create-stitchkit && bun install` did. Cost: an entire extra
 * release cycle.
 *
 * Sideways, the same staleness lies to the gate: `--mode=target
 * --frozen-lockfile` proves the PREVIOUS framework release still works.
 */

/** The npm registry's abbreviated metadata document, as much of it as matters. */
const REGISTRY = 'https://registry.npmjs.org';

/**
 * Just the call — not the whole `fetch` object.
 *
 * `typeof fetch` carries Bun's `preconnect`, which no test double has and no
 * caller here uses. Asking for the shape actually needed is what lets the
 * offline and error-status cases be checked at all.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The version `bun.lock` actually resolves `stitchkit` to.
 *
 * `bun.lock` is JSONC — trailing commas and all — so the entry is read for what
 * it is: the `packages` row whose resolution string is `stitchkit@x.y.z`. A
 * lockfile with no such row is not a lockfile for this template.
 */
export function lockedStitchkitVersion(lock: string): string {
  const entry = /"stitchkit":\s*\[\s*"stitchkit@([^"]+)"/.exec(lock);
  const version = entry?.[1];
  if (!version) {
    throw new Error(
      'template/bun.lock has no resolved `stitchkit` entry, so what a fresh scaffold would install cannot be read. Run `bun install` in the template.',
    );
  }
  return version;
}

/**
 * A range that is not a range must say so.
 *
 * `Bun.semver.satisfies` answers `true` for anything it cannot parse, so
 * `catalog:` and `latest` both "match" every published version — and the gate
 * would then demand that the lockfile pin npm's absolute newest, refusing with a
 * message about staleness for what is really a typo. It still fails closed, but
 * it sends the reader after the wrong thing.
 */
export function assertRangeIsARange(range: string): void {
  if (!/^(\*|[\^~]?\d|[><]=?\s*\d|=\s*\d)/.test(range.trim())) {
    throw new Error(
      `The starter's catalog.stitchkit is "${range}", which is not a version range. It should look like "^0.60.1". A literal "catalog:" belongs in the dependency entries, not in the catalog block itself.`,
    );
  }
}

/** The newest non-prerelease version satisfying `range`, or null if none does. */
export function newestSatisfying(range: string, versions: readonly string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (version.includes('-')) continue;
    if (!Bun.semver.satisfies(version, range)) continue;
    if (best === null || Bun.semver.order(version, best) > 0) best = version;
  }
  return best;
}

/**
 * Refuse a starter release whose lockfile is behind its own range.
 *
 * The comparison is deliberately against what the range ALLOWS rather than
 * against the newest thing on npm: a starter that deliberately targets an older
 * minor is a legitimate release, and its lockfile is correct at that minor's
 * newest patch. What is never correct is a lockfile that installs less than the
 * range it ships with — that is the manifest promising one thing and the
 * resolution delivering another.
 */
export function assertLockfileResolvesNewest(
  locked: string,
  range: string,
  published: readonly string[],
): void {
  assertRangeIsARange(range);
  const newest = newestSatisfying(range, published);
  if (newest === null) {
    throw new Error(
      `The starter targets stitchkit "${range}" and npm publishes nothing that satisfies it (${published.length} versions seen). A starter release must target a range that already exists on npm — check catalog.stitchkit in template/package.json, then run \`bun run update:starter\`.`,
    );
  }
  if (!Bun.semver.satisfies(locked, range)) {
    throw new Error(
      `template/bun.lock resolves stitchkit ${locked}, which its own range "${range}" does not even allow. Run \`bun run update:starter\` in the template and commit the lockfile.`,
    );
  }
  if (Bun.semver.order(locked, newest) < 0) {
    throw new Error(
      `template/bun.lock resolves stitchkit ${locked}, but the range "${range}" it ships with allows ${newest}, which is published. A scaffold from this release would install ${locked} — the manifest would promise one framework version and the install would deliver an older one. Run \`bun run update:starter\` in the template and commit both files.`,
    );
  }
}

/**
 * Every published version of a package.
 *
 * The registry is an external dependency of this gate, and an unreachable one
 * is a refusal rather than a pass. A check that silently succeeds when it
 * cannot run is worse than no check: it reports a green that means nothing, and
 * it does so precisely on the release where the network was flaky.
 */
export async function publishedVersions(
  packageName: string,
  fetchImplementation: FetchLike = fetch,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchImplementation(`${REGISTRY}/${packageName}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (cause) {
    throw new Error(
      `Could not reach the npm registry to check what "${packageName}" publishes, so the starter lockfile cannot be verified against it. This gate refuses rather than passing on an unanswered question.`,
      { cause },
    );
  }
  if (!response.ok) {
    throw new Error(
      `The npm registry answered ${response.status} for "${packageName}", so the starter lockfile cannot be verified against it.`,
    );
  }
  const document: unknown = await response.json();
  const versions =
    typeof document === 'object' && document !== null
      ? Reflect.get(document, 'versions')
      : null;
  if (typeof versions !== 'object' || versions === null) {
    throw new Error(`The npm registry returned no version list for "${packageName}".`);
  }
  return Object.keys(versions);
}

/**
 * How a check reads the tree it is judging.
 *
 * The working tree by default. A pre-push check reads the COMMIT being pushed
 * instead: the push publishes the commit, and a check that answers about the
 * working tree can pass while the thing going to the server is broken.
 */
export type ReleaseTreeReader = (relativePath: string) => Promise<string>;

/** Read relative to `root` — the default for everything but a pre-push check. */
export function readFromWorkingTree(root: string): ReleaseTreeReader {
  return (relativePath) => readFile(join(root, relativePath), 'utf8');
}

/** The template's range and its lockfile resolution, read from the tree. */
export async function readStarterResolution(
  root: string,
  read: ReleaseTreeReader = readFromWorkingTree(root),
): Promise<{ range: string; locked: string }> {
  const template = 'packages/create-stitchkit/template';
  const manifest: unknown = JSON.parse(await read(`${template}/package.json`));
  const catalog =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'catalog')
      : null;
  const range =
    typeof catalog === 'object' && catalog !== null ? Reflect.get(catalog, 'stitchkit') : null;
  if (typeof range !== 'string' || range.length === 0) {
    throw new Error('template/package.json has no string catalog.stitchkit');
  }
  return {
    range,
    locked: lockedStitchkitVersion(await read(`${template}/bun.lock`)),
  };
}

/** Both halves of a starter release, checked together. */
export async function assertStarterLockfileIsCurrent(
  root: string,
  fetchImplementation: FetchLike = fetch,
  read: ReleaseTreeReader = readFromWorkingTree(root),
): Promise<void> {
  const { range, locked } = await readStarterResolution(root, read);
  assertLockfileResolvesNewest(
    locked,
    range,
    await publishedVersions('stitchkit', fetchImplementation),
  );
}
