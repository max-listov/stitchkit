import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const ReleaseTargetSchema = z.enum(['core', 'tui', 'create-stitchkit']);
export type ReleaseTarget = z.infer<typeof ReleaseTargetSchema>;

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
  if (target === 'core') return 'packages/core';
  return target === 'tui' ? 'packages/tui' : 'packages/create-stitchkit';
}
