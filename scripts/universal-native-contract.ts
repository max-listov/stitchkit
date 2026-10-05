import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { z } from 'zod';
import { RelativePathSchema } from '../packages/core/src/files/native-packaging-layout';

export const UniversalManifestSchema = z
  .object({
    version: z.string().min(1),
    artifacts: z
      .array(
        z.object({
          mode: z.enum(['universal', 'renamed', 'single-arm64', 'single-x64']),
          entryPath: RelativePathSchema,
          architectures: z.array(z.enum(['arm64', 'x64'])).min(1),
          files: z
            .array(
              z.object({
                path: RelativePathSchema,
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                architecture: z.enum(['arm64', 'x64']).optional(),
              }),
            )
            .min(2),
        }),
      )
      .length(4),
  })
  .check((ctx) => {
    const manifest = ctx.value;
    if (new Set(manifest.artifacts.map((artifact) => artifact.mode)).size !== 4)
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Every qualification mode must occur once',
      });
    for (const artifact of manifest.artifacts) {
      const expected =
        artifact.mode === 'single-arm64'
          ? ['arm64']
          : artifact.mode === 'single-x64'
            ? ['x64']
            : ['arm64', 'x64'];
      if (JSON.stringify(artifact.architectures) !== JSON.stringify(expected))
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'Qualification mode has incorrect targets',
        });
      const entries = artifact.files.filter((file) => file.architecture === undefined);
      const addons = artifact.files.filter((file) => file.architecture !== undefined);
      if (
        entries.length !== 1 ||
        entries[0]?.path !== artifact.entryPath ||
        JSON.stringify(addons.map((file) => file.architecture)) !== JSON.stringify(expected)
      )
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'Qualification requires one JS entry and every declared addon',
        });
      if (new Set(artifact.files.map((file) => file.path)).size !== artifact.files.length)
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: 'Qualification paths must be unique',
        });
    }
  });
export type UniversalManifest = z.infer<typeof UniversalManifestSchema>;
export const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const fileDigest = (file: string) => digest(readFileSync(file));
export function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
}
export function assertIsolated(directory: string): void {
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, 'node_modules')))
      throw new Error('Artifact can reach node_modules');
    if (at === parse(at).root) break;
  }
}
