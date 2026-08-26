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
