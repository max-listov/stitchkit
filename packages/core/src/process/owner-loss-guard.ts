import { spawn } from 'node:child_process';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { hostIsBun, spawnBunGuardTarget } from './bun-child';
import { OWNER_LOSS_GUARD_FLAG } from './owner-loss-protocol';
import { connectOwnerLossSocket } from './owner-loss-socket';

interface GuardMessage {
  kind: 'started' | 'unavailable';
  pid?: number;
  message?: string;
  code?: string;
}

const FORWARDED_SIGNALS = [
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
] as const;

function causeMessage(cause: unknown): { message: string; code?: string } {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string'
  )
    return { message, code: cause.code };
  return { message };
}

function guardMessage(control: Socket, message: GuardMessage, written: () => void): void {
  control.write(`${JSON.stringify(message)}\n`, written);
}

function mirrorTargetExit(
  control: Socket,
  code: number | null,
  signal: string | number | null,
) {
  control.destroy();
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
}

function refuseTarget(control: Socket, cause: unknown): void {
  const detail = causeMessage(cause);
  control.end(
    `${JSON.stringify({ kind: 'unavailable', ...detail } satisfies GuardMessage)}\n`,
    () => {
      process.exitCode = 127;
    },
  );
}

function spawnNodeTarget(
  executable: string,
  args: readonly string[],
  onStarted: (pid: number) => void,
  onExit: (code: number | null, signal: string | number | null) => void,
  onUnavailable: (cause: unknown) => void,
): void {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(executable, [...args], { stdio: 'inherit' });
  } catch (cause) {
    onUnavailable(cause);
    return;
  }
  child.once('spawn', () => {
    const pid = child.pid;
    if (pid === undefined) onUnavailable(new Error('Command started without a pid'));
    else onStarted(pid);
  });
  child.once('error', onUnavailable);
  child.once('exit', onExit);
}

function spawnBunTarget(
  executable: string,
  args: readonly string[],
  onStarted: (pid: number) => void,
  onExit: (code: number | null, signal: string | number | null) => void,
  onUnavailable: (cause: unknown) => void,
): void {
  let child: ReturnType<typeof spawnBunGuardTarget>;
  try {
    child = spawnBunGuardTarget(executable, args);
  } catch (cause) {
    onUnavailable(cause);
    return;
  }
  onStarted(child.pid);
  void child.exited.then(() => onExit(child.exitCode, child.signalCode));
}

function runOwnerLossGuard(
  signalTarget: string | undefined,
  executable: string | undefined,
  args: readonly string[],
): void {
  const bun = hostIsBun();
  const control = bun
    ? connectOwnerLossSocket(3)
    : new Socket({ fd: 3, readable: true, writable: true });
  let armed = true;
  const ownerLost = () => {
    if (!armed) return;
    // This process is the group leader. Its continued existence prevents PGID reuse, and this
    // one signal reaches the target and every descendant that remains in the group.
    process.kill(-process.pid, 'SIGKILL');
  };
  control.once('end', ownerLost);
  control.once('close', ownerLost);
  control.once('error', ownerLost);
  if ((signalTarget !== 'group' && signalTarget !== 'leader') || executable === undefined) {
    armed = false;
    refuseTarget(control, new Error('Owner-loss guard received an invalid invocation'));
    return;
  }
  let targetPid: number | undefined;
  let handshakeWritten = false;
  let pendingTargetExit: { code: number | null; signal: string | number | null } | undefined;
  const forwarders = new Map<NodeJS.Signals, () => void>();
  if (signalTarget === 'leader')
    for (const signal of FORWARDED_SIGNALS) {
      const forward = () => {
        if (targetPid === undefined) return;
        try {
          process.kill(targetPid, signal);
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            throw error;
        }
      };
      forwarders.set(signal, forward);
      process.on(signal, forward);
    }
  const removeForwarders = () => {
    for (const [signal, forward] of forwarders) process.removeListener(signal, forward);
    forwarders.clear();
  };
  const targetStarted = (pid: number) => {
    targetPid = pid;
    guardMessage(control, { kind: 'started', pid }, () => {
      handshakeWritten = true;
      const pending = pendingTargetExit;
      if (pending !== undefined) {
        pendingTargetExit = undefined;
        targetExit(pending.code, pending.signal);
      }
    });
  };
  const targetExit = (code: number | null, signal: string | number | null) => {
    if (!handshakeWritten) {
      pendingTargetExit = { code, signal };
      return;
    }
    armed = false;
    removeForwarders();
    mirrorTargetExit(control, code, signal);
  };
  const targetUnavailable = (cause: unknown) => {
    armed = false;
    removeForwarders();
    refuseTarget(control, cause);
  };
  if (!bun) spawnNodeTarget(executable, args, targetStarted, targetExit, targetUnavailable);
  else spawnBunTarget(executable, args, targetStarted, targetExit, targetUnavailable);
}

let guardInvocation = false;

function startOwnerLossGuardEntry(): void {
  if (process.argv[2] !== OWNER_LOSS_GUARD_FLAG) return;
  const entry = process.argv[1];
  if (entry === undefined || fileURLToPath(import.meta.url) !== entry) return;
  runOwnerLossGuard(process.argv[3], process.argv[4], process.argv.slice(5));
  guardInvocation = true;
}

/**
 * Bootstrap the private owner-loss service before an application's own argv dispatcher.
 *
 * Call this once before routing argv in a single-file application that lazy-imports
 * `stitchkit/process`. `false` means the application owns this invocation and may dispatch it;
 * `true` means the package guard owns it and the application must skip its dispatcher. The guard's
 * child and control channel keep the process alive for exactly their own lifetime.
 */
export function bootstrapNativeCommandOwnerLoss(): boolean {
  return guardInvocation;
}

/** The built or source module that executes the guard protocol when launched directly. */
export function ownerLossGuardEntry(): string {
  return fileURLToPath(import.meta.url);
}

// Keep the ordinary import inert when a bundler supplies empty Node shims. Only the deliberately
// launched guard process may inspect this module's filesystem location and start the protocol.
startOwnerLossGuardEntry();
