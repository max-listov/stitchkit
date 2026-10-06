import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { git } from './local-git';
import { BREAKING_HEADING, extractReleaseNotes } from './release-notes';
import { RELEASE_TARGETS, type ReleaseTrain } from './release-train';
import { changedPackedFiles, previousReleaseTag } from './release-unchanged';

/**
 * The gate name under which a green canary is remembered, per tree, in the gate memo.
 */
export const CONSUMER_CANARY_GATE = 'consumer-canary';

/**
 * The consumers a release is tried against, kept out of the repository.
 *
 * A public repository does not name private projects (ADR 0164), so the list lives in a profile
 * file on the machine that releases: `STITCHKIT_CONSUMER_CANARY_PROFILE`, or
 * `$XDG_CONFIG_HOME/stitchkit/consumer-canary.json` (`~/.config/...`).
 */
export const ConsumerProfileSchema = z.object({
  schemaVersion: z.literal(1),
  consumers: z
    .array(
      z.object({
        name: z.string().min(1),
        /** Absolute path of the consumer's git checkout; its committed HEAD is what is tried. */
        path: z.string().startsWith('/'),
        /** Run in the scratch copy after the candidate replaced `stitchkit`. */
        install: z.array(z.string().min(1)).min(1).default(['bun', 'install']),
        /** The consumer's own tests, as an argument vector. */
        test: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().int().positive().max(3_600_000).default(1_200_000),
      }),
    )
    .min(1),
});
export type ConsumerProfile = z.infer<typeof ConsumerProfileSchema>;

export function consumerProfilePath(
  environment: Record<string, string | undefined> = Bun.env,
  home: string = homedir(),
): string {
  const override = environment.STITCHKIT_CONSUMER_CANARY_PROFILE?.trim();
  if (override) return override;
  const config = environment.XDG_CONFIG_HOME?.trim();
  return join(
    config && config.length > 0 ? config : join(home, '.config'),
    'stitchkit',
    'consumer-canary.json',
  );
}

/** A missing profile is a refusal with the way out, never a silent pass. */
export async function readConsumerProfile(path: string): Promise<ConsumerProfile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      throw new Error(
        `No consumer canary profile at ${path}. List the controlled consumers there (docs/architecture/release-process.md#the-consumer-canary), or record a waiver with its reason in release-train.json.`,
      );
    throw error;
  }
  return ConsumerProfileSchema.parse(JSON.parse(text));
}

export interface CanaryDecision {
  required: boolean;
  because: string;
}

/** What a canary is required for: a breaking core release, or a change to the process contract. */
export interface CanaryFacts {
  coreInTrain: boolean;
  coreNotes: string | undefined;
  changedFiles: readonly string[];
}

/** Files whose change alters how a command behaves for every caller of `stitchkit/process`. */
const PROCESS_CONTRACT = [
  'packages/core/src/process/',
  'packages/core/src/entrypoints/process.ts',
];

export function decideCanary(facts: CanaryFacts): CanaryDecision {
  if (!facts.coreInTrain)
    return { required: false, because: 'the train does not release the framework' };
  if (facts.coreNotes !== undefined && BREAKING_HEADING.test(facts.coreNotes))
    return { required: true, because: 'the framework release is breaking' };
  const touched = facts.changedFiles.filter((file) =>
    PROCESS_CONTRACT.some((prefix) => file.startsWith(prefix)),
  );
  if (touched.length > 0)
    return {
      required: true,
      because: `the process contract changed (${touched.slice(0, 3).join(', ')}${touched.length > 3 ? ', …' : ''})`,
    };
  return {
    required: false,
    because: 'the release is additive and does not touch the process contract',
  };
}

/** Reads the facts of a prepared train from the working tree and the previous core tag. */
export async function canaryFacts(root: string, train: ReleaseTrain): Promise<CanaryFacts> {
  const core = train.releases.find((release) => release.target === 'core');
  if (core === undefined)
    return { coreInTrain: false, coreNotes: undefined, changedFiles: [] };
  const changelog = await readFile(join(root, RELEASE_TARGETS.core.changelog), 'utf8');
  const tags = (
    await git(root, ['tag', '--list', `${RELEASE_TARGETS.core.tagPrefix}*`])
  ).split('\n');
  const previous = previousReleaseTag(tags, 'core', core.version);
  return {
    coreInTrain: true,
    coreNotes: extractReleaseNotes(changelog, core.version),
    changedFiles:
      previous === undefined ? [] : await changedPackedFiles(root, 'core', previous),
  };
}
