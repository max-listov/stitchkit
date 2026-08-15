export {};

const sourcePattern = /\.(?:ts|tsx|js|jsx|json|jsonc|css)$/;
const paths = (await Bun.stdin.text()).split('\0').filter((path) => sourcePattern.test(path));
const templateRoot = 'packages/create-stitchkit/template/';
const rootPaths = paths.filter((path) => !path.startsWith(templateRoot));
const templatePaths = paths
  .filter((path) => path.startsWith(templateRoot))
  .map((path) => path.slice(templateRoot.length));

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

const rootExit = await check(rootPaths);
const templateExit = await check(
  templatePaths,
  new URL('../packages/create-stitchkit/template', import.meta.url).pathname,
);
globalThis.process.exitCode = rootExit || templateExit;
