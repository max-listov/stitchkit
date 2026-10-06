import { type ChildProcess, spawn } from 'node:child_process';
import type { NativeCommandLaunchedOutput, NativeCommandLaunchedProcess } from './launch';

const groups = new WeakSet<object>();

/** Only this native spawn can establish group ownership; structural PIDs cannot. */
export function spawnOwnedCommand(input: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  group: boolean;
}) {
  const child = spawn(input.executable, [...input.args], {
    cwd: input.cwd,
    env: input.env,
    detached: input.group,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (input.group) groups.add(child);
  return child;
}

/** A channel the command inherited: this package holds no pipe for it, so there is nothing to read. */
const INHERITED_OUTPUT: NativeCommandLaunchedOutput = {
  destroyed: true,
  on: () => undefined,
  destroy: () => undefined,
};

/**
 * A child spawned with the caller's stdin, stdout and stderr. It has no pipes, so it is
 * presented to the transport with outputs that never carry bytes; its exit and close are the
 * child's own.
 */
class InheritedChild implements NativeCommandLaunchedProcess {
  readonly stdout = INHERITED_OUTPUT;
  readonly stderr = INHERITED_OUTPUT;

  constructor(private readonly child: ChildProcess) {}

  get pid() {
    return this.child.pid;
  }

  get exitCode() {
    return this.child.exitCode;
  }

  get signalCode() {
    return this.child.signalCode;
  }

  kill(signal: 'SIGKILL') {
    return this.child.kill(signal);
  }

  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'exit' | 'close',
    listener: (code: number | null, signal: string | null) => void,
  ): unknown;
  on(
    event: 'error' | 'exit' | 'close',
    listener:
      | ((error: Error) => void)
      | ((code: number | null, signal: string | null) => void),
  ): unknown {
    return this.child.on(event, listener);
  }
}

/** The same ownership rule as {@link spawnOwnedCommand}, for a child that inherits stdio. */
export function spawnInheritedCommand(input: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  group: boolean;
}): NativeCommandLaunchedProcess {
  const child = new InheritedChild(
    spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      detached: input.group,
      stdio: 'inherit',
    }),
  );
  if (input.group) groups.add(child);
  return child;
}

export function ownsCommandGroup(child: object): boolean {
  return groups.has(child);
}
