/**
 * Release metadata that follows from other files, computed in one place: the migration
 * guide's pending heading promoted to the released version, and the maturity table's
 * cadence sentences recomputed from the rolled changelog. `prepare` derives both, and the
 * cadence test compares the guide with the changelog, so neither holds a literal copy.
 */
import { type FenceState, stepFence } from './markdown-fences';
import { comparePreOneVersions, releasedVersionsInOrder } from './release-notes';
import {
  BREAKING_METADATA_SINCE,
  cadenceSentence,
  type Maturity,
  maturityTable,
  surfaceCadence,
} from './surface-cadence';

/** The guide whose maturity table carries the cadence of every core surface. */
export const CADENCE_GUIDE = 'docs/guide/getting-started.md';

/**
 * The only declared maturity-table row that does not take a core cadence figure:
 * `stitchkit-tui` has its own `packages/tui/CHANGELOG.md` outside the core leading-entrypoint gate.
 */
export const CADENCE_EXCLUDED_SURFACES: ReadonlySet<string> = new Set(['stitchkit-tui']);

const CADENCE_SENTENCE =
  /_(redefined in \d+ of the \d+ minors? since ([\d.]+)(?:, most recently [\d.]+)?)_/;

/** Every maturity-table surface whose cadence is derived from the core changelog. */
export function cadenceSurfaces(guide: string): string[] {
  return [...maturityTable(guide).keys()].filter(
    (name) => !CADENCE_EXCLUDED_SURFACES.has(name),
  );
}

/** The maturity-table rows that currently carry a rendered cadence sentence. */
export function cadenceRowsInGuide(guide: string): string[] {
  const rows: string[] = [];
  for (const line of guide.split('\n')) {
    const match = /^\| `(stitchkit[\w/-]*)` \|/.exec(line);
    if (match?.[1] && CADENCE_SENTENCE.test(line)) rows.push(match[1]);
  }
  return rows;
}

/** The sentence a surface's table row carries for this changelog. */
export function surfaceCadenceSentence(
  changelog: string,
  surface: string,
  known: ReadonlyMap<string, Maturity>,
  shipped?: string,
): string {
  return cadenceSentence(
    surfaceCadence({ changelog, surface, known, since: BREAKING_METADATA_SINCE, shipped }),
  );
}

function tableRow(guide: string, surface: string): string {
  const rows = guide.split('\n').filter((row) => row.startsWith(`| \`${surface}\` |`));
  const row = rows[0];
  if (rows.length !== 1 || !row)
    throw new Error(`Expected one maturity table row for ${surface}`);
  return row;
}

/**
 * The release that first published a surface, as its row records it: the
 * `since` of its cadence sentence when that is later than the metadata floor.
 * `prepare` writes it once, in the release that adds the entrypoint, from the
 * `exports` of the previous release tag; every later release keeps it.
 */
export function shippedInGuide(guide: string, surface: string): string | undefined {
  const since = tableRow(guide, surface).match(CADENCE_SENTENCE)?.[2];
  return since !== undefined && comparePreOneVersions(since, BREAKING_METADATA_SINCE) > 0
    ? since
    : undefined;
}

/**
 * Rewrite every core surface's cadence in the guide's maturity table; one row
 * per surface or a refusal. `introduced` names the surfaces the release being
 * prepared publishes for the first time, with its version.
 */
export function refreshCadence(
  guide: string,
  changelog: string,
  introduced: ReadonlyMap<string, string> = new Map(),
): string {
  const known = maturityTable(guide);
  let next = guide;
  for (const surface of cadenceSurfaces(guide)) {
    const row = tableRow(next, surface);
    const shipped = introduced.get(surface) ?? shippedInGuide(next, surface);
    const sentence = surfaceCadenceSentence(changelog, surface, known, shipped);
    const previous = row.match(CADENCE_SENTENCE)?.[1];
    if (previous) {
      next = next.replace(row, row.replace(previous, sentence));
      continue;
    }
    const cells = row.split(' | ');
    if (cells.length !== 4 || !cells[2]) {
      throw new Error(`Expected a 4-column maturity table row for ${surface}`);
    }
    cells[2] = `${cells[2].trim()}<br>_${sentence}_`;
    next = next.replace(row, cells.join(' | '));
  }
  return next;
}

/**
 * Promote a migration guide's pending headings into `## Released migration:
 * <version>`. A pending heading names the version, or a slug its author
 * chose; every slug becomes a subsection of the one released heading, the
 * same move the changelog makes. A slug whose section already opens with its
 * own `###` heading gives way to it, so no empty subsection is left. A guide with nothing pending is returned as
 * it is; one already promoted for this version is too.
 */
export function promoteMigrationHeading(source: string, version: string): string {
  const released = `## Released migration: ${version}`;
  if (source.includes(released)) return source;
  const candidates = [
    `## Upcoming migration: ${version}`,
    `## Unreleased migration: ${version}`,
  ].filter((heading) => source.includes(heading));
  const slugs = [...source.matchAll(/^## Unreleased migration: (.+)$/gm)].filter(
    ([, slug]) => slug !== version,
  );
  const [candidate] = candidates;
  if (candidate === undefined && slugs.length === 0) return source;
  if (candidate !== undefined && candidates.length === 1 && slugs.length === 0)
    return source.replace(candidate, released);
  if (candidates.length > 0)
    throw new Error(`Expected one kind of pending migration heading for ${version}`);
  let promoted = source;
  for (const [index, [heading, slug]] of slugs.entries()) {
    const opening = promoted.slice(promoted.indexOf(heading) + heading.length);
    const titled = /^\n(?:[ \t]*\n)*(?=### )/.exec(opening);
    if (titled) {
      promoted = promoted.replace(
        `${heading}${titled[0]}`,
        index === 0 ? `${released}\n\n` : '',
      );
      continue;
    }
    promoted = promoted.replace(
      heading,
      index === 0 ? `${released}\n\n### ${slug}` : `### ${slug}`,
    );
  }
  return promoted;
}

const STARTER_MARKER = /^\*\*(?:Required|Voluntary|With stitchkit (\d+\.\d+\.\d+))\.\*\*/;

/** The first starter release whose `UPGRADING.md` migration sections must carry adoption markers. */
export const STARTER_MIGRATION_MARKERS_SINCE = '0.6.24';

/**
 * Every migration section in `packages/create-stitchkit/UPGRADING.md` under
 * `## Unreleased migration:` or `## Released migration: X.Y.Z` with `X.Y.Z` at or
 * after `STARTER_MIGRATION_MARKERS_SINCE` must open with a
 * machine-readable adoption marker: `**Required.**`, `**Voluntary.**` or
 * `**With stitchkit X.Y.Z.**` where `X.Y.Z` exists in the core `CHANGELOG.md`.
 *
 * Sections are parsed uniformly: if a `##` migration section contains `###`
 * subsections (outside fenced blocks), each `###` subsection's first non-empty
 * line must carry a marker; otherwise the `##` section's own first non-empty
 * line must carry one. A code fence appearing before the marker is refused.
 * Returns the number of checked sections/subsections.
 */
export function assertStarterMigrationMarkers(guide: string, coreChangelog: string): number {
  const knownVersions = new Set(releasedVersionsInOrder(coreChangelog));
  const sections: { heading: string; lines: string[] }[] = [];
  let fence: FenceState | null = null;
  let current: { heading: string; lines: string[] } | undefined;

  for (const line of guide.split('\n')) {
    const stepped = stepFence(line, fence);
    const outsideBefore = fence === null;
    fence = stepped.fence;
    if (outsideBefore && !stepped.isDelimiter && line.startsWith('## ')) {
      const released = /^## Released migration: (\d+\.\d+\.\d+)\s*$/.exec(line)?.[1];
      if (
        line.startsWith('## Unreleased migration:') ||
        (line.startsWith('## Released migration:') &&
          (released === undefined ||
            comparePreOneVersions(released, STARTER_MIGRATION_MARKERS_SINCE) >= 0))
      ) {
        current = { heading: line.trim(), lines: [] };
        sections.push(current);
      } else {
        current = undefined;
      }
      continue;
    }
    current?.lines.push(line);
  }

  let checkedCount = 0;
  const checkFirstNonEmpty = (heading: string, bodyLines: readonly string[]) => {
    checkedCount += 1;
    const first = bodyLines.find((line) => line.trim() !== '')?.trim() ?? '';
    const match = STARTER_MARKER.exec(first);
    if (!match) {
      throw new Error(
        `Starter migration "${heading}" must start with "**Required.**", "**Voluntary.**" or "**With stitchkit X.Y.Z.**" (got ${JSON.stringify(first.slice(0, 80))}).`,
      );
    }
    const coreVersion = match[1];
    if (coreVersion !== undefined && !knownVersions.has(coreVersion)) {
      throw new Error(
        `Starter migration "${heading}" references stitchkit ${coreVersion}, which does not exist in CHANGELOG.md.`,
      );
    }
  };

  for (const section of sections) {
    const subsections: { heading: string; lines: string[] }[] = [];
    let subFence: FenceState | null = null;
    let activeSub: { heading: string; lines: string[] } | undefined;
    for (const line of section.lines) {
      const stepped = stepFence(line, subFence);
      const outsideBefore = subFence === null;
      subFence = stepped.fence;
      if (outsideBefore && !stepped.isDelimiter && line.startsWith('### ')) {
        activeSub = { heading: line.trim(), lines: [] };
        subsections.push(activeSub);
        continue;
      }
      activeSub?.lines.push(line);
    }
    if (subsections.length > 0) {
      for (const sub of subsections) checkFirstNonEmpty(sub.heading, sub.lines);
    } else {
      checkFirstNonEmpty(section.heading, section.lines);
    }
  }

  return checkedCount;
}
