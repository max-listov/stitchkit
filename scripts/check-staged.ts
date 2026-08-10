export {};

const sourcePattern = /\.(?:ts|tsx|js|jsx|json|jsonc|css)$/;
const paths = (await Bun.stdin.text()).split('\0').filter((path) => sourcePattern.test(path));

if (paths.length > 0) {
  // No `--no-errors-on-unmatched`: a path biome cannot find is a REAL problem
  // (a staged file missing from the tree), not something to pass silently.
  // `--` keeps a path that starts with a dash from being read as a flag.
  const child = Bun.spawn(['bunx', 'biome', 'check', '--error-on-warnings', '--', ...paths], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  globalThis.process.exitCode = await child.exited;
}
