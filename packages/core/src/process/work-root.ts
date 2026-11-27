import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readProcessInstanceSync } from '../internal/process-instance';

/** Marks the private invocation that turns this process into the recorded root of a piece of work. */
export const WORK_ROOT_FLAG = '--stitchkit-work-root-v1';

/** The exit code of a root that could not become its command, as a shell reports a missing one. */
export const WORK_ROOT_UNAVAILABLE_EXIT = 127;

const OriginPrefixSchema = z.record(z.string(), z.unknown());

/**
 * Argv that starts `executable` as a recorded process root: the package-owned entry measures
 * its own process instance, writes `origin` plus that root into the variable `variable`, and
 * replaces itself with the command — same pid, same start, no process left in between.
 */
export function workRootCommand(input: {
  variable: string;
  origin: Readonly<Record<string, unknown>>;
  executable: string;
  args: readonly string[];
}): [string, ...string[]] {
  return [
    process.execPath,
    workRootEntry(),
    WORK_ROOT_FLAG,
    input.variable,
    JSON.stringify(input.origin),
    '--',
    input.executable,
    ...input.args,
  ];
}

/** `execve` takes a path, never a name: a bare name is found on the command's own `PATH`. */
function resolveExecutable(executable: string, path: string | undefined): string {
  if (executable.includes('/')) return executable;
  for (const directory of (path ?? '').split(delimiter)) {
    if (directory.length === 0) continue;
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here; the next directory of PATH may hold it.
    }
  }
  throw new Error(`Command not found on PATH: ${executable}`);
}

function becomeWorkRoot(argv: readonly string[]): never {
  const [variable, origin, separator, executable, ...args] = argv;
  if (
    variable === undefined ||
    origin === undefined ||
    separator !== '--' ||
    executable === undefined
  )
    throw new Error('Work root received an invalid invocation');
  if (typeof process.execve !== 'function')
    throw new Error('Work root requires a runtime with process.execve');
  const instance = readProcessInstanceSync(process.pid);
  if (instance === null)
    throw new Error('Work root could not observe its own process instance');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined) env[key] = value;
  env[variable] = JSON.stringify({
    ...OriginPrefixSchema.parse(JSON.parse(origin)),
    boundary: { kind: 'process-root', root: { pid: process.pid, instance } },
  });
  return process.execve(resolveExecutable(executable, env.PATH), [executable, ...args], env);
}

let workRootInvocation = false;

function startWorkRootEntry(): void {
  if (process.argv[2] !== WORK_ROOT_FLAG) return;
  const entry = process.argv[1];
  if (entry === undefined || fileURLToPath(import.meta.url) !== entry) return;
  workRootInvocation = true;
  try {
    becomeWorkRoot(process.argv.slice(3));
  } catch (cause) {
    // The command never started: say why on the channel it would have used, and exit as a
    // shell does for a command it could not run.
    process.stderr.write(
      `stitchkit work root: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exitCode = WORK_ROOT_UNAVAILABLE_EXIT;
  }
}

/** Whether this process was started as a work root and could not become its command. */
export function workRootStarted(): boolean {
  return workRootInvocation;
}

/** The built or source module that becomes a work root when launched directly. */
export function workRootEntry(): string {
  return fileURLToPath(import.meta.url);
}

// Inert on an ordinary import: only the deliberately launched invocation reads its own location.
startWorkRootEntry();
