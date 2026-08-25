import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStarterLockfileIsCurrent, type FetchLike } from './starter-lockfile';

const ZERO_SHA = /^0+$/;

export type ReleaseTarget = 'core' | 'create-stitchkit';

export interface ReleasePlan {
  target: ReleaseTarget;
  packageName: string;
  packageDir: string;
  changelog: string;
  version: string;
}

export interface ReleaseTagPush {
  tag: string;
  /** The SHA git is actually sending — NOT whatever the local tag name resolves to. */
  sha: string;
}

export interface PrePushPlan {
  verify: boolean;
  releaseTags: ReleaseTagPush[];
  /** Local SHAs of the pushed branch tips — where a release commit can sit. */
  branchHeads: string[];
}

function preOneMinor(version: string): number | null {
  const match = /^0\.(\d+)\.\d+(?:[-+].*)?$/.exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function caretPreOneMinor(range: string): number | null {
  const match = /^\^0\.(\d+)\.\d+(?:[-+].*)?$/.exec(range);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/**
 * A hard-cut core minor can temporarily outrun the still-published starter.
 * That bridge is never implicit: without an exact-version deferred review the
 * HEAD lane runs and exposes template drift on the SHA that created it.
 * Unknown version/range/review forms fail closed by running the lane.
 */
export function shouldRunStarterHeadLane(
  coreVersion: string,
  starterTarget: string,
  releaseNotes: string,
  review?: unknown,
): boolean {
  if (!releaseNotes.includes('### ⚠️ Breaking changes')) return true;
  const coreMinor = preOneMinor(coreVersion);
  const targetMinor = caretPreOneMinor(starterTarget);
  if (coreMinor === null || targetMinor === null) return true;
  if (coreMinor === targetMinor) return true;
  if (typeof review !== 'object' || review === null) return true;
  const reviewedVersion = Reflect.get(review, 'coreVersion');
  const outcome = Reflect.get(review, 'outcome');
  const reason = Reflect.get(review, 'reason');
  return !(
    reviewedVersion === coreVersion &&
    outcome === 'deferred' &&
    typeof reason === 'string' &&
    reason.trim().length > 0
  );
}

export function releasePlanForTag(tag: string): ReleasePlan {
  if (tag.startsWith('create-stitchkit-v')) {
    const version = tag.slice('create-stitchkit-v'.length);
    if (!version) throw new Error('create-stitchkit release tag is missing a version');
    return {
      target: 'create-stitchkit',
      packageName: 'create-stitchkit',
      packageDir: 'packages/create-stitchkit',
      changelog: 'packages/create-stitchkit/CHANGELOG.md',
      version,
    };
  }
  if (tag.startsWith('v')) {
    const version = tag.slice(1);
    if (!version) throw new Error('stitchkit release tag is missing a version');
    return {
      target: 'core',
      packageName: 'stitchkit',
      packageDir: 'packages/core',
      changelog: 'CHANGELOG.md',
      version,
    };
  }
  throw new Error(`Unsupported release tag "${tag}"`);
}

export function extractReleaseNotes(changelog: string, version: string): string {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^## \\[${escaped}\\]`);
  // Walk line-by-line tracking fence state — a `## [x.y.z]` INSIDE a code
  // fence is example text, not a section boundary.
  const lines = changelog.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (start === -1) {
      if (headingPattern.test(line)) start = index + 1;
    } else if (/^## \[/.test(line)) {
      end = index;
      break;
    }
  }
  if (start === -1) throw new Error(`Changelog has no non-empty section for ${version}`);
  const notes = lines.slice(start, end).join('\n').trim();
  // Substance, not mere non-emptiness: a lone `### Added`, an HTML comment or
  // a stray dot must not pass as release notes.
  const meaningful = notes
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s/.test(line))
    .join('\n');
  if (meaningful.replace(/[^\p{L}\p{N}]/gu, '').length < 10) {
    throw new Error(`Changelog section for ${version} carries no substantive notes`);
  }
  return notes;
}

/** The exact heading that marks a release as breaking. */
const BREAKING_HEADING = /^### \s*\u26a0\ufe0f?\s*Breaking changes/m;

/**
 * Whether a heading occurs outside every fenced block — the same rule
 * `extractReleaseNotes` applies, because a heading inside an example is
 * documentation, not structure.
 */
function headingOutsideFences(document: string, heading: RegExp): boolean {
  let inFence = false;
  for (const line of document.split('\n')) {
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && heading.test(line)) return true;
  }
  return false;
}

/**
 * Released versions in changelog order, newest first. Fence-aware for the same
 * reason `extractReleaseNotes` is: a `## [x.y.z]` inside an example block is
 * documentation, not a release.
 */
export function releasedVersionsInOrder(changelog: string): string[] {
  const versions: string[] = [];
  let inFence = false;
  for (const line of changelog.split('\n')) {
    if (/^(`{3,}|~{3,})/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (heading?.[1] !== undefined) versions.push(heading[1]);
  }
  return versions;
}

/**
 * A breaking change may never ship as a patch. The whole breaking-change policy
 * rests on the caret being a real gate — `^0.56.0` stops before `0.57.0`, so a
 * consumer crosses a break only on purpose. Ship that break as `0.56.1` and
 * every caret consumer takes it on a plain `install`, silently, which is the one
 * outcome the policy exists to prevent. The reverse (additive shipped as a
 * minor) only costs an upgrade nobody needed, so it is not gated.
 */
/**
 * A migration channel: where a package's upgrade guide lives, and the oldest
 * version it holds an individual section for.
 *
 * Both packages have one, and for the same reason. The changelog says WHAT
 * changed; the guide says what else stops working because of it, which is the
 * half an agent moving a frozen consumer needs. A generated project is a
 * consumer too — its operator steps (delete these supervisor processes, rename
 * these variables) were being written into the starter changelog, where the
 * next release overwrites them.
 *
 * The floors differ because the channels started at different times. Breaking
 * releases below a floor are covered by the summary sections at the end of the
 * guide, so the gate starts there instead of demanding retroactive sections
 * nobody will read.
 */
export interface MigrationChannel {
  guidePath: string;
  floor: string;
}

export const MIGRATION_CHANNELS: Record<ReleaseTarget, MigrationChannel> = {
  core: { guidePath: 'docs/guide/upgrading.md', floor: '0.44.0' },
  'create-stitchkit': { guidePath: 'packages/create-stitchkit/UPGRADING.md', floor: '0.4.0' },
};

function comparePreOneVersions(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0, leftPatch = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0, rightPatch = 0] = right.split('.').map(Number);
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  if (leftMinor !== rightMinor) return leftMinor - rightMinor;
  return leftPatch - rightPatch;
}

/**
 * A breaking release must carry the section that explains it.
 *
 * The changelog says WHAT changed in one mechanical line per item; the upgrade
 * guide says what else stops compiling because of it, which is the half an
 * agent moving a frozen consumer actually needs. That half was written twice
 * and lost twice: an author writes it under `## Unreleased migration:`, the
 * release commit does not promote it, and the next author reuses the heading.
 * Promotion is what this gate makes non-optional.
 */
export function assertMigrationSection(
  guide: string,
  version: string,
  releaseNotes: string,
  channel: MigrationChannel = MIGRATION_CHANNELS.core,
): void {
  if (!BREAKING_HEADING.test(releaseNotes)) return;
  if (comparePreOneVersions(version, channel.floor) < 0) return;

  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## Released migration: ${escaped}\\s*$`, 'm');
  if (!headingOutsideFences(guide, heading)) {
    throw new Error(
      `${version} carries a "### ⚠️ Breaking changes" section, so ${channel.guidePath} must carry "## Released migration: ${version}". Promote the "## Unreleased migration: …" heading that describes it in this release commit — an unpromoted section is overwritten by the next breaking change.`,
    );
  }

  // Proving that ONE heading was promoted is half the check. A release with six
  // queued sections satisfies it by promoting the first and forgetting five, and
  // the leftovers are then overwritten by the next author — which is exactly the
  // 0.57.0 failure this gate exists for. The queue has to be empty.
  const queued = countUnreleasedMigrations(guide);
  if (queued > 0) {
    throw new Error(
      `${channel.guidePath} still carries ${queued} "## Unreleased migration: …" section${queued === 1 ? '' : 's'} after releasing ${version}. Promote every one of them — a section left queued is overwritten by the next breaking change and lost.`,
    );
  }
}

/** Queued migration headings outside fenced blocks. */
function countUnreleasedMigrations(guide: string): number {
  let fenced = false;
  let seen = 0;
  for (const line of guide.split('\n')) {
    if (line.startsWith('```')) fenced = !fenced;
    else if (!fenced && line.startsWith('## Unreleased migration:')) seen += 1;
  }
  return seen;
}

export function assertVersionCalibre(changelog: string, version: string): void {
  const notes = extractReleaseNotes(changelog, version);
  if (!BREAKING_HEADING.test(notes)) return;

  const released = releasedVersionsInOrder(changelog);
  const index = released.indexOf(version);
  if (index === -1) {
    // The version has release notes (`extractReleaseNotes` found them) but no
    // `## [x.y.z]` heading — a pre-release spelling like `## [0.56.1-rc.1]`.
    // Returning here skipped the breaking-as-patch gate entirely for exactly
    // the shape most likely to carry an unreviewed break.
    throw new Error(
      `${version} carries release notes but no "## [${version}]" heading in the changelog, so its calibre cannot be checked. Release headings are plain x.y.z.`,
    );
  }
  const previous = released[index + 1];
  if (previous === undefined) return;

  const current = version.split('.').map(Number);
  const prior = previous.split('.').map(Number);
  const isPatchBump =
    current[0] === prior[0] && current[1] === prior[1] && (current[2] ?? 0) > (prior[2] ?? 0);
  if (!isPatchBump) return;

  throw new Error(
    `${version} carries a "### \u26a0\ufe0f Breaking changes" section but is a patch bump from ${previous}. A caret consumer takes a patch on a plain install — bump the minor so crossing the break stays an explicit opt-in.`,
  );
}

export function classifyPrePush(input: string): PrePushPlan {
  let verify = false;
  const releaseTags = new Map<string, string>();
  const branchHeads = new Set<string>();
  for (const line of input.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 4) continue;
    // git speaks `<local ref> <local sha> <remote ref> <remote sha>`. The
    // REMOTE ref decides what this push changes — the local ref is `HEAD` for
    // `git push origin HEAD:master` and a bare SHA for `<sha>:refs/tags/…`,
    // so classifying by it misses exactly those forms.
    const [, localSha, remoteRef] = fields;
    if (!remoteRef || !localSha || ZERO_SHA.test(localSha)) continue;
    if (remoteRef.startsWith('refs/heads/')) {
      verify = true;
      branchHeads.add(localSha);
    }
    if (remoteRef.startsWith('refs/tags/')) {
      const tag = remoteRef.slice('refs/tags/'.length);
      if (tag.startsWith('v') || tag.startsWith('create-stitchkit-v')) {
        // `git push origin <sha>:refs/tags/vX` sends a SHA the local tag name
        // may not point at — classify by what is on the wire.
        releaseTags.set(tag, localSha);
      }
    }
  }
  return {
    verify,
    releaseTags: [...releaseTags].map(([tag, sha]) => ({ tag, sha })),
    branchHeads: [...branchHeads],
  };
}

/**
 * Whether a pushed commit is the release commit itself. The tag gates check the
 * exact version; this only needs the shape, because it answers a different
 * question — is this push the one release preparation, and therefore the last
 * cheap moment to prove the starter template still builds on HEAD.
 */
export function isReleaseCommitSubject(subject: string): boolean {
  return /^release\((?:core|starter)\):/.test(subject.trim());
}

/** What the local gate runs for one push. */
export type LocalGateProfile = 'none' | 'fast' | 'full';

/**
 * Which local gate a push earns — and the reasoning is entirely about what a
 * RED CI run costs on the commit being pushed.
 *
 * For an ordinary commit it costs two and a half minutes and a follow-up push.
 * For a release commit it cannot be paid at all: `assert-subject` requires the
 * tag to sit on a `release(...)` commit and `assert-head` requires that commit
 * to be the branch head, so a red run on a pushed release commit is repaired
 * only by making a NEW release commit. That asymmetry, not a general distrust
 * of CI, is what the expensive local gate buys — so it runs exactly where the
 * asymmetry is.
 *
 * The fast profile is not a weaker copy of CI. It is the part that is genuinely
 * faster to learn locally: lint, types and unit tests answer in well under a
 * minute, where the packed lanes are parallel by nature and slower here than on
 * ten runners. → `AGENTS.md`, "What runs where".
 */
export function localGateProfile(
  plan: PrePushPlan,
  pushesReleaseCommit: boolean,
): LocalGateProfile {
  if (!plan.verify) return 'none';
  return pushesReleaseCommit ? 'full' : 'fast';
}

/** Fail unless the tag points at the current release head of the default branch. */
export function assertTagOnReleaseHead(tagSha: string, remoteHeadSha: string): void {
  if (!tagSha || !remoteHeadSha || tagSha !== remoteHeadSha) {
    throw new Error(
      `release tag must point at the current origin/master SHA (tag ${tagSha || '(none)'}, master ${remoteHeadSha || '(none)'})`,
    );
  }
}

/** The commit-subject scope each tag namespace must carry. */
export function releaseScopeForTag(tag: string): 'core' | 'starter' {
  return tag.startsWith('create-stitchkit-v') ? 'starter' : 'core';
}

/**
 * Fail unless the tagged commit IS the release commit of that exact version.
 *
 * `assertTagOnReleaseHead` proves the tag sits on the branch head; it cannot
 * tell a release commit from whatever landed on top of it. 0.55.0 was tagged
 * on a follow-up test fix because the release commit was pushed before its CI
 * was green — the tag then had to move to the new head, and `git show <tag>`
 * points at the wrong change forever. Requiring the release subject makes the
 * honest order ("fixes first, release commit last, green, then tag") the only
 * one that reaches publication.
 *
 * The version is matched on digit/dot boundaries so `0.56.0-rc.1` and
 * `10.56.0` never satisfy `0.56.0`, and the scope must match the tag
 * namespace so a starter release commit cannot carry a core tag.
 */
export function assertReleaseCommitSubject(
  subject: string,
  version: string,
  scope: 'core' | 'starter',
): void {
  const trimmed = subject.trim();
  const expected = `release(${scope})`;
  if (!trimmed.startsWith(`${expected}:`)) {
    throw new Error(
      `release tag must point at a "${expected}: … in ${version}" commit — its subject is ${trimmed === '' ? '(empty)' : JSON.stringify(trimmed)}. Land fixes first, make the release commit last, wait for green, then tag.`,
    );
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(?<![\\d.])${escaped}(?![\\d.\\-+])`).test(trimmed)) {
    throw new Error(
      `release commit subject must name version ${version} exactly — got ${JSON.stringify(trimmed)}`,
    );
  }
}

export interface CiRunSummary {
  id: number;
  head_sha: string;
  event: string;
  conclusion: string | null;
}

/** The successful exact-SHA push run of the heavy CI — or a loud, specific refusal. */
export function selectSuccessfulCiRun(runs: readonly CiRunSummary[], sha: string): number {
  const matching = runs.filter((run) => run.head_sha === sha && run.event === 'push');
  const successful = matching.find((run) => run.conclusion === 'success');
  if (successful) return successful.id;
  if (matching.length === 0) {
    throw new Error(`no push CI run exists for exact SHA ${sha}`);
  }
  throw new Error(
    `no successful push CI run for exact SHA ${sha} — found: ${matching
      .map((run) => run.conclusion ?? 'pending')
      .join(', ')}`,
  );
}

/**
 * Idempotent publish decision: absent → publish; identical tarball → skip
 * (a re-run of the workflow); a DIFFERENT published tarball is fraud/mistake
 * and must never be skipped silently.
 */
export function decidePublishAction(
  artifactShasum: string,
  publishedShasum: string | null,
): 'publish' | 'skip' {
  if (!artifactShasum) throw new Error('artifact shasum is required');
  if (publishedShasum === null || publishedShasum === '') return 'publish';
  if (publishedShasum === artifactShasum) return 'skip';
  throw new Error('version already exists on npm with a DIFFERENT tarball — refusing');
}

/**
 * How the release-metadata gate reaches the registry.
 *
 * Injectable so the WIRING can be checked without a network — which is the half
 * that unit-testing `assertLockfileResolvesNewest` never covered. The two facts
 * worth proving are that a starter tag reaches the registry and that a core tag
 * does not, and neither is visible from the pieces.
 */
export interface ValidateReleaseTagOptions {
  fetch?: FetchLike;
}

export async function validateReleaseTag(
  root: string,
  tag: string,
  options: ValidateReleaseTagOptions = {},
): Promise<ReleasePlan & { notes: string }> {
  const plan = releasePlanForTag(tag);
  const manifest: unknown = JSON.parse(
    await readFile(join(root, plan.packageDir, 'package.json'), 'utf8'),
  );
  const packageVersion =
    typeof manifest === 'object' &&
    manifest !== null &&
    Object.hasOwn(manifest, 'version') &&
    typeof Reflect.get(manifest, 'version') === 'string'
      ? Reflect.get(manifest, 'version')
      : null;
  if (packageVersion === null) {
    throw new Error(`${plan.packageDir}/package.json has no string version`);
  }
  if (packageVersion !== plan.version) {
    throw new Error(
      `${tag} does not match ${plan.packageName} package version ${packageVersion}`,
    );
  }
  const changelog = await readFile(join(root, plan.changelog), 'utf8');
  const notes = extractReleaseNotes(changelog, plan.version);
  assertVersionCalibre(changelog, plan.version);
  // Both packages, each through its own channel. The scaffolder's guide is for
  // the operator of a GENERATED project — the steps a new version needs before
  // it will start — which is a different reader from the framework's, and a
  // reason for a second guide rather than an argument against one.
  const channel = MIGRATION_CHANNELS[plan.target];
  assertMigrationSection(
    await readFile(join(root, channel.guidePath), 'utf8'),
    plan.version,
    notes,
    channel,
  );
  // A starter release is the range AND the lockfile. Only the release channel
  // checks this: outside a release a lockfile lagging its range is ordinary and
  // legitimate, and gating it there would turn every framework publication into
  // a template chore.
  if (plan.target === 'create-stitchkit') {
    await assertStarterLockfileIsCurrent(root, options.fetch);
  }
  return { ...plan, notes };
}

/**
 * Shared CI/pre-push decision. HEAD runs by default; the only skip is an
 * exact-version, explicitly deferred review of an unaligned hard cut.
 */
async function starterHeadDecision(root: string): Promise<'run' | 'skip'> {
  const coreManifest: unknown = JSON.parse(
    await readFile(join(root, 'packages/core/package.json'), 'utf8'),
  );
  const starterManifest: unknown = JSON.parse(
    await readFile(join(root, 'packages/create-stitchkit/template/package.json'), 'utf8'),
  );
  const coreVersion =
    typeof coreManifest === 'object' && coreManifest !== null
      ? Reflect.get(coreManifest, 'version')
      : undefined;
  const catalog =
    typeof starterManifest === 'object' && starterManifest !== null
      ? Reflect.get(starterManifest, 'catalog')
      : undefined;
  const starterTarget =
    typeof catalog === 'object' && catalog !== null
      ? Reflect.get(catalog, 'stitchkit')
      : undefined;
  if (typeof coreVersion !== 'string' || typeof starterTarget !== 'string') {
    throw new Error('core version and starter catalog.stitchkit must be strings');
  }
  const releaseNotes = extractReleaseNotes(
    await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    coreVersion,
  );
  const reviewPath = join(root, 'scripts/starter-head-review.json');
  const reviewFile = Bun.file(reviewPath);
  const review: unknown = (await reviewFile.exists())
    ? JSON.parse(await reviewFile.text())
    : undefined;
  return shouldRunStarterHeadLane(coreVersion, starterTarget, releaseNotes, review)
    ? 'run'
    : 'skip';
}

function CiRunListSchema(value: unknown): CiRunSummary[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array of workflow runs');
  return value.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error('expected workflow run objects');
    }
    const id = Reflect.get(item, 'id');
    const headSha = Reflect.get(item, 'head_sha');
    const event = Reflect.get(item, 'event');
    const conclusion = Reflect.get(item, 'conclusion');
    if (typeof id !== 'number' || typeof headSha !== 'string' || typeof event !== 'string') {
      throw new Error('workflow run entries need id, head_sha and event');
    }
    return {
      id,
      head_sha: headSha,
      event,
      conclusion: typeof conclusion === 'string' ? conclusion : null,
    };
  });
}

async function run(command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, '..'),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
}

async function output(command: string[]): Promise<string> {
  const process = Bun.spawn(command, {
    cwd: join(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const value = await new Response(process.stdout).text();
  const exitCode = await process.exited;
  if (exitCode !== 0) throw new Error(`${command.join(' ')} exited with ${exitCode}`);
  return value.trim();
}

/** Does any pushed branch tip carry the release commit subject? */
async function hasReleaseCommit(branchHeads: readonly string[]): Promise<boolean> {
  for (const sha of branchHeads) {
    const subject = await output(['git', 'log', '-1', '--format=%s', `${sha}^{commit}`]);
    if (isReleaseCommitSubject(subject)) return true;
  }
  return false;
}

async function release(target: ReleaseTarget): Promise<void> {
  const root = join(import.meta.dir, '..');
  const branch = await output(['git', 'branch', '--show-current']);
  if (branch !== 'master' && branch !== 'main') {
    throw new Error('Releases must run from master or main');
  }
  if ((await output(['git', 'status', '--porcelain'])) !== '') {
    throw new Error('Release metadata must be committed before tagging');
  }
  await run(['git', 'fetch', 'origin', branch]);
  const head = await output(['git', 'rev-parse', 'HEAD']);
  const remoteHead = await output(['git', 'rev-parse', `origin/${branch}`]);
  if (head !== remoteHead) throw new Error(`HEAD must equal origin/${branch}`);

  const packageDir = target === 'core' ? 'packages/core' : 'packages/create-stitchkit';
  const manifest: unknown = JSON.parse(
    await readFile(join(root, packageDir, 'package.json'), 'utf8'),
  );
  const version =
    typeof manifest === 'object' &&
    manifest !== null &&
    Object.hasOwn(manifest, 'version') &&
    typeof Reflect.get(manifest, 'version') === 'string'
      ? Reflect.get(manifest, 'version')
      : null;
  if (version === null) throw new Error(`${packageDir}/package.json has no string version`);
  const tag = target === 'core' ? `v${version}` : `create-stitchkit-v${version}`;
  await validateReleaseTag(root, tag);
  // The commit about to be tagged must itself be the release commit — a green
  // follow-up fix on top of it is NOT a release (see assertReleaseCommitSubject).
  assertReleaseCommitSubject(
    await output(['git', 'log', '-1', '--format=%s', head]),
    version,
    releaseScopeForTag(tag),
  );
  await run(['git', 'tag', tag, head]);
  await run(['git', 'push', 'origin', `refs/tags/${tag}`]);
}

async function main(): Promise<void> {
  const [command, argument] = Bun.argv.slice(2);
  const root = join(import.meta.dir, '..');
  if (command === 'preflight') {
    if (!argument) throw new Error('Usage: release-plan.ts preflight <tag>');
    const plan = await validateReleaseTag(root, argument);
    process.stdout.write(JSON.stringify(plan));
    return;
  }
  if (command === 'pre-push') {
    const plan = classifyPrePush(await Bun.stdin.text());
    // Cheap deterministic metadata first: a bad tag should not cost the full
    // browser/starter gate before it is reported.
    for (const { tag, sha } of plan.releaseTags) {
      const validated = await validateReleaseTag(root, tag);
      assertReleaseCommitSubject(
        await output(['git', 'log', '-1', '--format=%s', `${sha}^{commit}`]),
        validated.version,
        releaseScopeForTag(tag),
      );
    }
    const pushesReleaseCommit = plan.verify && (await hasReleaseCommit(plan.branchHeads));
    const profile = localGateProfile(plan, pushesReleaseCommit);
    if (profile === 'fast') {
      process.stderr.write(
        '[gate] ordinary push: lint, types and tests run here; the packed lanes, smokes and consumer lane run on CI, which is the authority for publication either way.\n',
      );
      await run(['bun', 'scripts/verify.ts', '--fast', '--if-changed']);
    }
    if (profile === 'full') {
      await run(['bun', 'scripts/verify.ts', '--if-changed']);
      // A release commit is the last cheap moment to learn that the starter
      // template no longer builds on HEAD. `verify` runs only the target lane,
      // so without this the answer arrives from a red CI run on the release
      // commit itself — the one commit whose run must be green before it is
      // tagged. Same policy as CI: a hard-cut minor may outrun the template
      // only after an exact-version review records the deferred migration debt.
      if ((await starterHeadDecision(root)) === 'run') {
        await run(['bun', 'scripts/verify.ts', '--head', '--if-changed']);
      } else {
        process.stderr.write(
          '[release] skipping packed HEAD for an exact-version deferred starter review; target remains mandatory and scripts/starter-head-review.json owns the migration debt.\n',
        );
      }
    }
    return;
  }
  if (command === 'release') {
    if (argument !== 'core' && argument !== 'create-stitchkit') {
      throw new Error('Usage: release-plan.ts release <core|create-stitchkit>');
    }
    await release(argument);
    return;
  }
  if (command === 'assert-subject') {
    const [, subject, version, tag] = Bun.argv.slice(2);
    assertReleaseCommitSubject(subject ?? '', version ?? '', releaseScopeForTag(tag ?? ''));
    return;
  }
  if (command === 'assert-head') {
    const [, tagSha, remoteHeadSha] = Bun.argv.slice(2);
    assertTagOnReleaseHead(tagSha ?? '', remoteHeadSha ?? '');
    return;
  }
  if (command === 'select-ci-run') {
    if (!argument) throw new Error('Usage: release-plan.ts select-ci-run <sha> < runs.json');
    const runs = CiRunListSchema(JSON.parse(await Bun.stdin.text()));
    process.stdout.write(String(selectSuccessfulCiRun(runs, argument)));
    return;
  }
  if (command === 'publish-action') {
    const [, artifactShasum, publishedShasum] = Bun.argv.slice(2);
    process.stdout.write(decidePublishAction(artifactShasum ?? '', publishedShasum ?? null));
    return;
  }
  if (command === 'starter-head') {
    process.stdout.write(await starterHeadDecision(root));
    return;
  }
  throw new Error(
    'Usage: release-plan.ts <preflight TAG|pre-push|release TARGET|assert-head TAG_SHA HEAD_SHA|select-ci-run SHA|publish-action ARTIFACT_SHA [PUBLISHED_SHA]|starter-head>',
  );
}

if (import.meta.main) {
  await main();
}
