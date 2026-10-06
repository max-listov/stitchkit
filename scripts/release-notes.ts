import { BREAKING_HEADING } from '../packages/core/src/internal/upgrade-plan';
import { RELEASE_TARGETS, type ReleaseTargetInfo } from './release-train';

const FENCE = /^(`{3,}|~{3,})/;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lines outside every fenced block: an example inside a fence is documentation, not structure. */
function linesOutsideFences(document: string): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const line of document.split('\n')) {
    if (FENCE.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return lines;
}

function headingOutsideFences(document: string, heading: RegExp): boolean {
  return linesOutsideFences(document).some((line) => heading.test(line));
}

/**
 * The changelog section of one version. A `## [x.y.z]` inside a code fence is
 * example text, not a section boundary, and a section must carry substance: a
 * lone `### Added`, an HTML comment or a stray dot is not release notes.
 */
export function extractReleaseNotes(changelog: string, version: string): string {
  const headingPattern = new RegExp(`^## \\[${escapeRegExp(version)}\\]`);
  const lines = changelog.split('\n');
  let inFence = false;
  let start = -1;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (FENCE.test(line.trim())) {
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

/** Released versions in changelog order, newest first; fenced examples are not releases. */
export function releasedVersionsInOrder(changelog: string): string[] {
  const versions: string[] = [];
  for (const line of linesOutsideFences(changelog)) {
    const heading = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (heading?.[1] !== undefined) versions.push(heading[1]);
  }
  return versions;
}

export function comparePreOneVersions(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0, leftPatch = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0, rightPatch = 0] = right.split('.').map(Number);
  if (leftMajor !== rightMajor) return leftMajor - rightMajor;
  if (leftMinor !== rightMinor) return leftMinor - rightMinor;
  return leftPatch - rightPatch;
}

/** A heading that opens with the warning sign, whatever follows it. */
const WARNING_HEADING = /^#{2,6}\s*⚠/;
/** A line that opens with `Breaking…` or `Who must act`, as a bullet, bold lead or plain text. */
const BREAKING_LEAD = /^(?:[-*]\s+)?(?:\*\*)?(?:breaking\b|who must act\b)/i;

/**
 * Every line of release notes that declares a break: a warning-sign heading or
 * a line that leads with `Breaking` or `Who must act`. The exact
 * `### ⚠️ Breaking changes` heading is one of them; a differently named warning
 * section and a bare `**Who must act:**` line are the shapes that shipped a
 * break under `### Fixed`.
 */
export function breakingMarkers(notes: string): string[] {
  return linesOutsideFences(notes)
    .map((line) => line.trim())
    .filter((line) => WARNING_HEADING.test(line) || BREAKING_LEAD.test(line));
}

/**
 * A breaking change never ships as a patch. The breaking-change policy rests on
 * the caret being a real gate — `^0.56.0` stops before `0.57.0`, so a consumer
 * crosses a break only on purpose. Ship that break as `0.56.1` and every caret
 * consumer takes it on a plain `install`, silently. The reverse (additive
 * shipped as a minor) only costs an upgrade nobody needed, so it is not gated.
 */
export function assertVersionCalibre(changelog: string, version: string): void {
  const markers = breakingMarkers(extractReleaseNotes(changelog, version));
  if (markers.length === 0) return;

  const released = releasedVersionsInOrder(changelog);
  const index = released.indexOf(version);
  if (index === -1) {
    // A pre-release spelling such as `## [0.56.1-rc.1]` has notes but no plain
    // heading; skipping the calibre check there would skip it for exactly the
    // shape most likely to carry an unreviewed break.
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
    `${version} declares a break (${JSON.stringify(markers[0])}) but is a patch bump from ${previous}. A caret consumer takes a patch on a plain install — bump the minor so crossing the break stays an explicit opt-in.`,
  );
}

/** A migration channel: the upgrade guide a package keeps and the oldest version it has a section for. */
export type MigrationChannel = ReleaseTargetInfo['migration'];

/**
 * A breaking release carries the promoted section that explains it. The
 * changelog says WHAT changed in one mechanical line per item; the upgrade
 * guide says what else stops compiling, which is the half an agent moving a
 * frozen consumer needs. An author writes it under `## Unreleased migration:`,
 * the release commit promotes it, and every queued heading must be promoted
 * with it: a section left queued is overwritten by the next breaking change.
 */
export function assertMigrationSection(
  guide: string,
  version: string,
  releaseNotes: string,
  channel: MigrationChannel = RELEASE_TARGETS.core.migration,
): void {
  if (!BREAKING_HEADING.test(releaseNotes)) return;
  if (comparePreOneVersions(version, channel.floor) < 0) return;

  const heading = new RegExp(`^## Released migration: ${escapeRegExp(version)}\\s*$`, 'm');
  if (!headingOutsideFences(guide, heading)) {
    throw new Error(
      `${version} carries a "### ⚠️ Breaking changes" section, so ${channel.guidePath} must carry "## Released migration: ${version}". Promote the "## Unreleased migration: …" heading that describes it in this release commit — an unpromoted section is overwritten by the next breaking change.`,
    );
  }

  const queued = linesOutsideFences(guide).filter((line) =>
    line.startsWith('## Unreleased migration:'),
  ).length;
  if (queued > 0) {
    throw new Error(
      `${channel.guidePath} still carries ${queued} "## Unreleased migration: …" section${queued === 1 ? '' : 's'} after releasing ${version}. Promote every one of them — a section left queued is overwritten by the next breaking change and lost.`,
    );
  }
}

/**
 * A breaking section says who has to act before it says what changed, so a
 * reader planning an upgrade across several minors sees which entry costs a day
 * without reading the change.
 */
const AUDIENCE_LINE = /^\*\*Who must act:\*\*\s+\S/m;

export function assertBreakingAudience(releaseNotes: string, version: string): void {
  if (!BREAKING_HEADING.test(releaseNotes)) return;
  const start = releaseNotes.search(BREAKING_HEADING);
  const section = releaseNotes.slice(start);
  const end = section.search(/^### (?!\s*⚠)/m);
  const body = end === -1 ? section : section.slice(0, end);
  if (AUDIENCE_LINE.test(body)) return;
  throw new Error(
    `${version} carries a "### ⚠️ Breaking changes" section with no "**Who must act:**" line. ` +
      'State who has to change code and who only has to re-read a value — a reader planning an ' +
      'upgrade across several minors cannot tell which entry costs a day, and finds out by doing it.',
  );
}
