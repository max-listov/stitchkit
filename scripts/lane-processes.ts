import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A lane owns the processes it starts — including when it dies badly.
 *
 * The failure is the one the template already defends against, turned on the
 * lane itself: **killing the wrapper does not kill the role.** A lane starts an
 * API and a web role through `bun run`, which is a launcher; if the lane then
 * exits any way other than the happy path — a failing check, a timeout, a
 * signal, the OOM killer — its `finally` never runs, the temporary directory is
 * removed later, and the roles keep running with a deleted working directory.
 * They accumulate silently, one set per run.
 *
 * Measured on a shared development host: 101 orphaned processes over ~2.5 hours
 * of runs, 4.3 GiB resident plus swap, load 44 on 12 CPUs, four OOM kills —
 * including processes that had nothing to do with any lane. They all died to a
 * plain SIGTERM: nobody was ever asking them to stop.
 *
 * Two mechanisms, because one is not enough. A lane owns a process GROUP rather
 * than a list of children, so one signal reaches everything it started however
 * deep. And every run SWEEPS first, so a predecessor that was SIGKILLed — the
 * one case no handler can survive — never outlives a single further run.
 */

/** Temporary-directory prefixes a lane creates under the system temp dir. */
export const LANE_DIRECTORY_PREFIXES = [
  'stitchkit-starter-lane-',
  'supervised-lane-',
  'starter-signal-',
] as const;

const DELETED_SUFFIX = ' (deleted)';

function looksLikeALaneDirectory(target: string): boolean {
  return LANE_DIRECTORY_PREFIXES.some((prefix) => target.includes(`/${prefix}`));
}

async function processIds(): Promise<number[]> {
  try {
    const entries = await readdir('/proc');
    return entries.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // Not a procfs platform. The group kill below still holds; only the sweep
    // of a previous run's leftovers is unavailable, and the caller is told.
    return [];
  }
}

/** Processes still living inside a lane directory that no longer exists. */
export async function abandonedLaneProcesses(): Promise<number[]> {
  const abandoned: number[] = [];
  for (const pid of await processIds()) {
    if (pid === process.pid) continue;
    let cwd: string;
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      continue;
    }
    // ONLY a deleted directory. A live sibling run has a directory that still
    // exists, and killing into it would be this fix causing the next incident.
    if (!cwd.endsWith(DELETED_SUFFIX) || !looksLikeALaneDirectory(cwd)) continue;
    abandoned.push(pid);
  }
  return [...abandoned, ...(await abandonedSupervisorDaemons())];
}

/**
 * A supervisor daemon whose isolated home is gone.
 *
 * The supervised lane points `PM2_HOME` at its own temporary directory, so its
 * daemon is separate from the developer's. That also means a lane that dies
 * leaves a daemon nobody will ever talk to again — and its own working
 * directory is not inside the lane tree, so the cwd sweep above cannot see it.
 */
async function abandonedSupervisorDaemons(): Promise<number[]> {
  const abandoned: number[] = [];
  for (const pid of await processIds()) {
    if (pid === process.pid) continue;
    let environment: string;
    try {
      environment = await readFile(`/proc/${pid}/environ`, 'utf8');
    } catch {
      continue;
    }
    const home = environment
      .split('\0')
      .find((entry) => entry.startsWith('PM2_HOME='))
      ?.slice('PM2_HOME='.length);
    if (!home || !looksLikeALaneDirectory(home)) continue;
    if (await exists(home)) continue;
    abandoned.push(pid);
  }
  return abandoned;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function signal(pid: number, name: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, name);
  } catch {
    // Already gone between listing and signalling. That is the outcome we want.
  }
}

/**
 * Remove what a previous run left behind, before this one adds to it.
 *
 * Politely first: every orphan measured so far died to a plain SIGTERM, because
 * nothing had ever asked them to stop.
 */
export async function sweepAbandonedLaneProcesses(): Promise<number> {
  const abandoned = await abandonedLaneProcesses();
  if (abandoned.length === 0) return 0;
  for (const pid of abandoned) signal(pid, 'SIGTERM');
  await Bun.sleep(2_000);
  for (const pid of await abandonedLaneProcesses()) signal(pid, 'SIGKILL');
  return abandoned.length;
}

/**
 * Stop a process and everything it started.
 *
 * `Bun.spawn({ detached: true })` makes the child a process-group leader, so a
 * negative pid reaches the whole group — the role, its launcher, and whatever
 * either of them forked. Signalling the child alone is what leaves the role
 * running.
 */
export async function stopProcessGroup(
  child: { pid: number; exited: Promise<number> },
  forceAfterMs = 5_000,
): Promise<void> {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    signal(child.pid, 'SIGTERM');
  }
  const forced = setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      signal(child.pid, 'SIGKILL');
    }
  }, forceAfterMs);
  await child.exited.catch(() => undefined);
  clearTimeout(forced);
}

/**
 * Run cleanup on every exit path, not only the happy one.
 *
 * A `finally` covers a throw. It does not cover a signal, which is how a lane
 * dies when a person interrupts it or a supervisor stops it — and those are the
 * runs that leave the most behind. SIGKILL cannot be caught by anything; that
 * one is what the sweep exists for.
 */
export function reapOnTermination(cleanup: () => Promise<void> | void): void {
  let running = false;
  const handle = (name: NodeJS.Signals): void => {
    if (running) return;
    running = true;
    void Promise.resolve(cleanup())
      .catch((error: unknown) => {
        // The process is already going down; a cleanup that fails here has
        // nowhere to report to but the log, and an unhandled rejection would
        // replace the exit the signal asked for.
        console.error('[lane] cleanup failed while terminating:', error);
      })
      .finally(() => {
        process.kill(process.pid, name);
      });
  };
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(name, () => {
      process.removeAllListeners(name);
      handle(name);
    });
  }
}

/**
 * The supervisor daemon a lane started in its own isolated home, if it is still
 * alive.
 *
 * Asked of the DAEMON, through the pid file it writes itself, because the
 * command that was supposed to kill it succeeding is not the same fact. A
 * daemon left running keeps restarting the roles it owns, and its own working
 * directory is not inside the lane tree — so the cwd sweep cannot see it.
 */
export async function supervisorPidIn(home: string): Promise<number | undefined> {
  let pid: number;
  try {
    pid = Number((await readFile(join(home, 'pm2.pid'), 'utf8')).trim());
  } catch {
    return undefined;
  }
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

/**
 * Refuse to finish while something this lane started is still running.
 *
 * A warning here would be read as noise and the leftovers would keep
 * accumulating; the whole incident is what "probably fine" looks like after two
 * and a half hours.
 */
export async function assertNothingSurvives(directory: string): Promise<void> {
  const survivors: number[] = [];
  for (const pid of await processIds()) {
    if (pid === process.pid) continue;
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (cwd.startsWith(directory)) survivors.push(pid);
    } catch {
      // Not ours to inspect.
    }
  }
  if (survivors.length > 0) {
    throw new Error(
      `The lane finished with ${survivors.length} process(es) still running inside ${directory} (pids ${survivors.join(', ')}). Every process a lane starts must be reaped by the lane.`,
    );
  }
}
