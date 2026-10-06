import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const ReleaseTargetSchema = z.enum(['core', 'tui', 'create-stitchkit']);
export type ReleaseTarget = z.infer<typeof ReleaseTargetSchema>;

/**
 * Everything the release tooling knows about one published package. Tags,
 * package directories, changelogs, migration guides and the closure that feeds
 * the tarball are read from here and nowhere else.
 */
export interface ReleaseTargetInfo {
  packageName: string;
  /** A tag is this prefix followed by the version. */
  tagPrefix: string;
  directory: string;
  changelog: string;
  /** The upgrade guide a breaking release extends, and the oldest version it has a section for. */
  migration: { guidePath: string; floor: string };
  /** Tracked paths inside `directory` that never reach the tarball. */
  unpackedPaths: readonly string[];
  /** Tracked repository paths outside `directory` whose content builds the tarball. */
  externalInputs: readonly string[];
}

export const RELEASE_TARGETS = {
  core: {
    packageName: 'stitchkit',
    tagPrefix: 'v',
    directory: 'packages/core',
    changelog: 'CHANGELOG.md',
    migration: { guidePath: 'docs/guide/upgrading.md', floor: '0.44.0' },
    unpackedPaths: ['tests', 'examples', 'CHANGELOG.md', 'scripts/consumer-lane'],
    externalInputs: [
      'README.md',
      'docs/guide',
      'docs/api',
      'scripts/gen-llms.ts',
      'scripts/sync-package-readme.ts',
      'scripts/package-build-lock.ts',
    ],
  },
  tui: {
    packageName: 'stitchkit-tui',
    tagPrefix: 'stitchkit-tui-v',
    directory: 'packages/tui',
    changelog: 'packages/tui/CHANGELOG.md',
    migration: { guidePath: 'packages/tui/UPGRADING.md', floor: '0.1.0' },
    unpackedPaths: ['tests', 'CHANGELOG.md', 'UPGRADING.md'],
    externalInputs: [],
  },
  'create-stitchkit': {
    packageName: 'create-stitchkit',
    tagPrefix: 'create-stitchkit-v',
    directory: 'packages/create-stitchkit',
    changelog: 'packages/create-stitchkit/CHANGELOG.md',
    migration: { guidePath: 'packages/create-stitchkit/UPGRADING.md', floor: '0.4.0' },
    unpackedPaths: ['tests', 'CHANGELOG.md'],
    externalInputs: [],
  },
} satisfies Record<ReleaseTarget, ReleaseTargetInfo>;

export const ReleaseTrainSchema = z.object({
  schemaVersion: z.literal(1),
  releases: z
    .array(
      z.object({
        target: ReleaseTargetSchema,
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
      }),
    )
    .min(1)
    .superRefine((releases, context) => {
      const seen = new Set<ReleaseTarget>();
      for (const release of releases) {
        if (seen.has(release.target)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate release target ${release.target}`,
          });
        }
        seen.add(release.target);
      }
    }),
});

export type ReleaseTrain = z.infer<typeof ReleaseTrainSchema>;

export async function readReleaseTrain(root: string): Promise<ReleaseTrain> {
  return ReleaseTrainSchema.parse(
    JSON.parse(await readFile(join(root, 'release-train.json'), 'utf8')),
  );
}

export function releaseTrainEntry(
  train: ReleaseTrain,
  target: ReleaseTarget,
): ReleaseTrain['releases'][number] | undefined {
  return train.releases.find((release) => release.target === target);
}

export function packageDirectory(target: ReleaseTarget): string {
  return RELEASE_TARGETS[target].directory;
}

/** The tag a target's version is released under. */
export function releaseTagForTarget(target: ReleaseTarget, version: string): string {
  return `${RELEASE_TARGETS[target].tagPrefix}${version}`;
}

/** The target a tag belongs to and the version it names, or `undefined` for a foreign tag. */
export function targetForTag(
  tag: string,
): { target: ReleaseTarget; version: string } | undefined {
  // The longest prefix first: `v` alone must not claim `create-stitchkit-v…`.
  const targets = ReleaseTargetSchema.options
    .map((target) => ({ target, prefix: RELEASE_TARGETS[target].tagPrefix }))
    .sort((left, right) => right.prefix.length - left.prefix.length);
  for (const { target, prefix } of targets) {
    if (tag.startsWith(prefix)) return { target, version: tag.slice(prefix.length) };
  }
  return undefined;
}

export interface ReleasePlan {
  target: ReleaseTarget;
  packageName: string;
  packageDir: string;
  changelog: string;
  version: string;
}

/** The package, directory and changelog a release tag publishes. */
export function releasePlanForTag(tag: string): ReleasePlan {
  const parsed = targetForTag(tag);
  if (parsed === undefined) throw new Error(`Unsupported release tag "${tag}"`);
  if (parsed.version === '') {
    throw new Error(
      `${RELEASE_TARGETS[parsed.target].packageName} release tag is missing a version`,
    );
  }
  const info = RELEASE_TARGETS[parsed.target];
  return {
    target: parsed.target,
    packageName: info.packageName,
    packageDir: info.directory,
    changelog: info.changelog,
    version: parsed.version,
  };
}
