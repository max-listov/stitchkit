/**
 * How often an evolving entrypoint has actually been redefined.
 *
 * ADR 0103 lets an evolving surface be redefined in any minor. That is a
 * permission, and a reader deciding whether to build on the surface is asking a
 * different question: how often does it happen. The answer is derivable from
 * the changelog, so it is derived rather than maintained by hand — a number
 * kept by hand beside a table is a number that rots.
 *
 * → ADR 0103, ADR 0111.
 */

import { leadingEntrypoints } from '../packages/core/src/internal/upgrade-plan';
import { type FenceState, linesOutsideFences, stepFence } from './markdown-fences';
import { comparePreOneVersions } from './release-notes';

export interface SurfaceCadence {
  /** Version the count starts at: the one the surface first shipped in, or the metadata floor. */
  readonly since: string;
  /** Minors released since, counting the one it shipped in. */
  readonly minors: number;
  /** Of those, how many carried a breaking change naming this surface. */
  readonly breaking: number;
  /** The most recent version that broke it. */
  readonly lastBroken?: string;
}

/** Versions in the changelog, newest first, with their notes. */
function releases(changelog: string): { version: string; body: string }[] {
  const found: { version: string; body: string }[] = [];
  let current: { version: string; lines: string[] } | undefined;
  let fence: FenceState | null = null;
  for (const line of changelog.split('\n')) {
    const stepped = stepFence(line, fence);
    fence = stepped.fence;
    if (!stepped.isDelimiter && fence === null) {
      const heading = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
      if (heading?.[1]) {
        if (current) found.push({ version: current.version, body: current.lines.join('\n') });
        current = { version: heading[1], lines: [] };
        continue;
      }
      if (line.startsWith('## ')) {
        if (current) found.push({ version: current.version, body: current.lines.join('\n') });
        current = undefined;
        continue;
      }
    }
    current?.lines.push(line);
  }
  if (current) found.push({ version: current.version, body: current.lines.join('\n') });
  return found;
}

function minorOf(version: string): string {
  const [major, minor] = version.split('.');
  return `${major}.${minor}`;
}

function breakingSection(body: string): string {
  const start = body.indexOf('### ⚠️ Breaking changes');
  if (start === -1) return '';
  const rest = body.slice(start + 1);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * Whether a breaking entry leading with `entrypoint` belongs to `surface`'s family.
 *
 * A subpath row `stitchkit/x` counts items leading with `stitchkit/x` and `stitchkit/x/*`;
 * the root `stitchkit` counts only `stitchkit` itself.
 */
export function matchesSurfaceFamily(surface: string, entrypoint: string): boolean {
  if (surface === 'stitchkit') return entrypoint === 'stitchkit';
  return entrypoint === surface || entrypoint.startsWith(`${surface}/`);
}

/**
 * Cadence for one surface, counted from breaking entries that lead with the
 * surface or a subpath in its family since `BREAKING_METADATA_SINCE` (`0.94.0`),
 * or since `shipped` for a surface first published after it. The minor a
 * surface shipped in does not redefine it: nothing depended on it before.
 */
export function surfaceCadence(input: {
  changelog: string;
  surface: string;
  known: ReadonlyMap<string, Maturity>;
  since?: string;
  /** The version that first published the surface. */
  shipped?: string;
}): SurfaceCadence {
  const floor = input.since ?? BREAKING_METADATA_SINCE;
  const shippedLater =
    input.shipped !== undefined && comparePreOneVersions(input.shipped, floor) > 0
      ? input.shipped
      : undefined;
  const since = shippedLater ?? floor;
  const all = releases(input.changelog);
  const sinceMinor = minorOf(since);
  const considered = all.filter(
    (release) => comparePreOneVersions(minorOf(release.version), sinceMinor) >= 0,
  );
  const minors = new Set(considered.map((release) => minorOf(release.version)));
  const brokenMinors = new Set<string>();
  let lastBroken: string | undefined;
  for (const release of considered) {
    if (shippedLater !== undefined && minorOf(release.version) === sinceMinor) continue;
    const section = breakingSection(release.body);
    if (!section) continue;
    const entries = breakingEntries(section, input.known);
    const matched = entries.some((entry) =>
      entry.entrypoints.some((name) => matchesSurfaceFamily(input.surface, name)),
    );
    if (!matched) continue;
    brokenMinors.add(minorOf(release.version));
    if (!lastBroken || comparePreOneVersions(release.version, lastBroken) > 0) {
      lastBroken = release.version;
    }
  }
  return {
    since,
    minors: minors.size,
    breaking: brokenMinors.size,
    ...(lastBroken && { lastBroken }),
  };
}

/** The sentence the maturity table carries, so the table cannot drift from the notes. */
export function cadenceSentence(cadence: SurfaceCadence): string {
  return `redefined in ${cadence.breaking} of the ${cadence.minors} minor${cadence.minors === 1 ? '' : 's'} since ${cadence.since}${
    cadence.lastBroken ? `, most recently ${cadence.lastBroken}` : ''
  }`;
}

/** Breaking metadata and observed release cadence — ADR 0198, amended by ADR 0204. */
export const BREAKING_METADATA_SINCE = '0.94.0';
const SHORT_REPORT_WINDOW_DAYS = 7;
const REPORT_WINDOW_DAYS = 30;

export type Maturity = 'stable' | 'evolving';

/**
 * The maturity table in `docs/guide/getting-started.md`, as a map.
 *
 * This is the one place a level is declared (ADR 0103); every consumer of the
 * classification reads it from here rather than restating it.
 */
export function maturityTable(guide: string): Map<string, Maturity> {
  const levels = new Map<string, Maturity>();
  for (const row of guide.matchAll(
    /^\| `(stitchkit[\w/-]*)` \|[^|\n]*\|\s*(stable|evolving)\b/gm,
  )) {
    const [, name, level] = row;
    if (name && (level === 'stable' || level === 'evolving')) levels.set(name, level);
  }
  return levels;
}

export interface BreakingEntry {
  /** The entry's first line, for a message a person can find. */
  readonly text: string;
  /** Entrypoints the entry names before anything else, in the order written. */
  readonly entrypoints: readonly string[];
}

/**
 * The top-level items of a breaking section, each with the entrypoints it leads with.
 *
 * An item is a `- ` line at column zero outside a fence; its continuation is
 * indented and belongs to it. The leading run is backticked names separated by
 * `, `, ` and `, ` + ` or a space (`leadingEntrypoints`), optionally inside the
 * item's opening `**`. Only names
 * the maturity table knows count — `createMcpHandler` in that position is a
 * symbol, not an entrypoint, and an entry leading with it names none.
 */
export function breakingEntries(
  section: string,
  known: ReadonlyMap<string, Maturity>,
): BreakingEntry[] {
  const entries: BreakingEntry[] = [];
  let current: string | undefined;
  const flush = () => {
    if (current === undefined) return;
    entries.push({
      text: current,
      entrypoints: leadingEntrypoints(current, (name) => known.has(name)),
    });
    current = undefined;
  };
  for (const line of linesOutsideFences(section)) {
    if (line.startsWith('- ')) {
      flush();
      current = line;
    } else if (current !== undefined && /^\S/.test(line)) {
      flush();
    } else if (current !== undefined && line.trim() !== '') {
      current = `${current} ${line.trim()}`;
    }
  }
  flush();
  return entries;
}

/** A dated release heading: `## [x.y.z] — YYYY-MM-DD`. */
function releaseDates(changelog: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const line of linesOutsideFences(changelog)) {
    const match = /^## \[(\d+\.\d+\.\d+)\](?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (match?.[1] && match[2]) dates.set(match[1], match[2]);
  }
  return dates;
}

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

export interface StableBreakingCadence {
  /** The release whose cadence is measured. */
  readonly version: string;
  /** Its date, from its heading; absent when the heading carries none. */
  readonly date?: string;
  /** Whether this release itself breaks a stable entrypoint. */
  readonly breaksStable: boolean;
  /** Breaking minors touching a stable entrypoint within 30 days, this one included. */
  readonly last30: number;
  /** The same within the 7-day reporting window, this one included. */
  readonly last7: number;
  /** Those 7-day minors, newest first, for the report. */
  readonly counted: readonly string[];
}

/**
 * Observed stable-breaking cadence, counted from the release date.
 *
 * The window is anchored on the release's heading, never on the clock, so a tag
 * re-validated a month later gets the same answer it got when it was cut. Only
 * releases at or above `since` are counted and only those at or below `version`:
 * a later release cannot change an earlier release's measured cadence.
 */
export function stableBreakingCadence(input: {
  changelog: string;
  guide: string;
  version: string;
  since?: string;
}): StableBreakingCadence {
  const since = input.since ?? BREAKING_METADATA_SINCE;
  const known = maturityTable(input.guide);
  const dates = releaseDates(input.changelog);
  const date = dates.get(input.version);
  const touchesStable = (body: string) =>
    breakingEntries(breakingSection(body), known).some((entry) =>
      entry.entrypoints.some((name) => known.get(name) === 'stable'),
    );
  const stableBreaking = releases(input.changelog).filter(
    (release) =>
      comparePreOneVersions(release.version, since) >= 0 &&
      comparePreOneVersions(release.version, input.version) <= 0 &&
      touchesStable(release.body),
  );
  const breaksStable = stableBreaking.some((release) => release.version === input.version);
  const within = (days: number) => {
    const minors = new Set<string>();
    if (!date) return minors;
    for (const release of stableBreaking) {
      const at = dates.get(release.version);
      if (!at) continue;
      const age = daysBetween(at, date);
      if (age >= 0 && age < days) minors.add(minorOf(release.version));
    }
    return minors;
  };
  const counted = [...within(SHORT_REPORT_WINDOW_DAYS)];
  return {
    version: input.version,
    ...(date && { date }),
    breaksStable,
    last30: within(REPORT_WINDOW_DAYS).size,
    last7: counted.length,
    counted,
  };
}

/** The line `release:check` prints. */
export function stableCadenceSentence(cadence: StableBreakingCadence): string {
  return `stable breaking: ${cadence.last30} in ${REPORT_WINDOW_DAYS} days, ${cadence.last7} in ${SHORT_REPORT_WINDOW_DAYS} days`;
}

/** Require named entrypoints, an ADR for stable breaks and a dated heading.
 * Release cadence is reported but never limits publication (ADR 0204).
 */
export function assertBreakingReleaseMetadata(input: {
  changelog: string;
  guide: string;
  version: string;
  since?: string;
}): StableBreakingCadence {
  const since = input.since ?? BREAKING_METADATA_SINCE;
  const cadence = stableBreakingCadence(input);
  if (comparePreOneVersions(input.version, since) < 0) return cadence;
  const known = maturityTable(input.guide);
  const release = releases(input.changelog).find((entry) => entry.version === input.version);
  const entries = breakingEntries(breakingSection(release?.body ?? ''), known);
  const unnamed = entries.filter((entry) => entry.entrypoints.length === 0);
  if (unnamed.length > 0) {
    throw new Error(
      `${input.version}: ${unnamed.length} breaking entr${unnamed.length === 1 ? 'y does' : 'ies do'} not start with the entrypoint it breaks (ADR 0198). Lead each item with the backticked entrypoint name(s) from the maturity table in docs/guide/getting-started.md, e.g. "- \`stitchkit/tools\` — **…**". First: ${JSON.stringify(unnamed[0]?.text.slice(0, 120))}`,
    );
  }
  const uncited = entries.filter(
    (entry) =>
      entry.entrypoints.some((name) => known.get(name) === 'stable') &&
      !/\bADR \d{4}\b/.test(entry.text),
  );
  if (uncited.length > 0) {
    throw new Error(
      `${input.version}: a breaking entry for a stable entrypoint must cite the ADR that authorises it (ADR 0198) — "→ ADR NNNN". Uncited: ${uncited.map((entry) => entry.entrypoints.join(', ')).join('; ')}`,
    );
  }
  if (!cadence.breaksStable) return cadence;
  if (!cadence.date) {
    throw new Error(
      `${input.version} breaks a stable entrypoint but its changelog heading carries no date, so its release cadence cannot be measured. Write "## [${input.version}] — YYYY-MM-DD".`,
    );
  }
  return cadence;
}
