import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
 * A hard-cut core minor cannot be consumed by the still-published starter
 * before that core version exists on npm. Keep every ordinary HEAD lane; skip
 * only this explicit, changelog-proven release bridge. Unknown version/range
 * forms fail closed by running the lane.
 */
export function shouldRunStarterHeadLane(
  coreVersion: string,
  starterTarget: string,
  releaseNotes: string,
): boolean {
  if (!releaseNotes.includes('### ⚠️ Breaking changes')) return true;
  const coreMinor = preOneMinor(coreVersion);
  const targetMinor = caretPreOneMinor(starterTarget);
  if (coreMinor === null || targetMinor === null) return true;
  return coreMinor === targetMinor;
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
export function assertVersionCalibre(changelog: string, version: string): void {
  const notes = extractReleaseNotes(changelog, version);
  if (!/^### \s*\u26a0\ufe0f?\s*Breaking changes/m.test(notes)) return;

  const released = releasedVersionsInOrder(changelog);
  const index = released.indexOf(version);
  const previous = index === -1 ? undefined : released[index + 1];
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

export async function validateReleaseTag(
  root: string,
  tag: string,
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
  return { ...plan, notes };
}

/**
 * Whether the packed HEAD starter lane is meaningful right now. Shared by the
 * CI step and the pre-push gate so both answer from one policy: a hard-cut core
 * minor legitimately outruns a template that can only pin a published range,
 * and blocking on that would make a breaking release unshippable.
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
  return shouldRunStarterHeadLane(coreVersion, starterTarget, releaseNotes) ? 'run' : 'skip';
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
    if (plan.verify) await run(['bun', 'run', 'verify']);
    // A release commit is the last cheap moment to learn that the starter
    // template no longer builds on HEAD. `verify` runs only the target lane, so
    // without this the answer arrives from a red CI run on the release commit
    // itself — the one commit whose run must be green before it is tagged.
    // Same policy as CI: a hard-cut minor legitimately outruns the template.
    if (plan.verify && (await hasReleaseCommit(plan.branchHeads))) {
      if ((await starterHeadDecision(root)) === 'run') {
        await run(['bun', 'run', 'starter-head-lane']);
      } else {
        process.stderr.write(
          '[release] packed HEAD starter lane skipped for a breaking core release; the template stays unverified against HEAD until the next starter release reconciles it.\n',
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
