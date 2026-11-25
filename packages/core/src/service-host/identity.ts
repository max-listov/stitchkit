import { constants } from 'node:fs';
import { access, readdir, readFile, readlink, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { errnoOf } from '../internal/errno';
import { probeLiveness } from '../internal/process-identity';
import {
  observeProcessInstance,
  observeProcessInstanceAt,
  type ProcessInstance,
  type ProcessInstanceObservation,
  ProcessInstanceSchema,
  type ProcessOwnerEvidence,
  probeProcessOwner,
  probeProcessOwnerWith,
  sameProcessInstance,
} from '../internal/process-instance';
import { runNativeCommand } from '../process/command';
import {
  confirmUnixSocketAfterProbe,
  type ProcNetUnixSocket,
  parseProcNetUnixListeningSockets,
  parseUnixSocketListeners,
  SS_UNIX_LISTENER_ARGS,
  verifyUnixSocketOwnership,
} from './identity-unix-socket';
import { classifyOwnerEvidence, isProcessGoneError } from './process-evidence';

export { type ProcNetUnixSocket, parseProcNetUnixListeningSockets };

const MAX_PID = 2 ** 31 - 1;
const SS_TIMEOUT_MS = 5_000;
const SS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SOCKET_LINK_PATTERN = /^socket:\[(\d+)\]$/;

/**
 * Where iproute2 installs `ss`, tried in order: `/usr/bin/ss` on Debian and Ubuntu (`/bin/ss` on
 * Debian 12, whose merged `/usr` makes it the same file), `/usr/sbin/ss` on Fedora and RHEL,
 * where the package installs into `%{_sbindir}` and provides `/usr/sbin/ss` on a merged `/usr/sbin`.
 */
export const SS_CANDIDATES: readonly string[] = ['/usr/bin/ss', '/usr/sbin/ss'];

async function resolveHostExecutable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (cause) {
      const code = errnoOf(cause);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw cause;
    }
  }
  throw new Error(`ss (iproute2) not found: none of ${candidates.join(', ')} is executable`);
}

/**
 * Injectable process-inspection boundary used by {@link verifySupervisedProcess},
 * defaulting to real procfs + `stitchkit/process` primitives. The default reads the node a
 * socket path is bound to, and the sockets an `@abstract` name stands for, from iproute2 `ss`:
 * on a host without it, a `socketPath` check answers `runtime-unavailable` with reason
 * `socket-unverifiable`.
 */
export interface ProcessIdentityAdapter {
  observeProcessInstance(pid: number): Promise<ProcessInstanceObservation>;
  probeProcessOwner(
    pid: number,
    recorded: ProcessInstance | null | undefined,
  ): Promise<ProcessOwnerEvidence>;
  readProcessExe(pid: number): Promise<string>;
  /**
   * `path` with every symbolic link resolved, as the kernel names a running executable
   * (`/proc/<pid>/exe`); a path that does not exist is answered as it is.
   */
  resolveExecutablePath(path: string): Promise<string>;
  readProcessArgv(pid: number): Promise<string[]>;
  readProcNetUnix(): Promise<string>;
  readProcessSocketInodes(pid: number): Promise<ReadonlySet<string>>;
  /**
   * Inodes of the listening sockets bound to the filesystem node `socketPath` resolves to;
   * empty when nothing stands at the path. Symlinked directories and hard-linked socket
   * names resolve to the same node. For an `@abstract` name, the listening sockets of
   * exactly that name. Read from a table other than `readProcNetUnix`: a socket is taken as
   * listening only where the two agree.
   */
  readSocketInodesAtPath(socketPath: string): Promise<ReadonlySet<string>>;
}

/** How `expectedArgv` is compared against the observed process command line. */
export type ArgvMatchMode = 'exact' | 'prefix';

/** Options for {@link verifySupervisedProcess}. */
export interface VerifySupervisedProcessOptions {
  /** Positive PID of the candidate supervised process. */
  pid: number;
  /** Optional previously recorded `ProcessInstance` identity to verify against. */
  recordedInstance?: ProcessInstance;
  /** Expected executable path reported by `/proc/<pid>/exe`. */
  expectedExe?: string;
  /** Expected command-line tokens reported by `/proc/<pid>/cmdline`. */
  expectedArgv?: readonly string[];
  /** Whether `expectedArgv` must match the full argv (`'exact'`, default) or its prefix (`'prefix'`). */
  argvMatch?: ArgvMatchMode;
  /** Optional listening Unix domain socket path that `pid` must own. */
  socketPath?: string;
  /** Custom process-inspection adapter; defaults to the real Linux procfs adapter. */
  adapter?: ProcessIdentityAdapter;
}

/**
 * Reason why a supervised process cannot currently be verified (`runtime-unavailable`);
 * `socket-unverifiable`: the listening-socket table could not be read (`/proc/net/unix`, or
 * `ss` absent or failing), so ownership of `socketPath` is unknown, not denied.
 */
export type SupervisedProcessUnavailableReason =
  | 'process-unobservable'
  | 'process-gone'
  | 'socket-not-listening'
  | 'socket-unverifiable';

/** Reason why a supervised process conflicts with expected identity (`runtime-conflict`). */
export type SupervisedProcessConflictReason =
  | 'pid-reused'
  | 'exe-mismatch'
  | 'argv-mismatch'
  | 'socket-owned-by-other-process';

/**
 * Discriminated result of {@link verifySupervisedProcess}:
 * - `'verified'` proves live PID birth, expected exe/argv, optional Unix socket
 *   ownership, and unchanged process owner after all inspections;
 * - `'runtime-unavailable'` means the process or socket is absent/restarting or
 *   procfs evidence could not be read;
 * - `'runtime-conflict'` means a different process holds the PID or socket.
 */
export type SupervisedProcessVerification =
  | {
      status: 'verified';
      pid: number;
      instance: ProcessInstance;
      exe: string | undefined;
      argv: string[] | undefined;
      socketInode: string | undefined;
    }
  | {
      status: 'runtime-unavailable';
      reason: SupervisedProcessUnavailableReason;
      pid: number;
      socketPath?: string;
      cause?: unknown;
    }
  | {
      status: 'runtime-conflict';
      reason: SupervisedProcessConflictReason;
      pid: number;
      expectedInstance?: ProcessInstance;
      actualInstance?: ProcessInstance;
      expectedExe?: string;
      actualExe?: string;
      expectedArgv?: string[];
      actualArgv?: string[];
      socketPath?: string;
      listeningInodes?: string[];
    };

function decodeProcCmdline(bytes: Uint8Array): string[] {
  if (bytes.byteLength === 0) return [];
  const text = new TextDecoder('utf-8').decode(bytes);
  const parts = text.split('\0');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * Create the default process-identity adapter backed by Linux `/proc` and
 * Stitchkit's `observeProcessInstance` / `probeProcessOwner`. A `socketPath` check needs
 * iproute2 `ss` at `/usr/bin/ss` or `/usr/sbin/ss`; it never looks `ss` up on `PATH`.
 */
export function createDefaultProcessIdentityAdapter(
  procRoot = '/proc',
): ProcessIdentityAdapter {
  return createProcfsIdentityAdapter({ procRoot, ssCandidates: SS_CANDIDATES });
}

/** The procfs adapter with the places `ss` is looked for named. */
export function createProcfsIdentityAdapter(options: {
  procRoot: string;
  ssCandidates: readonly string[];
}): ProcessIdentityAdapter {
  const { procRoot, ssCandidates } = options;
  const observe = (pid: number): Promise<ProcessInstanceObservation> =>
    procRoot === '/proc'
      ? observeProcessInstance(pid)
      : observeProcessInstanceAt(pid, procRoot);

  const probe = (
    pid: number,
    recorded: ProcessInstance | null | undefined,
  ): Promise<ProcessOwnerEvidence> => {
    if (procRoot === '/proc') return probeProcessOwner(pid, recorded);
    return probeProcessOwnerWith(pid, recorded, {
      read: async (target) => {
        const obs = await observeProcessInstanceAt(target, procRoot);
        return obs.state === 'observed' ? obs.instance : null;
      },
      observe: (target) => observeProcessInstanceAt(target, procRoot),
      liveness: probeLiveness,
    });
  };

  return {
    observeProcessInstance: observe,
    probeProcessOwner: probe,
    readProcessExe: (pid) => readlink(`${procRoot}/${pid}/exe`),
    async resolveExecutablePath(path) {
      try {
        return await realpath(path);
      } catch (cause) {
        const code = errnoOf(cause);
        if (code === 'ENOENT' || code === 'ENOTDIR') return path;
        throw cause;
      }
    },
    readProcessArgv: async (pid) =>
      decodeProcCmdline(await readFile(`${procRoot}/${pid}/cmdline`)),
    readProcNetUnix: () => readFile(`${procRoot}/net/unix`, 'utf8'),
    async readProcessSocketInodes(pid) {
      const fds = await readdir(`${procRoot}/${pid}/fd`);
      const inodes = new Set<string>();
      for (const fd of fds) {
        const target = await readlink(`${procRoot}/${pid}/fd/${fd}`).catch(
          (cause: unknown) => {
            if (isProcessGoneError(cause)) return null;
            throw cause;
          },
        );
        if (target === null) continue;
        const matched = SOCKET_LINK_PATTERN.exec(target);
        if (matched?.[1] !== undefined) inodes.add(matched[1]);
      }
      return inodes;
    },
    async readSocketInodesAtPath(socketPath) {
      const abstract = socketPath.startsWith('@');
      const node = abstract
        ? null
        : await stat(socketPath, { bigint: true }).catch((cause: unknown) => {
            const code = errnoOf(cause);
            if (code === 'ENOENT' || code === 'ENOTDIR') return null;
            throw cause;
          });
      if (!abstract && !node?.isSocket()) return new Set();
      const listed = await runNativeCommand({
        executable: await resolveHostExecutable(ssCandidates),
        args: [...SS_UNIX_LISTENER_ARGS],
        envPolicy: 'declared-only',
        capture: true,
        maxOutputBytes: SS_MAX_OUTPUT_BYTES,
        timeoutMs: SS_TIMEOUT_MS,
      });
      if (listed.exitCode !== 0) {
        throw new Error(
          `ss ${SS_UNIX_LISTENER_ARGS.join(' ')} failed (exit ${listed.exitCode}): ${new TextDecoder().decode(listed.stderr).trim()}`,
        );
      }
      const inodes = new Set<string>();
      for (const entry of parseUnixSocketListeners(new TextDecoder().decode(listed.stdout))) {
        const at =
          node === null
            ? entry.name === socketPath
            : entry.node?.ino === node.ino && entry.node.dev === node.dev;
        if (at) inodes.add(entry.inode);
      }
      return inodes;
    },
  };
}

function argvMatches(
  actual: readonly string[],
  expected: readonly string[],
  mode: ArgvMatchMode,
): boolean {
  if (mode === 'exact') {
    if (actual.length !== expected.length) return false;
  } else if (actual.length < expected.length) {
    return false;
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) return false;
  }
  return true;
}

/**
 * Verify that a live supervised `pid` has a consistent process birth identity,
 * runs the expected executable/argv, optionally owns a listening Unix domain
 * socket, and still matches via `probeProcessOwner` AFTER all checks to close
 * PID-reuse TOCTOU races.
 */
export async function verifySupervisedProcess(
  options: VerifySupervisedProcessOptions,
): Promise<SupervisedProcessVerification> {
  const pid = z.number().int().positive().max(MAX_PID).parse(options.pid);
  const recordedInstance =
    options.recordedInstance === undefined
      ? undefined
      : ProcessInstanceSchema.parse(options.recordedInstance);
  const argvMatch: ArgvMatchMode = options.argvMatch ?? 'exact';
  const adapter = options.adapter ?? createDefaultProcessIdentityAdapter();

  // Step 1: Observe process birth before reading exe/argv/fd.
  const before = await adapter.observeProcessInstance(pid);
  if (before.state === 'unavailable') {
    return {
      status: 'runtime-unavailable',
      reason: isProcessGoneError(before.cause) ? 'process-gone' : 'process-unobservable',
      pid,
      cause: before.cause,
    };
  }
  if (
    recordedInstance !== undefined &&
    !sameProcessInstance(recordedInstance, before.instance)
  ) {
    return {
      status: 'runtime-conflict',
      reason: 'pid-reused',
      pid,
      expectedInstance: recordedInstance,
      actualInstance: before.instance,
    };
  }
  const targetInstance = recordedInstance ?? before.instance;

  // Step 2: Check exe and argv if requested; probe owner on mismatch to distinguish pid-reused/process-gone.
  let observedExe: string | undefined;
  if (options.expectedExe !== undefined) {
    try {
      observedExe = await adapter.readProcessExe(pid);
    } catch (cause) {
      return {
        status: 'runtime-unavailable',
        reason: isProcessGoneError(cause) ? 'process-gone' : 'process-unobservable',
        pid,
        cause,
      };
    }
    // The kernel names the executable with every link resolved: `/usr/bin/node` that links to
    // `/usr/lib/node/bin/node` is the same program.
    if (
      observedExe !== options.expectedExe &&
      observedExe !== (await adapter.resolveExecutablePath(options.expectedExe))
    ) {
      const ownerNow = await adapter.probeProcessOwner(pid, targetInstance);
      const ownerFailure = classifyOwnerEvidence(pid, ownerNow);
      if (ownerFailure !== null) return ownerFailure;
      return {
        status: 'runtime-conflict',
        reason: 'exe-mismatch',
        pid,
        expectedExe: options.expectedExe,
        actualExe: observedExe,
      };
    }
  }

  let observedArgv: string[] | undefined;
  if (options.expectedArgv !== undefined) {
    try {
      observedArgv = await adapter.readProcessArgv(pid);
    } catch (cause) {
      return {
        status: 'runtime-unavailable',
        reason: isProcessGoneError(cause) ? 'process-gone' : 'process-unobservable',
        pid,
        cause,
      };
    }
    if (!argvMatches(observedArgv, options.expectedArgv, argvMatch)) {
      const ownerNow = await adapter.probeProcessOwner(pid, targetInstance);
      const ownerFailure = classifyOwnerEvidence(pid, ownerNow);
      if (ownerFailure !== null) return ownerFailure;
      return {
        status: 'runtime-conflict',
        reason: 'argv-mismatch',
        pid,
        expectedArgv: [...options.expectedArgv],
        actualArgv: observedArgv,
      };
    }
  }

  // Step 3: Optionally verify that pid owns the listening Unix socket at socketPath.
  let matchedSocketInode: string | undefined;
  let socketProcessInodes: ReadonlySet<string> | undefined;
  if (options.socketPath !== undefined) {
    const socketCheck = await verifyUnixSocketOwnership(
      pid,
      options.socketPath,
      targetInstance,
      adapter,
    );
    if (!socketCheck.ok) return socketCheck.failure;
    matchedSocketInode = socketCheck.inode;
    socketProcessInodes = socketCheck.processInodes;
  }

  // Step 4: Re-verify process owner AFTER exe, argv, and socket checks (PID reuse TOCTOU guard).
  const after = await adapter.probeProcessOwner(pid, targetInstance);
  const afterFailure = classifyOwnerEvidence(pid, after);
  if (afterFailure !== null) return afterFailure;

  // Step 4b: Confirm with a post-probe /proc/net/unix snapshot that pid still owns the listening socket.
  if (
    options.socketPath !== undefined &&
    matchedSocketInode !== undefined &&
    socketProcessInodes !== undefined
  ) {
    const confirmed = await confirmUnixSocketAfterProbe(
      pid,
      options.socketPath,
      matchedSocketInode,
      socketProcessInodes,
      targetInstance,
      adapter,
    );
    if (!confirmed.ok) return confirmed.failure;
    matchedSocketInode = confirmed.inode;
  }

  return {
    status: 'verified',
    pid,
    instance: targetInstance,
    exe: observedExe,
    argv: observedArgv,
    socketInode: matchedSocketInode,
  };
}
