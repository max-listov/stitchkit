import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import {
  hostIsBun,
  type ObservableChild,
  type OwnedChild,
  spawnBunChild,
  spawnBunInheritedChild,
} from './bun-child';
import type { NativeCommandLaunchedOutput, NativeCommandLaunchedProcess } from './launch';
import {
  abortOwnerLossLaunch,
  attachOwnerLossControl,
  transferOwnerLossControl,
} from './owner-loss-control';
import { type OwnerLossGuardInvocation, ownerLossGuardCommand } from './owner-loss-protocol';

const groups = new WeakSet<object>();

/** Only this native spawn can establish group ownership; structural PIDs cannot. */
export function spawnOwnedCommand(input: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  group: boolean;
  ownerLoss?: OwnerLossGuardInvocation;
}): OwnedChild {
  const child = hostIsBun() ? spawnBunChild(input) : nodeChild(input);
  if (input.group) groups.add(child);
  return child;
}

function nodeChild(input: {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  group: boolean;
  ownerLoss?: OwnerLossGuardInvocation;
}): OwnedChild {
  if (input.ownerLoss === undefined)
    return spawn(input.executable, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      detached: input.group,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  const [executable, ...args] = ownerLossGuardCommand(
    input.ownerLoss,
    input.executable,
    input.args,
  );
  const child = spawn(executable, args, {
    cwd: input.cwd,
    env: input.env,
    detached: input.group,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  });
  const control = child.stdio[3];
  if (!(control instanceof Duplex)) {
    abortOwnerLossLaunch(child.pid);
    throw new Error('Owner-loss guard supplied no control pipe');
  }
  attachOwnerLossControl(child, control);
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

  constructor(private readonly child: ObservableChild) {}

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
  ownerLoss?: OwnerLossGuardInvocation;
}): NativeCommandLaunchedProcess {
  const observable = hostIsBun()
    ? spawnBunInheritedChild(input)
    : (() => {
        if (input.ownerLoss === undefined)
          return spawn(input.executable, [...input.args], {
            cwd: input.cwd,
            env: input.env,
            detached: input.group,
            stdio: 'inherit',
          });
        const [executable, ...args] = ownerLossGuardCommand(
          input.ownerLoss,
          input.executable,
          input.args,
        );
        const spawned = spawn(executable, args, {
          cwd: input.cwd,
          env: input.env,
          detached: input.group,
          stdio: ['inherit', 'inherit', 'inherit', 'pipe'],
        });
        const control = spawned.stdio[3];
        if (!(control instanceof Duplex)) {
          abortOwnerLossLaunch(spawned.pid);
          throw new Error('Owner-loss guard supplied no control pipe');
        }
        attachOwnerLossControl(spawned, control);
        return spawned;
      })();
  const child = new InheritedChild(observable);
  transferOwnerLossControl(observable, child);
  if (input.group) groups.add(child);
  return child;
}

export function ownsCommandGroup(child: object): boolean {
  return groups.has(child);
}
