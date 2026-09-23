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

export interface SurfaceCadence {
  /** Version the surface first shipped in. */
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
  for (const line of changelog.split('\n')) {
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
 * Cadence for one surface, matched by the terms its breaking entries use.
 *
 * Matching on wording rather than on a maintained list is the trade: a breaking
 * entry that names none of the terms is invisible here, and the alternative — a
 * per-release annotation — is the hand-maintained thing this exists to avoid.
 * The terms are therefore the surface's own vocabulary, not adjectives.
 */
export function surfaceCadence(input: {
  changelog: string;
  since: string;
  terms: readonly string[];
}): SurfaceCadence {
  const all = releases(input.changelog);
  const sinceMinor = minorOf(input.since);
  const considered = all.filter(
    (release) => compareMinor(minorOf(release.version), sinceMinor) >= 0,
  );
  const minors = new Set(considered.map((release) => minorOf(release.version)));
  const brokenMinors = new Set<string>();
  let lastBroken: string | undefined;
  for (const release of considered) {
    const section = breakingSection(release.body);
    if (!section) continue;
    if (!input.terms.some((term) => section.includes(term))) continue;
    brokenMinors.add(minorOf(release.version));
    if (!lastBroken || compareMinor(minorOf(release.version), minorOf(lastBroken)) > 0) {
      lastBroken = release.version;
    }
  }
  return {
    since: input.since,
    minors: minors.size,
    breaking: brokenMinors.size,
    ...(lastBroken && { lastBroken }),
  };
}

function compareMinor(left: string, right: string): number {
  const [leftMajor = 0, leftMinor = 0] = left.split('.').map(Number);
  const [rightMajor = 0, rightMinor = 0] = right.split('.').map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor;
}

/** The sentence the maturity table carries, so the table cannot drift from the notes. */
export function cadenceSentence(cadence: SurfaceCadence): string {
  return `redefined in ${cadence.breaking} of the ${cadence.minors} minors since ${cadence.since}${
    cadence.lastBroken ? `, most recently ${cadence.lastBroken}` : ''
  }`;
}

/**
 * The breaking budget for stable entrypoints — ADR 0198.
 *
 * ADR 0103 declared which entrypoints are stable and, deliberately, attached no
 * versioning policy to the word. ADR 0198 attaches one: a stable entrypoint is
 * broken in at most one minor per rolling seven days, and a breaking entry says
 * which entrypoints it breaks before it says anything else. Everything here is
 * read from two files the release already carries — the changelog and the
 * maturity table in the getting-started guide — so the budget cannot drift from
 * either, and there is no third list to keep in step.
 */

/** Releases before this one are not counted: the rule did not exist when they shipped. */
export const STABLE_BUDGET_SINCE = '0.94.0';

/** Breaking minors a stable entrypoint may take per window. */
export const STABLE_BREAKING_BUDGET = 1;

/** The window the budget is kept over, and the wider one printed beside it. */
const BUDGET_WINDOW_DAYS = 7;
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
 * `, `, ` and ` or ` + `, optionally inside the item's opening `**`. Only names
 * the maturity table knows count — `createMcpHandler` in that position is a
 * symbol, not an entrypoint, and an entry leading with it names none.
 */
export function breakingEntries(
  section: string,
  known: ReadonlyMap<string, Maturity>,
): BreakingEntry[] {
  const entries: BreakingEntry[] = [];
  let fenced = false;
  let current: string | undefined;
  const flush = () => {
    if (current === undefined) return;
    entries.push({ text: current, entrypoints: leadingEntrypoints(current, known) });
    current = undefined;
  };
  for (const line of section.split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
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

function leadingEntrypoints(entry: string, known: ReadonlyMap<string, Maturity>): string[] {
  let rest = entry.slice(2).replace(/^\*\*/, '');
  const names: string[] = [];
  for (;;) {
    const match = /^`([^`]+)`/.exec(rest);
    const name = match?.[1];
    if (!match || name === undefined || !known.has(name)) break;
    names.push(name);
    rest = rest.slice(match[0].length);
    const separator = /^(?:, and |, | and | \+ )/.exec(rest);
    if (!separator) break;
    rest = rest.slice(separator[0].length);
  }
  return names;
}

/** A dated release heading: `## [x.y.z] — YYYY-MM-DD`. */
function releaseDates(changelog: string): Map<string, string> {
  const dates = new Map<string, string>();
  for (const match of changelog.matchAll(
    /^## \[(\d+\.\d+\.\d+)\](?:\s+[—–-]\s+(\d{4}-\d{2}-\d{2}))?/gm,
  )) {
    if (match[1] && match[2]) dates.set(match[1], match[2]);
  }
  return dates;
}

function compareVersion(left: string, right: string): number {
  const [la = 0, lb = 0, lc = 0] = left.split('.').map(Number);
  const [ra = 0, rb = 0, rc = 0] = right.split('.').map(Number);
  return la - ra || lb - rb || lc - rc;
}

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

export interface StableBudget {
  /** The release the budget is judged for. */
  readonly version: string;
  /** Its date, from its heading; absent when the heading carries none. */
  readonly date?: string;
  /** Whether this release itself breaks a stable entrypoint. */
  readonly breaksStable: boolean;
  /** Breaking minors touching a stable entrypoint within 30 days, this one included. */
  readonly last30: number;
  /** The same within the 7-day budget window, this one included. */
  readonly last7: number;
  /** Those 7-day minors, newest first, for the refusal message. */
  readonly counted: readonly string[];
  readonly budget: number;
}

/**
 * How much of the budget the release `version` spends, counted from its own date.
 *
 * The window is anchored on the release's heading, never on the clock, so a tag
 * re-validated a month later gets the same answer it got when it was cut. Only
 * releases at or above `since` are counted and only those at or below `version`:
 * a later release cannot spend an earlier one's budget.
 */
export function stableBreakingBudget(input: {
  changelog: string;
  guide: string;
  version: string;
  since?: string;
}): StableBudget {
  const since = input.since ?? STABLE_BUDGET_SINCE;
  const known = maturityTable(input.guide);
  const dates = releaseDates(input.changelog);
  const date = dates.get(input.version);
  const touchesStable = (body: string) =>
    breakingEntries(breakingSection(body), known).some((entry) =>
      entry.entrypoints.some((name) => known.get(name) === 'stable'),
    );
  const stableBreaking = releases(input.changelog).filter(
    (release) =>
      compareVersion(release.version, since) >= 0 &&
      compareVersion(release.version, input.version) <= 0 &&
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
  const counted = [...within(BUDGET_WINDOW_DAYS)];
  return {
    version: input.version,
    ...(date && { date }),
    breaksStable,
    last30: within(REPORT_WINDOW_DAYS).size,
    last7: counted.length,
    counted,
    budget: STABLE_BREAKING_BUDGET,
  };
}

/** The line `release:check` prints. */
export function stableBudgetSentence(budget: StableBudget): string {
  return `stable breaking: ${budget.last30} in ${REPORT_WINDOW_DAYS} days, ${budget.last7} in ${BUDGET_WINDOW_DAYS} days (budget ${budget.budget})`;
}

/**
 * Refuse a release that overspends the budget or writes a breaking entry the
 * budget cannot read.
 *
 * Three refusals, all for versions at or above `since`: an entry that does not
 * lead with the entrypoints it breaks (the budget classifies by that prefix and
 * nothing else); an entry breaking a stable entrypoint with no `ADR NNNN`; and a
 * release that breaks a stable entrypoint while another minor within seven days
 * already did. The last one needs the release's date, so a stable-breaking
 * release with an undated heading is refused rather than waved through.
 */
export function assertStableBreakingBudget(input: {
  changelog: string;
  guide: string;
  version: string;
  since?: string;
}): StableBudget {
  const since = input.since ?? STABLE_BUDGET_SINCE;
  const budget = stableBreakingBudget(input);
  if (compareVersion(input.version, since) < 0) return budget;
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
  if (!budget.breaksStable) return budget;
  if (!budget.date) {
    throw new Error(
      `${input.version} breaks a stable entrypoint but its changelog heading carries no date, so the 7-day budget (ADR 0198) cannot be measured. Write "## [${input.version}] — YYYY-MM-DD".`,
    );
  }
  if (budget.last7 > budget.budget) {
    throw new Error(
      `${input.version} breaks a stable entrypoint, and ${budget.last7} minors did within 7 days of ${budget.date} (${budget.counted.join(', ')}); the budget is ${budget.budget} (ADR 0198). Ship the break in a later minor, or move it off the stable entrypoint.`,
    );
  }
  return budget;
}
