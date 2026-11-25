import { z } from 'zod';
import {
  affectsLineOf,
  breakingItems,
  parseAffectsLine,
  releaseSectionItems,
  UpgradeAffectsError,
  type UpgradeAffectsTarget,
} from '../packages/core/src/internal/upgrade-affects';
import { BREAKING_HEADING } from '../packages/core/src/internal/upgrade-plan';
import { readFromReleaseTags } from './release-companions';
import { comparePreOneVersions } from './release-notes';
import { releaseTags } from './release-tags';
import { RELEASE_TARGETS } from './release-train';

/**
 * The exact public surface of every `stitchkit` entrypoint: `reference-coverage.test.ts` holds it
 * equal to the exports of the entrypoint files, so it is the tree's export list a release reads —
 * from the working tree, a commit or a tag alike, without compiling the source.
 */
export const PUBLIC_SURFACE_PATH = 'packages/core/tests/fixtures/public-surface.json';

/**
 * Type-only exports paired with the exported functions in the same entrypoint whose return type
 * (or `.define()` factory method) produces them. Verified by `reference-coverage.test.ts` via the
 * real TypeScript type checker and read here as plain JSON without compiling source.
 */
export const PUBLIC_SURFACE_PRODUCERS_PATH =
  'packages/core/tests/fixtures/public-surface-producers.json';

/** The first core release whose `**Affects:**` export names must each exist. */
export const AFFECTS_NAMES_SINCE = '0.127.0';

/** The first core release whose `**Affects:**` return-type targets must also name their producers. */
export const AFFECTS_PRODUCERS_SINCE = '0.127.0';

/** Entrypoint → the names it exports. */
export type PublicSurface = ReadonlyMap<string, ReadonlySet<string>>;

/** Entrypoint → type-only export name → sorted producer function names in the same entrypoint. */
export type PublicSurfaceProducers = ReadonlyMap<
  string,
  ReadonlyMap<string, readonly string[]>
>;

const PublicSurfaceSchema = z.record(z.string(), z.array(z.string()));
const PublicSurfaceProducersSchema = z.record(
  z.string(),
  z.record(z.string(), z.array(z.string())),
);

export function parsePublicSurface(json: string): PublicSurface {
  const parsed = PublicSurfaceSchema.parse(JSON.parse(json));
  return new Map(Object.entries(parsed).map(([entry, names]) => [entry, new Set(names)]));
}

export function parsePublicSurfaceProducers(json: string): PublicSurfaceProducers {
  const parsed = PublicSurfaceProducersSchema.parse(JSON.parse(json));
  return new Map(
    Object.entries(parsed).map(([entry, map]) => [entry, new Map(Object.entries(map))]),
  );
}

/** The body of a release's `### ⚠️ Breaking changes` section, or `undefined` without one. */
export function breakingSectionBody(notes: string): string | undefined {
  if (!BREAKING_HEADING.test(notes)) return undefined;
  const section = notes.slice(notes.search(BREAKING_HEADING)).replace(/^[^\n]*\n/, '');
  const end = section.search(/^### /m);
  return end === -1 ? section : section.slice(0, end);
}

/** An export an `**Affects:**` line names that its entrypoint does not have where the item needs it. */
export interface AffectsNameViolation {
  readonly section: 'breaking' | 'fixed' | 'security';
  /** The item's first line, as written. */
  readonly item: string;
  readonly entrypoint: string;
  readonly name: string;
  /** The entrypoint exported the name in the previous release: this release removed it. */
  readonly removed: boolean;
  /** The entrypoints that export the name in this tree, the one it was perhaps meant to be. */
  readonly exportedBy: readonly string[];
}

/**
 * Every export name in the `**Affects:**` lines of a release's breaking, fixed and security items
 * that its entrypoint does not have. A breaking item may name an export the release removes, so its names
 * are looked up in this tree and in the previous release; a fix changes what the release ships and
 * removes nothing (its line refuses `*` for the same reason), so its names are looked up in this
 * tree only — a fix naming a removed export describes a fix nobody receives; a security item is a
 * fix too. A name found nowhere
 * is a typo or a name that never shipped, and `stitchkit upgrade` would never match it against a
 * project's imports. A qualifier (`name(option)`), `behaviour` and `*` are judged by the line's own
 * rules, not here; a line that does not parse is left to them too.
 */
export function affectsNameViolations(
  notes: string,
  surfaces: { readonly tree: PublicSurface; readonly previous: PublicSurface },
): AffectsNameViolation[] {
  const body = breakingSectionBody(notes);
  const unknownIn =
    (section: AffectsNameViolation['section']) =>
    ({ markdown }: { readonly markdown: string }): AffectsNameViolation[] =>
      unknownNames(section, markdown, surfaces);
  return [
    ...(body === undefined ? [] : breakingItems(body)).flatMap(unknownIn('breaking')),
    ...releaseSectionItems(notes, 'Fixed').flatMap(unknownIn('fixed')),
    ...releaseSectionItems(notes, 'Security').flatMap(unknownIn('security')),
  ];
}

function unknownNames(
  section: AffectsNameViolation['section'],
  markdown: string,
  surfaces: { readonly tree: PublicSurface; readonly previous: PublicSurface },
): AffectsNameViolation[] {
  const item = markdown.split('\n')[0] ?? '';
  return readableTargets(markdown).flatMap((target) => {
    if (target.kind !== 'symbols') return [];
    const { entrypoint } = target;
    return target.symbols.flatMap(({ name }): AffectsNameViolation[] => {
      if (surfaces.tree.get(entrypoint)?.has(name)) return [];
      const removed = surfaces.previous.get(entrypoint)?.has(name) === true;
      if (removed && section === 'breaking') return [];
      const exportedBy = [...surfaces.tree]
        .filter(([, names]) => names.has(name))
        .map(([owner]) => owner);
      return [{ section, item, entrypoint, name, removed, exportedBy }];
    });
  });
}

function readableTargets(markdown: string): UpgradeAffectsTarget[] {
  try {
    const line = affectsLineOf(markdown);
    return line === undefined ? [] : parseAffectsLine(line);
  } catch (error) {
    // A malformed line is refused by the breaking and fixed rules, in their own words.
    if (error instanceof UpgradeAffectsError) return [];
    throw error;
  }
}

/** A type-only export in `**Affects:**` missing one or more same-entrypoint producer functions. */
export interface AffectsProducerViolation {
  readonly section: 'breaking' | 'fixed' | 'security';
  readonly item: string;
  readonly entrypoint: string;
  readonly typeName: string;
  readonly missingProducers: readonly string[];
}

function missingProducersIn(
  section: AffectsProducerViolation['section'],
  markdown: string,
  producers: PublicSurfaceProducers,
): AffectsProducerViolation[] {
  const item = markdown.split('\n')[0] ?? '';
  const targets = readableTargets(markdown);
  const wholeEntrypoints = new Set(
    targets.filter((target) => target.kind !== 'symbols').map((target) => target.entrypoint),
  );
  const namedByEntry = new Map<string, Set<string>>();
  for (const target of targets) {
    if (target.kind !== 'symbols') continue;
    const set = namedByEntry.get(target.entrypoint) ?? new Set<string>();
    for (const symbol of target.symbols) set.add(symbol.name);
    namedByEntry.set(target.entrypoint, set);
  }
  const violations: AffectsProducerViolation[] = [];
  for (const [entrypoint, named] of namedByEntry) {
    if (wholeEntrypoints.has(entrypoint)) continue;
    const entryProducers = producers.get(entrypoint);
    if (!entryProducers) continue;
    for (const typeName of named) {
      const fns = entryProducers.get(typeName);
      if (!fns || fns.length === 0) continue;
      const missingProducers = fns.filter((fn) => !named.has(fn));
      if (missingProducers.length > 0) {
        violations.push({ section, item, entrypoint, typeName, missingProducers });
      }
    }
  }
  return violations;
}

/**
 * Every type-only export named in an `**Affects:**` line whose same-entrypoint producer functions
 * are not also named (unless the entrypoint is already covered by `behaviour` or `*`). Consumers
 * frequently call a producer without importing its return type; omitting the producer makes
 * `stitchkit upgrade` miss those files.
 */
export function affectsProducerViolations(
  notes: string,
  producers: PublicSurfaceProducers,
): AffectsProducerViolation[] {
  const body = breakingSectionBody(notes);
  const check =
    (section: AffectsProducerViolation['section']) =>
    ({ markdown }: { readonly markdown: string }): AffectsProducerViolation[] =>
      missingProducersIn(section, markdown, producers);
  return [
    ...(body === undefined ? [] : breakingItems(body)).flatMap(check('breaking')),
    ...releaseSectionItems(notes, 'Fixed').flatMap(check('fixed')),
    ...releaseSectionItems(notes, 'Security').flatMap(check('security')),
  ];
}

/** Refuse a release whose `**Affects:**` names a returned type without its producer functions. */
export function assertAffectsProducersNamed(
  notes: string,
  version: string,
  producers: PublicSurfaceProducers,
): void {
  const violations = affectsProducerViolations(notes, producers);
  if (violations.length === 0) return;
  const lines = violations.map(
    ({ section, item, entrypoint, typeName, missingProducers }) =>
      `  ${section} item ${JSON.stringify(item.slice(0, 120))}: \`${entrypoint}\` ${typeName} — also name producer(s): ${missingProducers.join(', ')}`,
  );
  throw new Error(
    `${version}: an "**Affects:**" line names a returned type without naming the function(s) that produce it (${PUBLIC_SURFACE_PRODUCERS_PATH}):\n${lines.join('\n')}\nConsumers who call a producer without importing the return type are invisible to \`stitchkit upgrade\` unless the producer is listed too.`,
  );
}

/** Refuse a release whose `**Affects:**` lines name an export that does not exist. */
export function assertAffectsNamesExist(
  notes: string,
  version: string,
  surfaces: { readonly tree: PublicSurface; readonly previous: PublicSurface },
): void {
  const violations = affectsNameViolations(notes, surfaces);
  if (violations.length === 0) return;
  const lines = violations.map(({ section, item, entrypoint, name, removed, exportedBy }) => {
    const why = removed
      ? 'removed by this release, so a fix to it ships to nobody'
      : exportedBy.length > 0
        ? `exported by ${exportedBy.map((owner) => `\`${owner}\``).join(', ')}`
        : 'exported by no entrypoint, now or in the previous release';
    return `  ${section} item ${JSON.stringify(item.slice(0, 120))}: \`${entrypoint}\` ${name} — ${why}`;
  });
  throw new Error(
    `${version}: an "**Affects:**" line names an export its entrypoint does not have (this tree: ${PUBLIC_SURFACE_PATH}; a breaking item may also name one the previous release had):\n${lines.join('\n')}\nName each export as its entrypoint exports it.`,
  );
}

/**
 * The public surface of the newest core release before `version`, read from its tag. Refuses
 * when there is no such tag or it holds no surface: an unknown previous surface is not an empty
 * one, and would refuse every name a release removes.
 */
export async function previousCoreSurface(
  root: string,
  version: string,
): Promise<PublicSurface> {
  const prefix = RELEASE_TARGETS.core.tagPrefix;
  const tags = (await releaseTags(root, 'core'))
    .filter((tag) => /^\d+\.\d+\.\d+$/.test(tag.slice(prefix.length)))
    .filter((tag) => comparePreOneVersions(tag.slice(prefix.length), version) < 0)
    .sort((left, right) =>
      comparePreOneVersions(right.slice(prefix.length), left.slice(prefix.length)),
    );
  const previous = tags[0];
  if (previous === undefined)
    throw new Error(
      `No core release tag before ${version} in ${root}: the "**Affects:**" names are checked against the previous release, read from its tag. Run \`git fetch origin --tags\` in a clone; a GitHub Actions job checks out with \`fetch-depth: 0\` (a checkout of the pushed tag holds that tag alone).`,
    );
  const surface = await readFromReleaseTags(root)(previous, PUBLIC_SURFACE_PATH);
  if (surface === undefined)
    throw new Error(
      `${previous} holds no ${PUBLIC_SURFACE_PATH} to check "**Affects:**" names.`,
    );
  return parsePublicSurface(surface);
}
