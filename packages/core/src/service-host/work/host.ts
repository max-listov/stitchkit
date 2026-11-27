import { readFile, stat } from 'node:fs/promises';
import { errnoOf } from '../../internal/errno';
import { probeLiveness } from '../../internal/process-identity';
import {
  observeProcessInstance,
  type ProcessInstanceObservation,
} from '../../internal/process-instance';
import { runNativeCommand } from '../../process/command';
import { hostCommandEnv } from '../host-adapter';
import { createDefaultMacosCommandRunner, PS_PATH } from '../macos/runner';
import type { SystemdCommandResult } from '../systemd-inspect';

const HOST_COMMAND_TIMEOUT_MS = 30_000;
const HOST_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;

/** A process's parent and process group, as the process table reports them. */
export interface WorkProcessLineage {
  readonly ppid: number;
  readonly pgid: number;
}

/**
 * The host a boundary is made on and read from: its manager commands, its process table and
 * the caller's own identity. Injected so every answer of the host can be replayed in a test.
 */
export interface WorkHost {
  readonly platform: NodeJS.Platform;
  /** The caller's user id, or `null` where the platform has none. */
  readonly uid: number | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether this runtime can replace its process image, which a process root needs. */
  readonly canReplaceProcess: boolean;
  /** Runs one manager command with a declared environment; `env` adds to the host command's own. */
  runCommand(
    executable: string,
    args: readonly string[],
    options?: { env?: Readonly<Record<string, string>> },
  ): Promise<SystemdCommandResult>;
  /** The text of a file, or `null` when it does not exist. */
  readText(path: string): Promise<string | null>;
  /** The user id owning a directory, or `null` when nothing stands at the path. */
  directoryOwner(path: string): Promise<number | null>;
  observeInstance(pid: number): Promise<ProcessInstanceObservation>;
  liveness(pid: number): Promise<'alive' | 'gone'>;
  /** The parent and group of a process, or `null` when the process table has no such process. */
  lineage(pid: number): Promise<WorkProcessLineage | null>;
}

/** `/proc/<pid>/stat` fields 4 and 5 follow a command name that may hold spaces and parentheses. */
export function parseLinuxLineage(stat: string): WorkProcessLineage | null {
  const end = stat.lastIndexOf(')');
  if (end < 0) return null;
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const ppid = Number(fields[1]);
  const pgid = Number(fields[2]);
  return Number.isSafeInteger(ppid) && Number.isSafeInteger(pgid) && ppid >= 0 && pgid >= 0
    ? { ppid, pgid }
    : null;
}

/** One `ps -o ppid=,pgid= -p <pid>` line: two numbers, or nothing for an absent process. */
export function parsePsLineage(stdout: string): WorkProcessLineage | null {
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(stdout);
  return match ? { ppid: Number(match[1]), pgid: Number(match[2]) } : null;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    const code = errnoOf(cause);
    // A process that ended between two reads answers ESRCH for a file procfs still lists.
    if (code === 'ENOENT' || code === 'ESRCH') return null;
    throw cause;
  }
}

async function darwinLineage(pid: number): Promise<WorkProcessLineage | null> {
  const result = await createDefaultMacosCommandRunner().runCommand(PS_PATH, [
    '-o',
    'ppid=,pgid=',
    '-p',
    String(pid),
  ]);
  const lineage = parsePsLineage(result.stdout);
  if (lineage !== null) return lineage;
  // ps exits 1 with no line when the pid is absent; anything else is a failed read.
  if (result.exitCode === 1 && result.stdout.trim().length === 0) return null;
  throw new Error(`ps did not report the process: ${result.stderr.trim()}`);
}

/** The real host: procfs and systemd on Linux, the process table through `ps` on macOS. */
export function createDefaultWorkHost(): WorkHost {
  const decoder = new TextDecoder();
  return {
    platform: process.platform,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    env: process.env,
    canReplaceProcess: typeof process.execve === 'function',
    async runCommand(executable, args, options) {
      const result = await runNativeCommand({
        executable,
        args: [...args],
        envPolicy: 'declared-only',
        env: { ...hostCommandEnv(), ...options?.env },
        capture: true,
        maxOutputBytes: HOST_COMMAND_MAX_OUTPUT_BYTES,
        timeoutMs: HOST_COMMAND_TIMEOUT_MS,
      });
      return {
        exitCode: result.exitCode ?? 1,
        stdout: decoder.decode(result.stdout),
        stderr: decoder.decode(result.stderr),
      };
    },
    readText,
    async directoryOwner(path) {
      try {
        const entry = await stat(path);
        return entry.isDirectory() ? entry.uid : null;
      } catch (cause) {
        if (errnoOf(cause) === 'ENOENT') return null;
        throw cause;
      }
    },
    observeInstance: observeProcessInstance,
    liveness: (pid) => probeLiveness(pid),
    async lineage(pid) {
      if (process.platform === 'darwin') return darwinLineage(pid);
      const text = await readText(`/proc/${pid}/stat`);
      if (text === null) return null;
      const lineage = parseLinuxLineage(text);
      if (lineage === null) throw new Error(`Unreadable /proc/${pid}/stat`);
      return lineage;
    },
  };
}
