/**
 * The consumer upgrade plan: every `### ⚠️ Breaking changes` section an
 * installed → target range crosses, oldest first.
 *
 * Pure over the changelog text. The reader is `stitchkit upgrade`, the binary
 * this package installs; the changelog it reads ships in the package, so a
 * consumer recovers the plan without cloning the repository or being told the
 * range by whoever cut the release.
 */
export interface UpgradeBreakingChange {
  version: string;
  whoMustAct: string;
  markdown: string;
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

/** Extract every breaking section crossed by an exact `from` (exclusive) → `to` (inclusive) upgrade. */
export function planUpgrade(
  changelog: string,
  from: string,
  to: string,
): UpgradeBreakingChange[] {
  semverParts(from);
  semverParts(to);
  if (compareSemver(from, to) >= 0) {
    throw new Error(`Upgrade range must increase: ${from} → ${to}`);
  }

  const releases = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\].*$/gm)];
  const changes: UpgradeBreakingChange[] = [];
  for (const [index, release] of releases.entries()) {
    const version = release[1];
    if (version === undefined) continue;
    if (compareSemver(version, from) <= 0 || compareSemver(version, to) > 0) continue;
    const bodyStart = (release.index ?? 0) + release[0].length;
    const bodyEnd = releases[index + 1]?.index ?? changelog.length;
    const body = changelog.slice(bodyStart, bodyEnd);
    const breakingHeader = /^### ⚠️ Breaking changes\s*$/m.exec(body);
    if (!breakingHeader) continue;
    const breakingStart = (breakingHeader.index ?? 0) + breakingHeader[0].length;
    const afterHeader = body.slice(breakingStart);
    const nextSection = /^### /m.exec(afterHeader);
    const markdown = afterHeader.slice(0, nextSection?.index ?? afterHeader.length).trim();
    const who = /^\*\*Who must act:\*\*\s*([\s\S]*?)(?=\n\s*\n|\n[-*] )/m.exec(markdown);
    changes.push({
      version,
      whoMustAct:
        who?.[1]?.replace(/\s+/g, ' ').trim() ??
        'Not declared in this legacy changelog section.',
      markdown,
    });
  }
  return changes.sort((left, right) => compareSemver(left.version, right.version));
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
