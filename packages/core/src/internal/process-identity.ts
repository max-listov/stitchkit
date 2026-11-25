/**
 * Who this machine is and whether a process on it is still there — the two
 * questions a lock owner record has to answer before anything reclaims it.
 *
 * Shared by the exclusive lock and, through it, the diagnostic journal. Both
 * answers are conservative in one direction only: an unknown identity is
 * "unattributable", never "this machine", and an unknown liveness is "alive",
 * never "gone" — so the residual error of either is a refusal to reclaim.
 */

import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { abortReason } from './abort-race';
import {
  type CommandLauncher,
  type LaunchedCommand,
  launchWithBun,
  runWithBunSync,
  type SyncCommandRunner,
} from './bun-command';
import { errnoOf } from './errno';

/**
 * This machine's identity, or `null` when the platform offers none.
 *
 * A host name is **mutable state, not identity**: it changes on a VPN or Tailscale transition, on
 * DHCP handing out a different name, on a container or pod restart. A machine that renamed itself
 * was therefore classified as foreign to itself and could never reclaim its own abandoned lock —
 * observed as a supervisor restarting a service 127 times in 1h47m against a pid that had not
 * existed for hours, recovered only by a human deleting the file.
 *
 * The identity has to come from the operating system, not from a file this library writes: a UUID
 * stored beside the journal, or under a home directory, is copied or shared exactly where the
 * guard matters — a network filesystem — and would make two machines look like one, which is the
 * unsafe direction. So the sources are the platform's own, and where there is none the answer is
 * `null` rather than a guess.
 */
let detectedIdentity: string | null | undefined;

/** The machine-id files are a few bytes the kernel or the init system keeps; reading them never waits. */
const MACHINE_ID_FILES = ['/etc/machine-id', '/var/lib/dbus/machine-id'];

function firstReadableLine(paths: readonly string[]): string | null {
  for (const path of paths) {
    try {
      const text = readFileSync(path, 'utf8').trim();
      if (text.length > 0) return text;
    } catch {
      // Absent or unreadable is not an error here: the next source answers, or nothing does.
    }
  }
  return null;
}

/**
 * Off Bun the command goes through `node:child_process`: the lock is imported by applications
 * that run on Node. Called inside a function, never at module scope: a module of this graph may
 * be loaded where the Node built-ins are empty shims (a browser bundle that reaches the server
 * leaf for an error class), and loading it must not run Node.
 */
const launchWithNode: CommandLauncher = (file, args, maxBuffer) => {
  let stop = (): void => undefined;
  const stdout = new Promise<string>((resolve, reject) => {
    const child = execFile(file, args, { maxBuffer, encoding: 'utf8' }, (error, text) => {
      if (error) reject(error);
      else resolve(text);
    });
    stop = () => {
      child.kill('SIGKILL');
    };
  });
  return { stdout, stop: () => stop() };
};

interface CommandLimits {
  readonly timeout: number;
  readonly maxBuffer: number;
  readonly signal?: AbortSignal;
  readonly launch?: CommandLauncher;
}

/**
 * A bounded command's stdout. The deadline and the caller's signal end the wait themselves,
 * whether or not the command's end is ever reported: the wait does not depend on the child.
 */
function run(file: string, args: readonly string[], limits: CommandLimits): Promise<string> {
  const { timeout, maxBuffer, signal } = limits;
  const launch = limits.launch ?? launchWithBun ?? launchWithNode;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    let command: LaunchedCommand;
    try {
      command = launch(file, args, maxBuffer);
    } catch (error) {
      reject(error);
      return;
    }
    const abandon = (reason: unknown): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      command.stop();
      reject(reason);
    };
    const onAbort = (): void =>
      abandon(signal === undefined ? undefined : abortReason(signal));
    const timer = setTimeout(
      () => abandon(new Error(`${file} did not answer within ${timeout} ms`)),
      timeout,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    command.stdout.then(
      (text) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(text);
      },
      (error: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Off Bun the synchronous command goes through `spawnSync`, whose timeout kills the child.
 */
const runWithNodeSync: SyncCommandRunner = (file, args, { timeout, maxBuffer }) => {
  const result = spawnSync(file, args, {
    timeout,
    maxBuffer,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} ended with ${String(result.status)}`);
  return result.stdout;
};

/**
 * The same bounded command for a caller that cannot wait: the unix socket startup lock runs inside
 * a synchronous `createServer`. It has no signal; the deadline alone ends it.
 */
function runSync(
  file: string,
  args: readonly string[],
  limits: { readonly timeout: number; readonly maxBuffer: number },
): string {
  return (runWithBunSync ?? runWithNodeSync)(file, args, limits);
}

const IOREG_ARGS = ['-rd1', '-c', 'IOPlatformExpertDevice'];
const IOREG_LIMITS = { timeout: 2_000, maxBuffer: 1 << 20 };

/** @internal What the tests replace in a command: who starts it and how long it may take. */
export interface CommandSeam {
  readonly launch?: CommandLauncher;
  readonly timeoutMs?: number;
}

/**
 * `IOPlatformUUID` out of an `ioreg` dump, or `null` when the dump does not carry one.
 *
 * @internal Exported for the tests: the registry only exists on darwin, so a parser folded into the
 * spawn could never be exercised anywhere else — and this branch decides the identity of the very
 * machines the lock policy was fixed for.
 */
export function parsePlatformUuid(dump: string): string | null {
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(dump)?.[1] ?? null;
}

/**
 * @internal `command` and `seam` are for the tests. macOS keeps no machine-id file, so the I/O
 * cannot be removed — but which executable answers can be, and that makes the branch provable off
 * darwin.
 */
export async function readDarwinPlatformUuid(
  command = 'ioreg',
  signal?: AbortSignal,
  seam: CommandSeam = {},
): Promise<string | null> {
  // Spawned at most once per process and only on darwin, and bounded: a lock acquisition must not
  // hang on a registry read.
  try {
    const stdout = await run(command, IOREG_ARGS, {
      timeout: seam.timeoutMs ?? IOREG_LIMITS.timeout,
      maxBuffer: IOREG_LIMITS.maxBuffer,
      ...(signal !== undefined && { signal }),
      ...(seam.launch !== undefined && { launch: seam.launch }),
    });
    return parsePlatformUuid(stdout);
  } catch {
    // Absent, unreadable, over budget, past the deadline or cancelled: all of them mean this
    // machine did not answer, which `attribute` already handles as `unattributable` rather than
    // as a wrong answer.
    return null;
  }
}

/** The same registry read for a caller that cannot wait; `null` on every failure, as above. */
function readDarwinPlatformUuidSync(): string | null {
  try {
    return parsePlatformUuid(runSync('ioreg', IOREG_ARGS, IOREG_LIMITS));
  } catch {
    return null;
  }
}

/**
 * @internal What an undeclared identity is read from. The tests replace `detect` with a read whose
 * command never reports its end, and `forget` drops the memoized answer between cases.
 */
export const identitySource = {
  detect(signal?: AbortSignal): Promise<string | null> {
    return platform() === 'darwin'
      ? readDarwinPlatformUuid('ioreg', signal)
      : Promise.resolve(firstReadableLine(MACHINE_ID_FILES));
  },
  /** The same sources for a caller that cannot wait. */
  detectSync(): string | null {
    return platform() === 'darwin'
      ? readDarwinPlatformUuidSync()
      : firstReadableLine(MACHINE_ID_FILES);
  },
  forget(): void {
    detectedIdentity = undefined;
  },
};

/**
 * A cancelled detection answers `null` and is not remembered: the caller that cancelled is leaving,
 * and the next one asks the platform again.
 */
export async function machineIdentity(
  declared: string | undefined,
  signal?: AbortSignal,
): Promise<string | null> {
  // A declared identity wins: an application on a platform that offers none, or one that knows its
  // own deployment better than the platform does, states it. Detection is memoized because it is a
  // read of an unchanging OS fact, not a policy the caller could want re-evaluated.
  if (declared !== undefined) return declared;
  if (detectedIdentity !== undefined) return detectedIdentity;
  const detected = await identitySource.detect(signal);
  if (signal?.aborted) return null;
  detectedIdentity = detected;
  return detected;
}

/** {@link machineIdentity} for a caller that cannot wait; it shares the memoized answer. */
export function machineIdentitySync(declared: string | undefined): string | null {
  if (declared !== undefined) return declared;
  if (detectedIdentity !== undefined) return detectedIdentity;
  detectedIdentity = identitySource.detectSync();
  return detectedIdentity;
}

type Reachability = 'absent' | 'present' | 'reached';

/** `kill(pid, 0)`: only `ESRCH` is absence; `EPERM` and every other refusal are presence. */
function reachability(pid: number, reach: (target: number) => unknown): Reachability {
  try {
    reach(pid);
  } catch (error) {
    return errnoOf(error) === 'ESRCH' ? 'absent' : 'present';
  }
  return 'reached';
}

const killZero = (target: number) => process.kill(target, 0);

/**
 * Whether the recorded owner is provably gone.
 *
 * `kill(pid, 0)` delivers no signal and reports reachability: `ESRCH` is the only answer that
 * proves absence. `EPERM` means the process exists under another user, which is presence, and
 * every other outcome is unknown — both refuse. PID reuse can only turn a dead owner into a live
 * one, so the residual risk of this check is a refusal to reclaim, never a reclaim over a live
 * writer.
 *
 * Reachability is not liveness, though, and the gap is a zombie: an exited child its parent has not
 * reaped keeps its table entry, so the signal succeeds for a process that is provably finished. A
 * zombie is reported as `gone`, which is what it is — it holds no descriptor and no lock, because it
 * exited. And it is the SAFER half of `gone` rather than a weakening of it: a pid cannot be reused
 * until it is reaped, so a zombie entry is provably the owner the lock recorded, where an absent pid
 * carries the ordinary doubt about reuse. Found by a consuming application, which measured `Z` and a
 * successful signal on both platforms of its fleet. → ADR 0147.
 */
export async function probeLiveness(
  pid: number,
  reach: (target: number) => unknown = killZero,
): Promise<'alive' | 'gone'> {
  const reached = reachability(pid, reach);
  if (reached !== 'reached') return reached === 'absent' ? 'gone' : 'alive';
  // The signal proves an ENTRY in the process table, not a running process. A child that has
  // exited and whose parent has not reaped it keeps its entry, and `kill(pid, 0)` succeeds for it —
  // so the probe that exists to prove absence reported the clearest possible absence as presence.
  // That needs no unusual deployment: a supervisor running as PID 1 in a container is a parent
  // that does not reap.
  return (await isZombieProcess(pid)) ? 'gone' : 'alive';
}

/** {@link probeLiveness} for a caller that cannot wait. */
export function probeLivenessSync(
  pid: number,
  reach: (target: number) => unknown = killZero,
): 'alive' | 'gone' {
  const reached = reachability(pid, reach);
  if (reached !== 'reached') return reached === 'absent' ? 'gone' : 'alive';
  return isZombieProcessSync(pid) ? 'gone' : 'alive';
}

/** The state letter from `/proc/<pid>/stat`, or `null` where there is no `/proc` to ask. */
function procIsZombie(pid: number, procRoot: string): boolean | null {
  try {
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    return stat
      .slice(stat.lastIndexOf(')') + 1)
      .trimStart()
      .startsWith('Z');
  } catch {
    return null;
  }
}

const psStateArgs = (pid: number): string[] => ['-o', 'state=', '-p', String(pid)];
const PS_LIMITS = { timeout: 2_000, maxBuffer: 1 << 16 };

/**
 * The state letter of a pid, or `null` where this platform will not say.
 *
 * `/proc/<pid>/stat` puts the command name in parentheses and the name may itself contain them, so
 * the state follows the LAST `)` — reading the third whitespace-separated field instead is wrong for
 * any process whose name has a space or a bracket in it.
 *
 * @internal `psCommand` is a seam for the tests: `/proc` is Linux-only, so the fallback branch is
 * unreachable here without one, and an untested branch in a liveness probe is how this defect got in.
 */
export async function isZombieProcess(
  pid: number,
  seam: { procRoot?: string; psCommand?: string } & CommandSeam = {},
): Promise<boolean> {
  const { procRoot = '/proc', psCommand = 'ps' } = seam;
  const fromProc = procIsZombie(pid, procRoot);
  if (fromProc !== null) return fromProc;
  // No `/proc` — ask `ps`, which answers on darwin and the BSDs.
  try {
    const stdout = await run(psCommand, psStateArgs(pid), {
      timeout: seam.timeoutMs ?? PS_LIMITS.timeout,
      maxBuffer: PS_LIMITS.maxBuffer,
      ...(seam.launch !== undefined && { launch: seam.launch }),
    });
    return stdout.trim().startsWith('Z');
  } catch {
    // Nothing answered. Treat the owner as present: a refusal to reclaim is the safe outcome, and
    // it is the same outcome this probe had before it could see a zombie at all.
    return false;
  }
}

/** {@link isZombieProcess} for a caller that cannot wait; the same fallback and the same refusal. */
export function isZombieProcessSync(
  pid: number,
  seam: { procRoot?: string; psCommand?: string } = {},
): boolean {
  const { procRoot = '/proc', psCommand = 'ps' } = seam;
  const fromProc = procIsZombie(pid, procRoot);
  if (fromProc !== null) return fromProc;
  try {
    return runSync(psCommand, psStateArgs(pid), PS_LIMITS).trim().startsWith('Z');
  } catch {
    return false;
  }
}
