/**
 * Total neutral-identity sweep over a GENERATED starter tree — the guard that
 * replaces a hand-kept list of substitutions. Any file that still carries the
 * template's neutral identity outside the explicit allowlist means a rendering
 * projection was missed; a fixed list of known replacements can never prove
 * that, because nobody enumerates what should have been on it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const NEUTRAL_IDENTITY_MARKERS = [
  'stitchkit-starter',
  'stitchkit_starter',
  'Stitchkit Starter',
] as const;

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'playwright-report',
  'test-results',
]);

async function walk(root: string, relativePath: string, files: string[]): Promise<void> {
  const entries = await readdir(join(root, relativePath), { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      await walk(root, entryPath, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
}

/** Every `path — marker` occurrence outside the allowlist, empty when clean. */
export async function findNeutralIdentity(
  root: string,
  allowlist: readonly string[],
): Promise<string[]> {
  const allowed = new Set(allowlist);
  const files: string[] = [];
  await walk(root, '', files);
  const offenders: string[] = [];
  for (const file of files.sort()) {
    if (allowed.has(file)) continue;
    const content = await readFile(join(root, file), 'utf8').catch(() => null);
    if (content === null) continue; // binary / unreadable — markers are text
    for (const marker of NEUTRAL_IDENTITY_MARKERS) {
      if (content.includes(marker)) offenders.push(`${file} — ${marker}`);
    }
  }
  return offenders;
}
