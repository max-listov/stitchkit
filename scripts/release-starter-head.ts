import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { linesOutsideFences } from './markdown-fences';
import { extractReleaseNotes } from './release-notes';

/** Where the deferred starter review lives, in the tree and in a release tag. */
export const STARTER_HEAD_REVIEW_PATH = 'scripts/starter-head-review.json';

function preOneMinor(version: string): number | null {
  const match = /^0\.(\d+)\.\d+(?:[-+].*)?$/.exec(version);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function caretPreOneMinor(range: string): number | null {
  const match = /^\^0\.(\d+)\.\d+(?:[-+].*)?$/.exec(range);
  return match?.[1] === undefined ? null : Number(match[1]);
}

/** Whether the release notes carry a `### Security` section outside fenced code blocks. */
export function hasSecuritySection(releaseNotes: string): boolean {
  return linesOutsideFences(releaseNotes).some((line) => /^### Security(?:\s|$)/.test(line));
}

/** A review that defers the starter for exactly `coreVersion`, as it was written. */
interface Deferral {
  reason: string | undefined;
  followUp: unknown;
}

/** The deferral `review` records for `coreVersion`; any other record defers nothing. */
export function deferralFor(coreVersion: string, review: unknown): Deferral | undefined {
  if (typeof review !== 'object' || review === null) return undefined;
  if (Reflect.get(review, 'coreVersion') !== coreVersion) return undefined;
  if (Reflect.get(review, 'outcome') !== 'deferred') return undefined;
  const reason = Reflect.get(review, 'reason');
  return {
    reason: typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined,
    followUp: Reflect.get(review, 'followUp'),
  };
}

/**
 * The create-stitchkit version a deferral's `followUp` names (`"create-stitchkit@X.Y.Z"`).
 * Anything else is refused: the field is the promise the next train is checked against.
 */
export function followUpStarterVersion(followUp: unknown): string {
  const match =
    typeof followUp === 'string' ? /^create-stitchkit@(\d+\.\d+\.\d+)$/.exec(followUp) : null;
  if (match?.[1] === undefined) {
    throw new Error(
      `${STARTER_HEAD_REVIEW_PATH} followUp must name the next starter release as "create-stitchkit@X.Y.Z"; got ${JSON.stringify(followUp)}.`,
    );
  }
  return match[1];
}

/** What the gate reads from the tree it decides for. */
export interface StarterHeadInputs {
  /** `packages/core/package.json` version. */
  coreVersion: string;
  /** The template's `catalog.stitchkit` range. */
  starterTarget: string;
  /** `packages/create-stitchkit/package.json` version — the starter npm already has. */
  starterVersion: string;
  /** The core release's own changelog section. */
  releaseNotes: string;
  /** The parsed `scripts/starter-head-review.json`, when the tree has one. */
  review?: unknown;
}

/**
 * Refuse a deferral the release cannot honour. A `followUp` must name a later starter. A
 * `### Security` release may defer only a starter on another pre-1.0 minor, which a caret
 * keeps off the fixed core whatever this lane does — and then only with a reason and the
 * follow-up starter that brings the fix to new projects.
 */
function assertDeferralIsHonest(input: StarterHeadInputs, deferral: Deferral): void {
  const { coreVersion, starterTarget, starterVersion, releaseNotes } = input;
  if (deferral.followUp !== undefined) {
    const followUp = followUpStarterVersion(deferral.followUp);
    if (Bun.semver.order(followUp, starterVersion) <= 0) {
      throw new Error(
        `${STARTER_HEAD_REVIEW_PATH} followUp create-stitchkit@${followUp} is not later than the current starter ${starterVersion}; name the starter release that follows core ${coreVersion}.`,
      );
    }
  }
  if (!hasSecuritySection(releaseNotes)) return;
  const coreMinor = preOneMinor(coreVersion);
  const targetMinor = caretPreOneMinor(starterTarget);
  if (coreMinor === null || targetMinor === null || coreMinor === targetMinor) {
    throw new Error(
      `Cannot defer starter-head for core ${coreVersion}: release notes include a "### Security" section and the starter target "${starterTarget}" is not on another pre-1.0 minor (same minor or not a caret range), so new projects would install the fixed core from a starter nobody built against it.`,
    );
  }
  if (deferral.followUp === undefined) {
    throw new Error(
      `Cannot defer starter-head for core ${coreVersion}: release notes include a "### Security" section and the starter target "${starterTarget}" reaches the fix only through the next starter release; record it as followUp "create-stitchkit@X.Y.Z" (later than ${starterVersion}) in ${STARTER_HEAD_REVIEW_PATH}.`,
    );
  }
  if (deferral.reason === undefined) {
    throw new Error(
      `Cannot defer starter-head for core ${coreVersion}: release notes include a "### Security" section and the deferral has no reason; say why one template cannot build against both cores.`,
    );
  }
}

/**
 * A hard-cut core minor can temporarily outrun the still-published starter.
 * That bridge is never implicit: without an exact-version deferred review the
 * HEAD lane runs and exposes template drift on the SHA that created it.
 * A deferral the release cannot honour is refused with a reason (`assertDeferralIsHonest`).
 * Unknown version/range/review forms fail closed by running the lane.
 */
export function shouldRunStarterHeadLane(input: StarterHeadInputs): boolean {
  const deferral = deferralFor(input.coreVersion, input.review);
  if (deferral) assertDeferralIsHonest(input, deferral);
  if (!input.releaseNotes.includes('### ⚠️ Breaking changes')) return true;
  const coreMinor = preOneMinor(input.coreVersion);
  const targetMinor = caretPreOneMinor(input.starterTarget);
  if (coreMinor === null || targetMinor === null) return true;
  if (coreMinor === targetMinor) return true;
  return deferral?.reason === undefined;
}

function fieldAt(manifest: unknown, ...path: string[]): unknown {
  let value = manifest;
  for (const key of path) {
    value = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
  }
  return value;
}

async function readJson(root: string, path: string): Promise<unknown> {
  return JSON.parse(await readFile(join(root, path), 'utf8'));
}

/**
 * Shared CI/pre-push decision. HEAD runs by default; the only skip is an
 * exact-version, explicitly deferred review of an unaligned hard cut.
 */
export async function starterHeadDecision(root: string): Promise<'run' | 'skip'> {
  const coreVersion = fieldAt(await readJson(root, 'packages/core/package.json'), 'version');
  const starterVersion = fieldAt(
    await readJson(root, 'packages/create-stitchkit/package.json'),
    'version',
  );
  const starterTarget = fieldAt(
    await readJson(root, 'packages/create-stitchkit/template/package.json'),
    'catalog',
    'stitchkit',
  );
  if (
    typeof coreVersion !== 'string' ||
    typeof starterVersion !== 'string' ||
    typeof starterTarget !== 'string'
  ) {
    throw new Error(
      'core version, create-stitchkit version and starter catalog.stitchkit must be strings',
    );
  }
  const releaseNotes = extractReleaseNotes(
    await readFile(join(root, 'CHANGELOG.md'), 'utf8'),
    coreVersion,
  );
  const reviewFile = Bun.file(join(root, STARTER_HEAD_REVIEW_PATH));
  const review: unknown = (await reviewFile.exists())
    ? JSON.parse(await reviewFile.text())
    : undefined;
  return shouldRunStarterHeadLane({
    coreVersion,
    starterTarget,
    starterVersion,
    releaseNotes,
    review,
  })
    ? 'run'
    : 'skip';
}
