/**
 * The consumer upgrade plan: every `### ⚠️ Breaking changes` section an
 * installed → target range crosses, oldest first.
 *
 * Pure over the changelog text. The reader is `stitchkit upgrade`, the binary
 * this package installs; the changelog it reads ships in the package, so a
 * consumer recovers the plan without cloning the repository or being told the
 * range by whoever cut the release.
 */
import {
  affectsLineOf,
  breakingItems,
  fixedSectionItems,
  parseAffectsLine,
  type UpgradeAffectsTarget,
} from './upgrade-affects';

/** One `- ` item of a release section, with its machine line when it declares one. */
export interface UpgradeItem {
  version: string;
  /** The backticked entrypoints the item leads with. */
  entrypoints: string[];
  /** The item's bold title, or its first line. */
  title: string;
  /** What the item touches; `undefined` for an item written before the `**Affects:**` line. */
  affects: UpgradeAffectsTarget[] | undefined;
  markdown: string;
}

/** One breaking item of a release. */
export interface UpgradeBreakingItem extends UpgradeItem {
  /** The item's own `**Who must act:**`, or its section's. */
  whoMustAct: string;
}

export interface UpgradeBreakingChange {
  version: string;
  whoMustAct: string;
  markdown: string;
  items: UpgradeBreakingItem[];
}

/**
 * The heading that marks a changelog section as breaking. The release gate and `stitchkit upgrade`
 * read it through this one expression, so a heading one accepts is a heading the other finds.
 */
export const BREAKING_HEADING = /^### \s*⚠️?\s*Breaking changes[^\n]*$/m;

const NOT_DECLARED = 'Not declared in this legacy changelog section.';

/** The backticked `stitchkit` (or `stitchkit-…` package) entrypoints an item leads with, in order. */
export function leadingEntrypoints(
  item: string,
  accept: (entrypoint: string) => boolean = () => true,
): string[] {
  let rest = item.replace(/^[-*+] /, '').replace(/^\*\*/, '');
  const names: string[] = [];
  for (;;) {
    const match = /^`(stitchkit(?:-[a-z0-9-]+)?(?:\/[a-z0-9][a-z0-9-]*)*)`/.exec(rest);
    const name = match?.[1];
    if (!match || name === undefined || !accept(name)) break;
    names.push(name);
    rest = rest.slice(match[0].length);
    const separator = /^(?:, and |, | and | \+ )/.exec(rest);
    if (!separator) break;
    rest = rest.slice(separator[0].length);
  }
  return names;
}

function itemTitle(item: string): string {
  const flat = item.replace(/\s+/g, ' ').trim();
  const bold = /\*\*(.+?)\*\*/.exec(flat)?.[1];
  if (bold !== undefined && !bold.startsWith('Who must act') && !bold.startsWith('Affects'))
    return bold.replace(/\.$/, '');
  const first = flat.replace(/^[-*+] /, '');
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}

function itemAudience(item: string): string | undefined {
  const flat = item.replace(/\s+/g, ' ');
  const who = /\*\*Who must act:\*\*\s*(.*?)(?=\s+See \[|\s+→|\s+\*\*Affects:\*\*|$)/.exec(
    flat,
  )?.[1];
  return who?.trim() || undefined;
}

function upgradeItem(
  version: string,
  item: string,
  title: (text: string) => string = itemTitle,
): UpgradeItem {
  const line = affectsLineOf(item);
  return {
    version,
    entrypoints: leadingEntrypoints(item),
    title: title(item.replace(/^[ \t]*\*\*Affects:\*\*.*$/gm, '').trimEnd()),
    affects: line === undefined ? undefined : parseAffectsLine(line),
    markdown: item,
  };
}

/** A fix reads as a sentence: its first one, without the entrypoint it already leads with. */
function fixTitle(item: string): string {
  const flat = item
    .replace(/\s+/g, ' ')
    .replace(/^[-*+] /, '')
    .trim();
  const prefix = /^(?:`stitchkit[^`]*`(?:, and |, | and | \+ )?)+\s*[:—-]?\s*/.exec(flat);
  const text = flat.slice(prefix?.[0].length ?? 0).replace(/\*\*/g, '');
  const sentence = /^(.*?[.!?])(?:\s|$)/.exec(text)?.[1] ?? text;
  const trimmed = sentence.replace(/[.:]$/, '');
  return trimmed.length > 100 ? `${trimmed.slice(0, 99)}…` : trimmed;
}

function fixedItem(version: string, item: string): UpgradeItem {
  return upgradeItem(version, item, fixTitle);
}

function sectionItems(
  version: string,
  markdown: string,
  sectionAudience: string,
): UpgradeBreakingItem[] {
  return breakingItems(markdown).map(({ markdown: item }) => ({
    ...upgradeItem(version, item),
    whoMustAct: itemAudience(item) ?? sectionAudience,
  }));
}

function semverParts(version: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`Expected an exact semver, received "${version}"`);
  const [, major, minor, patch] = match;
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new Error(`Expected an exact semver, received "${version}"`);
  }
  return [Number(major), Number(minor), Number(patch)];
}

function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (const index of [0, 1, 2] as const) {
    const difference = a[index] - b[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The changelog bodies of the releases in the exact range `from` (exclusive) → `to` (inclusive). */
function releasesInRange(
  changelog: string,
  from: string,
  to: string,
): { version: string; body: string }[] {
  semverParts(from);
  semverParts(to);
  if (compareSemver(from, to) >= 0) {
    throw new Error(`Upgrade range must increase: ${from} → ${to}`);
  }
  const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\].*$/gm)];
  const found: { version: string; body: string }[] = [];
  for (const [index, release] of releases.entries()) {
    const version = release[1];
    if (version === undefined) continue;
    if (compareSemver(version, from) <= 0 || compareSemver(version, to) > 0) continue;
    const bodyStart = (release.index ?? 0) + release[0].length;
    const bodyEnd = releases[index + 1]?.index ?? changelog.length;
    found.push({ version, body: changelog.slice(bodyStart, bodyEnd) });
  }
  return found;
}

/** Extract every breaking section crossed by an exact `from` (exclusive) → `to` (inclusive) upgrade. */
export function planUpgrade(
  changelog: string,
  from: string,
  to: string,
): UpgradeBreakingChange[] {
  const changes: UpgradeBreakingChange[] = [];
  for (const { version, body } of releasesInRange(changelog, from, to)) {
    const breakingHeader = BREAKING_HEADING.exec(body);
    if (!breakingHeader) continue;
    const breakingStart = (breakingHeader.index ?? 0) + breakingHeader[0].length;
    const afterHeader = body.slice(breakingStart);
    const nextSection = /^### /m.exec(afterHeader);
    const markdown = afterHeader.slice(0, nextSection?.index ?? afterHeader.length).trim();
    const who = /^\*\*Who must act:\*\*\s*([\s\S]*?)(?=\n\s*\n|\n[-*] )/m.exec(markdown);
    const whoMustAct = who?.[1]?.replace(/\s+/g, ' ').trim() ?? NOT_DECLARED;
    changes.push({
      version,
      whoMustAct,
      markdown,
      items: sectionItems(version, markdown, whoMustAct),
    });
  }
  return changes.sort((left, right) => compareSemver(left.version, right.version));
}

/** The items of every `### Fixed` section of a release body. */
export function fixedItems(version: string, body: string): UpgradeItem[] {
  return fixedSectionItems(body).map(({ markdown }) => fixedItem(version, markdown));
}

/** The fixes of an exact `from` (exclusive) → `to` (inclusive) upgrade, oldest first. */
export interface UpgradeFixes {
  /** Fixes that name what they touch. */
  declared: UpgradeItem[];
  /** Fixes of the range that carry no machine line, before the rule that asks for one. */
  withoutAffects: number;
}

export function planFixes(changelog: string, from: string, to: string): UpgradeFixes {
  const releases = releasesInRange(changelog, from, to).sort((left, right) =>
    compareSemver(left.version, right.version),
  );
  const all = releases.flatMap(({ version, body }) => fixedItems(version, body));
  return {
    declared: all.filter((item) => item.affects !== undefined),
    withoutAffects: all.filter((item) => item.affects === undefined).length,
  };
}

export function renderUpgradePlan(
  changes: readonly UpgradeBreakingChange[],
  from: string,
  to: string,
): string {
  const header = `# Stitchkit upgrade ${from} → ${to}`;
  if (changes.length === 0) return `${header}\n\nNo breaking sections in this range.\n`;
  return `${header}\n\n${changes
    .map(
      (change) =>
        `## ${change.version}\n\n**Who must act:** ${change.whoMustAct}\n\n${change.markdown.replace(/^\*\*Who must act:\*\*[\s\S]*?(?=\n\s*\n|\n[-*] )/m, '').trim()}`,
    )
    .join('\n\n')}\n`;
}
