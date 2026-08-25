/**
 * What the artifact was built FROM, so a release can tell whether it still is.
 *
 * `assertBuildArtifacts()` checked that the declared paths exist. Existence is
 * not freshness: `pm2:prod` run without a build applies the migrations this
 * source declares and then starts the `dist` and `.next` of an earlier one. The
 * schema moves ahead of the code, which is the worst direction — rolling the
 * code back does not roll the schema back with it.
 *
 * So the build leaves a stamp: one digest over the source it read. The release
 * recomputes it and compares. A digest, not a timestamp, because a checkout
 * rewrites every mtime and a formatter rewrites some for no change at all —
 * both would make the gate cry wolf, and a gate nobody believes is worse than
 * none.
 *
 * **Everything is source until something says otherwise, and the something is
 * named.** The first version of this listed what to skip by *kind* — every
 * `.md`, every test file, every directory called `generated` — which reads as
 * "these cannot affect a build" and is only true of the project as it stands
 * today. A project that imports MDX, or keeps checked-in source in a directory
 * it happened to call `generated`, would change its content, keep its digest,
 * and be told its old artifact was current. A digest that answers "fresh" about
 * a stale build is worse than no digest.
 *
 * So the exclusions are now exactly three kinds, each named rather than guessed:
 *
 * - **The build's own OUTPUTS**, read from `build.artifacts` in the project
 *   declaration. One source of truth: a project that adds an artifact is
 *   covered by declaring it, and `packages/db/src/generated` is skipped because
 *   the declaration calls it output — not because of its name.
 * - **Not this project's source at all**: `node_modules`, `.git`. (`bun.lock`
 *   is source and is hashed.)
 * - **Runtime state**: `.env*`, logs, and the directories a test run writes.
 *   `.env` is deliberate and not an oversight — a binding is not an input to
 *   this build, which is the whole point of forbidding `NEXT_PUBLIC_*` env
 *   reads and of building the packed lane against a database that accepts
 *   nothing. Hashing it would refuse a correct artifact every time a deployment
 *   edited its own environment: the same gate, crying wolf in the other
 *   direction.
 *
 * The cost is that editing a README or a test now asks for a rebuild before a
 * release. That is the safe direction: the gate can be wrong about "stale", and
 * must never be wrong about "fresh".
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { appDeclaration } from '../packages/config/src/declaration';

const root = resolve(import.meta.dir, '..');

export const BUILD_STAMP_PATH = '.build-stamp.json';

/** Not this project's source, and state a test run leaves behind. */
const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'coverage',
  'test-results',
  'playwright-report',
]);

function isIgnoredFile(name: string): boolean {
  return (
    name === BUILD_STAMP_PATH ||
    // Written by `next typegen`, which `bun run check` runs — a generated file
    // sitting at a package root rather than inside a declared artifact, and one
    // that exists or not depending on whether anyone has run `check` yet.
    name === 'next-env.d.ts' ||
    // A binding, not an input. See the note above.
    name.startsWith('.env') ||
    name.endsWith('.log')
  );
}

/** The declared outputs, as normalised relative paths. */
function outputPaths(artifacts: readonly string[]): string[] {
  return artifacts.map((artifact) => artifact.replaceAll('\\', '/').replace(/\/+$/, ''));
}

function sourceFiles(
  from: string,
  outputs: readonly string[],
  directory: string = from,
  found: string[] = [],
): string[] {
  for (const entry of readdirSync(directory).sort()) {
    const path = join(directory, entry);
    const relativePath = relative(from, path).replaceAll('\\', '/');
    if (outputs.includes(relativePath)) continue;
    if (statSync(path).isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      sourceFiles(from, outputs, path, found);
    } else if (!isIgnoredFile(entry)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * One digest over every file a build of this project reads.
 *
 * `artifacts` defaults to what the declaration says the build produces, so the
 * one list a deployment tool reads is the one this skips.
 */
export function sourceDigest(
  from: string = root,
  artifacts: readonly string[] = appDeclaration.build?.artifacts ?? [],
): string {
  const digest = createHash('sha256');
  for (const path of sourceFiles(from, outputPaths(artifacts))) {
    // The PATH goes in too: moving a file changes the build without changing
    // any byte inside it.
    digest.update(relative(from, path));
    digest.update('\0');
    digest.update(readFileSync(path));
    digest.update('\0');
  }
  return `sha256:${digest.digest('hex')}`;
}

const BuildStampSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.string().startsWith('sha256:'),
});

export function writeBuildStamp(
  from: string = root,
  artifacts: readonly string[] = appDeclaration.build?.artifacts ?? [],
): string {
  const source = sourceDigest(from, artifacts);
  writeFileSync(
    join(from, BUILD_STAMP_PATH),
    `${JSON.stringify({ schemaVersion: 1, source }, null, 2)}\n`,
  );
  return source;
}

/**
 * Refuse an artifact that is not this source's.
 *
 * A missing stamp is refused too, and deliberately: it means the artifact was
 * produced by something other than this build, and "we cannot tell" is not a
 * reason to start it.
 */
export function assertArtifactMatchesSource(
  from: string = root,
  artifacts: readonly string[] = appDeclaration.build?.artifacts ?? [],
): void {
  const path = join(from, BUILD_STAMP_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `No build stamp beside the artifacts (${BUILD_STAMP_PATH}). Run \`bun run build\` — a release will not start an artifact it cannot tie to this source.`,
    );
  }
  const stamp = BuildStampSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  const current = sourceDigest(from, artifacts);
  if (stamp.source !== current) {
    throw new Error(
      `The built artifacts are not this source's: the stamp says ${stamp.source.slice(0, 19)}…, the tree hashes to ${current.slice(0, 19)}…. Run \`bun run build\` before releasing — otherwise the declared migrations of this source are applied to a deployment running the previous one.`,
    );
  }
}

if (import.meta.main) {
  console.log(`Build stamped: ${writeBuildStamp()}`);
}
