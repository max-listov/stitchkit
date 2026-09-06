import { readdir, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
  const force = (): void => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      signal(child.pid, 'SIGKILL');
    }
  };
  const forced = setTimeout(force, forceAfterMs);
  await child.exited.catch(() => undefined);
  clearTimeout(forced);
  // The LEADER exiting is not the group ending. Cancelling the force there —
  // which is what this used to do — cancels it in exactly the case it exists
  // for: a descendant that ignored SIGTERM and outlived the process that
  // started it. So the group is asked about, and forced if it is still there.
  const deadline = Date.now() + forceAfterMs;
  while (groupIsAlive(child.pid)) {
    if (Date.now() >= deadline) {
      force();
      break;
    }
    await Bun.sleep(50);
  }
}

/** Whether anything is still in this process group. */
function groupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists and is not ours to signal — still alive.
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
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
 * Reap everything still living inside a directory this lane owns.
 *
 * The role process groups cover the roles and whatever they forked. They do not
 * cover the OTHER things a lane runs in the same tree — a Prisma query engine, a
 * browser left by a Playwright run, a helper that outlived the command that
 * awaited it. Those are the lane's too, and CI found one: the fail-closed check
 * below reported a survivor that no local run had.
 *
 * So the lane clears its own directory first, politely, and only then asserts.
 * The assertion stays as the backstop for anything that survives a SIGKILL.
 */
export async function reapProcessesUnder(directory: string): Promise<number> {
  const living = await processesUnder(directory);
  if (living.length === 0) return 0;
  for (const pid of living) signal(pid, 'SIGTERM');
  await Bun.sleep(2_000);
  for (const pid of await processesUnder(directory)) signal(pid, 'SIGKILL');
  await Bun.sleep(500);
  return living.length;
}

/** Every process whose working directory is inside this tree. */
async function processesUnder(directory: string): Promise<number[]> {
  const found: number[] = [];
  for (const pid of await processIds()) {
    if (pid === process.pid) continue;
    try {
      if ((await readlink(`/proc/${pid}/cwd`)).startsWith(directory)) found.push(pid);
    } catch {
      // Not ours to inspect.
    }
  }
  return found;
}

/**
 * Refuse to finish while something this lane started is still running.
 *
 * A warning here would be read as noise and the leftovers would keep
 * accumulating; the whole incident is what "probably fine" looks like after two
 * and a half hours.
 */
export async function assertNothingSurvives(directory: string): Promise<void> {
  const survivors = await processesUnder(directory);
  if (survivors.length > 0) {
    throw new Error(
      `The lane finished with ${survivors.length} process(es) still running inside ${directory} (pids ${survivors.join(', ')}). Every process a lane starts must be reaped by the lane.`,
    );
  }
}

/**
 * The marker a lane writes into its own directory, naming the process that owns it.
 *
 * Sweeping processes was only half the leak. A lane that dies badly also leaves
 * its TREE — 1.6 GiB of packed tarball, `node_modules` and a built starter, per
 * run. Nothing removed it: `rm(workspace)` lives after the `finally`, and a
 * `finally` covers a throw, not a signal; SIGKILL runs nothing at all. Measured
 * on the same shared host: four abandoned lanes, 3.3 GiB, no open files, on a
 * disk at 97% where a neighbouring database was answering `No space left on
 * device`.
 *
 * So a directory is OWNED, the way a process group is. The owner records what
 * can identify it after the fact — the pid, plus the boot-relative start time
 * that tells a live owner apart from an unrelated process that inherited its
 * number — and the next run removes every lane directory whose owner is gone.
 */
const OWNER_FILE = '.lane-owner';

/**
 * A pid alone cannot answer "is the owner still running": pids are reused, and
 * a reused one makes a dead owner look alive forever. Field 22 of
 * `/proc/<pid>/stat` is the process start time in clock ticks since boot, which
 * is stable for the life of the process and different for its successor. The
 * comm field is parenthesised and may itself contain spaces and parentheses,
 * so the split starts after its LAST closing parenthesis.
 */
async function processStartTime(pid: number): Promise<string | undefined> {
  let stats: string;
  try {
    stats = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined;
  }
  const fields = stats.slice(stats.lastIndexOf(')') + 2).split(' ');
  return fields[19];
}

/** Record this process as the owner of a lane directory it just created. */
export async function claimLaneDirectory(directory: string): Promise<void> {
  const startedAt = await processStartTime(process.pid);
  await writeFile(
    join(directory, OWNER_FILE),
    `${JSON.stringify({ pid: process.pid, startedAt })}\n`,
    'utf8',
  );
}

/** Give a lane's own directory back, after everything living in it is gone. */
export async function releaseLaneDirectory(directory: string): Promise<void> {
  await reapProcessesUnder(directory);
  await rm(directory, { recursive: true, force: true });
}

/**
 * A directory with no marker predates this mechanism, or belongs to a lane that
 * was killed in the moment between creating it and claiming it. Either way its
 * owner cannot be asked, so it is only swept once it is far older than any lane
 * run and nothing is living inside it — the fail-safe direction is to KEEP it,
 * because deleting a live sibling's tree is this fix causing the next incident.
 */
const UNCLAIMED_GRACE_MS = 6 * 60 * 60 * 1000;

async function laneDirectoryIsAbandoned(directory: string): Promise<boolean> {
  let marker: string;
  try {
    marker = await readFile(join(directory, OWNER_FILE), 'utf8');
  } catch {
    let age: number;
    try {
      age = Date.now() - (await stat(directory)).mtimeMs;
    } catch {
      return false;
    }
    if (age < UNCLAIMED_GRACE_MS) return false;
    return (await processesUnder(directory)).length === 0;
  }

  let owner: { pid?: unknown; startedAt?: unknown };
  try {
    owner = JSON.parse(marker) as typeof owner;
  } catch {
    return false;
  }
  if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid)) return false;
  if (owner.pid === process.pid) return false;
  const startedAt = await processStartTime(owner.pid);
  // Gone, or the number now belongs to something that started later.
  return startedAt === undefined || startedAt !== owner.startedAt;
}

/**
 * Remove the trees earlier runs left behind, before this one adds another.
 *
 * The counterpart of `sweepAbandonedLaneProcesses`, and the only defence that
 * survives a SIGKILL — which, on a host whose memory guard kills the gate, is
 * how these are actually produced.
 */
export async function sweepAbandonedLaneDirectories(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!LANE_DIRECTORY_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
    const directory = join(tmpdir(), entry);
    if (!(await laneDirectoryIsAbandoned(directory))) continue;
    try {
      await rm(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch {
      // Another run may have removed it first, or it is not ours to remove.
    }
  }
  return removed;
}
