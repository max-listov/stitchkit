import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';

const ProcessReportSchema = z.object({
  header: z.object({ glibcVersionRuntime: z.string().optional() }),
});

/** The formatter a scaffold runs over the finished tree. */
export interface ProjectFormatter {
  /** The native Biome executable. */
  readonly binary: string;
  /** How long it may run before it is killed and the scaffold rolls back. */
  readonly timeoutMs: number;
}

/**
 * The native Biome executable of the generator's own dependency.
 *
 * Biome's `bin/biome` is a Node launcher that spawns this binary as a child; a
 * timeout would kill the launcher and leave the native process running. The
 * distribution package is therefore resolved here, by the names Biome
 * publishes: `@biomejs/cli-<platform>-<arch>`, with a `-musl` suffix on a Linux
 * without glibc.
 */
function nativeBiome(): string {
  const requireBiome = createRequire(import.meta.resolve('@biomejs/biome/bin/biome'));
  const musl =
    process.platform === 'linux' &&
    ProcessReportSchema.parse(process.report.getReport()).header.glibcVersionRuntime ===
      undefined;
  const distribution = `@biomejs/cli-${process.platform}-${process.arch}${musl ? '-musl' : ''}`;
  return requireBiome.resolve(
    `${distribution}/biome${process.platform === 'win32' ? '.exe' : ''}`,
  );
}

export function defaultProjectFormatter(): ProjectFormatter {
  return { binary: nativeBiome(), timeoutMs: 15_000 };
}

/**
 * Format the finished project and organise its imports with its own Biome
 * configuration. Lint fixes stay with the project's `lint`; the formatter only
 * makes the materialised text match the configuration it ships with.
 */
export function formatProject(destination: string, formatter: ProjectFormatter): void {
  if (!existsSync(join(destination, 'biome.json'))) return;
  execFileSync(formatter.binary, ['check', '--write', '--linter-enabled=false', '.'], {
    cwd: destination,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: formatter.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  });
}
