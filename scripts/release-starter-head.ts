import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractReleaseNotes } from './release-notes';

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

/**
 * Shared CI/pre-push decision. HEAD runs by default; the only skip is an
 * exact-version, explicitly deferred review of an unaligned hard cut.
 */
export async function starterHeadDecision(root: string): Promise<'run' | 'skip'> {
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
  const reviewFile = Bun.file(join(root, 'scripts/starter-head-review.json'));
  const review: unknown = (await reviewFile.exists())
    ? JSON.parse(await reviewFile.text())
    : undefined;
  return shouldRunStarterHeadLane(coreVersion, starterTarget, releaseNotes, review)
    ? 'run'
    : 'skip';
}
