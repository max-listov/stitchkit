import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const sourcePattern = /\.(?:ts|tsx|js|jsx|json|jsonc|css)$/;
const paths = (await Bun.stdin.text()).split('\0').filter((path) => sourcePattern.test(path));

/**
 * Templates that are Biome projects of their own: the root configuration
 * excludes them, so a staged path inside one is checked from its directory
 * with its own configuration, never handed to the root where it is ignored.
 */
const nestedRoots = [
  'packages/create-stitchkit/template/',
  'packages/create-stitchkit/templates/agent/',
  'packages/create-stitchkit/templates/telegram-bot/',
];
const repository = new URL('..', import.meta.url).pathname;

function biomeIgnoredPatterns(base: string): string[] {
  const configPath = join(base, 'biome.json');
  if (!existsSync(configPath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  const includes =
    typeof parsed === 'object' &&
    parsed !== null &&
    'files' in parsed &&
    typeof parsed.files === 'object' &&
    parsed.files !== null &&
    'includes' in parsed.files &&
    Array.isArray(parsed.files.includes)
      ? parsed.files.includes
      : [];
  return includes
    .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('!!'))
    .map((entry) => entry.slice(2));
}

function isIgnoredByBiome(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (path === pattern || path.startsWith(`${pattern}/`)) return true;
    return new Bun.Glob(pattern).match(path);
  });
}

async function check(pathsToCheck: string[], cwd?: string): Promise<number> {
  if (pathsToCheck.length === 0) return 0;
  const base = cwd ?? repository;
  const missing = pathsToCheck.filter((path) => !existsSync(join(base, path)));
  if (missing.length > 0) {
    console.error(`Staged path missing from tree: ${missing.join(', ')}`);
    return 1;
  }
  const ignored = biomeIgnoredPatterns(base);
  const active = pathsToCheck.filter((path) => !isIgnoredByBiome(path, ignored));
  if (active.length === 0) return 0;
  // No `--no-errors-on-unmatched`: a path biome cannot find is a REAL problem
  // (a staged file missing from the tree), not something to pass silently.
  // `--` keeps a path that starts with a dash from being read as a flag.
  const child = Bun.spawn(['bunx', 'biome', 'check', '--error-on-warnings', '--', ...active], {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

const exits = [
  await check(paths.filter((path) => !nestedRoots.some((root) => path.startsWith(root)))),
];
for (const root of nestedRoots) {
  exits.push(
    await check(
      paths.filter((path) => path.startsWith(root)).map((path) => path.slice(root.length)),
      `${repository}${root}`,
    ),
  );
}
globalThis.process.exitCode = exits.find((code) => code !== 0) ?? 0;
