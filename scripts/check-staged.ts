export {};

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

async function check(pathsToCheck: string[], cwd?: string): Promise<number> {
  if (pathsToCheck.length === 0) return 0;
  // No `--no-errors-on-unmatched`: a path biome cannot find is a REAL problem
  // (a staged file missing from the tree), not something to pass silently.
  // `--` keeps a path that starts with a dash from being read as a flag.
  const child = Bun.spawn(
    ['bunx', 'biome', 'check', '--error-on-warnings', '--', ...pathsToCheck],
    {
      cwd,
      stdout: 'inherit',
      stderr: 'inherit',
    },
  );
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
