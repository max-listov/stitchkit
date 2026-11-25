/**
 * How a role runs: the program and its arguments, never a shell string, with
 * nowhere for a value of the machine to go.
 */
import { z } from 'zod';
import { refuseMachineNames } from './machine-names';

/** The run modes a role declares commands for. */
export const ProjectRunModeSchema = z.enum(['development', 'production']);

/**
 * How to run a role: the program and its arguments, never a shell string.
 *
 * argv rather than a command line for two reasons that are both defects the
 * previous shape had. A string has to be split to be executed, and splitting on
 * spaces destroys quoted arguments and paths with spaces; and a string is a
 * place to hide `--port 8080`, `API_TOKEN=…`, a pipe or a redirect, which is
 * exactly what the boundary rule forbids. With argv there is nothing to split
 * and each member is checked on its own.
 *
 * **Start the role's process, not a launcher that starts it.** Measured under
 * PM2: with a launcher in between, the supervisor's signal reaches both, the
 * launcher forwards its copy, and the role sees two presses in two turns —
 * which every well-behaved shutdown treats as "stop waiting, force it now". A
 * declared 15s drain collapsed to 1.3ms that way, and the only visible trace
 * was a non-zero exit code. A workspace-filtering launcher is worse still: the
 * signal never arrives at all. `PROJECT_LAUNCHERS` refuses the shape.
 */
/**
 * A package-script runner, as a PAIR: the executable and the verb that makes it
 * one.
 *
 * As a bare list of executables this refused `deno run x.ts`, which is a direct
 * runtime invocation and exactly the shape the rule wants. `deno task` is the
 * launcher; `deno run` is not. `npx` and `bunx` are launchers whatever follows.
 */
const PROJECT_SCRIPT_LAUNCHERS: ReadonlyArray<readonly [RegExp, RegExp | null]> = [
  [/^(?:bun|npm|pnpm|yarn)$/, /^run$/],
  [/^deno$/, /^task$/],
  [/^(?:npx|bunx|pnpx)$/, null],
];

function launchesAScript(executable: string, firstArgument: string | undefined): boolean {
  for (const [runner, verb] of PROJECT_SCRIPT_LAUNCHERS) {
    if (!runner.test(executable)) continue;
    if (verb === null) return true;
    if (firstArgument !== undefined && verb.test(firstArgument)) return true;
  }
  return false;
}

/**
 * Flags whose next argument is a port, for the one heuristic that remains.
 *
 * `-p` is included knowingly: it means "port" in almost every server CLI, and
 * refusing `['--port', '8080']` while accepting `['-p', '8080']` would make the
 * rule decorative. It costs a false refusal for the tools where `-p` means
 * something else and takes a number, which the message tells you how to rewrite.
 */
const PORT_FLAG = /^(?:-p|-{1,2}(?:port|listen))$/i;

/**
 * A command part carries neither a machine name nor an inline value.
 *
 * Two of these are STRUCTURAL and one is hygiene, and the difference matters
 * because the texts around this schema used to claim all three were structural.
 *
 * Structural: a part may not be an absolute path, and a part may not be an
 * ASSIGNMENT in any form. `--flag=value` was the hole — `--port=8080`,
 * `--token=…` and `--config=/srv/app/config.json` all parsed clean, because
 * every per-part check looks at the part and the value was hiding inside one.
 * Writing the value as its own argv member is what puts it back under the same
 * checks: `['--port', '8080']` is refused as a port, `['--config', '/srv/…']`
 * as an absolute path.
 *
 * Hygiene: a bare number directly after a flag that names a port. It is a
 * heuristic and is scoped like one — `['--workers', '12']` is a legitimate
 * command and used to be refused. What this cannot do is recognise a secret or
 * a hostname written as a plain word: `sk-live-…` and `db.internal` are
 * indistinguishable from any other argument, and no schema will change that.
 * The boundary is held by having NOWHERE for a value to be required; it is not
 * a proof that nobody wrote one.
 */
const CommandPartSchema = refuseMachineNames('A command part')(z.string().min(1))
  .refine(
    (value) => !value.startsWith('/'),
    'A command part may not be an absolute path — paths are relative to the source',
  )
  .refine(
    // Anything up to the first `=` that is not itself a `=`. The earlier
    // `^-{0,2}[A-Za-z][\w.-]*=` described the shapes its author thought of and
    // let three through — `_API_TOKEN=secret` (a leading underscore is a legal
    // env name), `--set:key=value` and `--opt[k]=v` — while the text beside it
    // said "an assignment in any form".
    (value) => !/^[^=\s]+=/.test(value),
    'A command part may not carry an inline value — write the flag and its value as separate arguments, so the value is checked like every other one',
  );

const CommandArgumentsSchema = z
  .array(CommandPartSchema)
  .refine(
    (args) =>
      args.every(
        (value, index) => !(/^\d{1,5}$/.test(value) && PORT_FLAG.test(args[index - 1] ?? '')),
      ),
    'A number after a port flag is a port — name the variable that carries it and let the role read it',
  );

export const ProjectCommandSchema = z
  .object({
    executable: CommandPartSchema,
    args: CommandArgumentsSchema,
  })
  .strict();

/**
 * A command run under a supervisor, which additionally may not be a launcher.
 *
 * The rule applies to ROLES and not to `build`: a build is not signalled, so a
 * script runner in front of it costs nothing. A supervised role is signalled,
 * and there the launcher is the defect measured above.
 */
export const ProjectRoleCommandSchema = ProjectCommandSchema.refine(
  (value) => !launchesAScript(value.executable, value.args[0]),
  'Start the role process itself, not a script runner: a launcher between the supervisor and the role duplicates the shutdown signal and forces the drain',
).refine(
  (value) => !value.args.includes('--filter'),
  'A workspace filter puts a launcher between the supervisor and the role, and the shutdown signal never reaches it',
);
