#!/usr/bin/env node
/**
 * `stitchkit upgrade` — the migration plan, from the package itself.
 *
 * A consumer used to recover its plan by cloning this repository and running a
 * script that lives only here, or by being handed the version range in a letter.
 * Both make upgrading depend on us. The changelog ships inside the package and
 * this binary reads it, so `bunx stitchkit@latest upgrade` answers "what do I
 * have to change" in one command, in the consumer's own project, with nobody
 * told anything.
 *
 * Node built-ins only, and a `node` shebang: `npx` must work as well as `bunx`.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planUpgrade, renderUpgradePlan } from './internal/upgrade-plan';

const USAGE = `stitchkit upgrade — print every breaking change between the installed version and this one

  bunx stitchkit@latest upgrade            in a project that depends on stitchkit
  npx stitchkit@latest upgrade

Options
  --from <version>     installed version (default: the stitchkit in ./node_modules)
  --to <version>       target version (default: the version of this package)
  --cwd <dir>          project to read the installed version from (default: .)
  --changelog <path>   changelog to plan from (default: the one in this package)
`;

/** `--name value`, or undefined. A flag with no value is an error, not an absence. */
function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

/** Root of the package this file was installed as: `dist/upgrade-cli.js` → the package. */
function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

function versionOf(packageJsonPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(packageJsonPath, 'utf8');
  } catch {
    return undefined;
  }
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed))
    return undefined;
  const { version } = parsed as { version: unknown };
  return typeof version === 'string' ? version : undefined;
}

export interface UpgradeCliResult {
  /** What to write to stdout. */
  readonly output: string;
  /** Process exit code — 0 when the plan (or "nothing to do") was produced. */
  readonly code: number;
}

/**
 * The whole command as a function of its arguments and the filesystem, so the
 * gate can exercise the paths that matter — a project with no stitchkit
 * installed, a range that runs backwards, a changelog the package did not ship.
 */
export function runUpgradeCli(argv: readonly string[]): UpgradeCliResult {
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    return { output: USAGE, code: 0 };
  }
  const [command] = argv;
  if (command !== 'upgrade') {
    return { output: `Unknown command "${command}".\n\n${USAGE}`, code: 1 };
  }

  const root = packageRoot();
  const to = option(argv, 'to') ?? versionOf(join(root, 'package.json'));
  if (to === undefined) {
    throw new Error(`Cannot read the version of the stitchkit at ${root}`);
  }

  const cwd = resolve(option(argv, 'cwd') ?? process.cwd());
  const from =
    option(argv, 'from') ?? versionOf(join(cwd, 'node_modules', 'stitchkit', 'package.json'));
  if (from === undefined) {
    throw new Error(
      `No stitchkit found in ${join(cwd, 'node_modules')} — run this in the project that depends on it, or pass --from <installed version>`,
    );
  }

  if (from === to) {
    return { output: `Already on ${to}. Nothing to upgrade.\n`, code: 0 };
  }

  const changelogPath = option(argv, 'changelog') ?? join(root, 'CHANGELOG.md');
  let changelog: string;
  try {
    changelog = readFileSync(changelogPath, 'utf8');
  } catch {
    throw new Error(`Cannot read the changelog at ${changelogPath}`);
  }

  return { output: renderUpgradePlan(planUpgrade(changelog, from, to), from, to), code: 0 };
}

/**
 * Was this file executed as a program, rather than imported?
 *
 * Through the real install path that is a **symlink** question, not a string
 * one: npm and bun link `node_modules/.bin/stitchkit` at the built file, Node
 * keeps the link in `argv[1]` and resolves `import.meta.url` to its target. A
 * direct comparison of the two is therefore false for every consumer, and the
 * binary becomes a silent no-op — exit 0, no output, nothing to notice — while
 * running the same file in place works perfectly. Both arguments are passed in
 * so this is decidable without launching a process: under Bun `argv[1]` is
 * already resolved, so a spawned symlink proves nothing about Node.
 */
export function isDirectInvocation(invoked: string | undefined, self: string): boolean {
  if (invoked === undefined) return false;
  if (invoked === self || pathToFileURL(invoked).href === pathToFileURL(self).href)
    return true;
  try {
    return realpathSync(invoked) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    const { output, code } = runUpgradeCli(process.argv.slice(2));
    process.stdout.write(output);
    process.exit(code);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
