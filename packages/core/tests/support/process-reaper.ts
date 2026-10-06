import { afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';

/**
 * A test owns every process it starts, however it ends.
 *
 * A test that records its members in a list after its first assertion leaks them whenever it fails
 * or times out before that line, and a test runner killed by a signal leaks everything. So the
 * test registers what it will start *before* the process can exist: the leader's group through
 * `onLeaderStarted`, a child it spawns itself by pid, a member the test only learns from a file by
 * that file's path. `reapAfterEachTest()` kills them in `afterEach` and when the runner is
 * interrupted; a runner killed with SIGKILL runs nothing, and the leak gate of `bun run test`
 * (`scripts/test-gate.ts`) reports what it left.
 */
const groups = new Set<number>();
const pids = new Set<number>();
const pidFiles = new Set<string>();

function kill(target: number): void {
  try {
    process.kill(target, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

/**
 * Pass as `onLeaderStarted`: the command's leader owns a process group of its own, and every
 * member of it dies with the test. Do not use it with `group: 'caller'`, where the group is the
 * test runner's own; track that leader with `trackProcess`.
 */
export function trackGroupLeader(event: { pid: number }): void {
  groups.add(event.pid);
}

/** A process the test spawned itself, outside any group it owns. */
export function trackProcess(pid: number | undefined): void {
  if (pid !== undefined) pids.add(pid);
}

/**
 * A member that publishes its pid in a file. Registered by path before the member exists; the file
 * is read when the test ends, and an absent one means the member never got far enough to write it.
 */
export function trackPidFile(path: string): void {
  pidFiles.add(path);
}

function recordedPid(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  // A bare number or a JSON marker (`{ "pid": 123 }`), either of which may be half written.
  const match = /^\s*(\d+)\s*$/.exec(text) ?? /"pid"\s*:\s*(\d+)/.exec(text);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** Kill everything registered, groups first so a member cannot respawn from a leader we missed. */
export function reapTrackedProcesses(): void {
  for (const leader of groups) kill(-leader);
  for (const path of pidFiles) {
    const pid = recordedPid(path);
    if (pid !== undefined) pids.add(pid);
  }
  for (const pid of pids) kill(pid);
  for (const leader of groups) kill(leader);
  groups.clear();
  pids.clear();
  pidFiles.clear();
}

let interruptible = false;

/** Reap after every test of the calling file, and when the runner is interrupted. */
export function reapAfterEachTest(): void {
  afterEach(reapTrackedProcesses);
  if (interruptible) return;
  interruptible = true;
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(name, () => {
      reapTrackedProcesses();
      process.kill(process.pid, name);
    });
}
