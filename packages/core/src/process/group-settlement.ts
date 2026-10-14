import { execFile } from 'node:child_process';
import { sleep } from '../internal/timers';
import { processGroupExists } from './group-presence';

/** `killpg(..., 0)` also sees Linux zombies; only live members can still perform work. */
export function hasLiveGroupMember(table: string, group: number): boolean {
  for (const row of table.split(/\r?\n/)) {
    if (!row.trim()) continue;
    const fields = /^\s*(\d+)\s+(\S+)\s*$/.exec(row);
    if (!fields) throw new Error('Invalid process group observation');
    if (Number(fields[1]) === group && !/^[ZX]/.test(fields[2] ?? '')) return true;
  }
  return false;
}

function processGroups(timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pgid=,stat='],
      { encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error)
          reject(
            new Error('Could not observe command process group settlement', { cause: error }),
          );
        else resolve(stdout);
      },
    );
  });
}

/** A delivered SIGKILL is asynchronous; do not report cleanup until every group member is dead. */
export async function waitForProcessGroupExit(
  pid: number | undefined,
  deadline: number,
): Promise<void> {
  if (pid === undefined) return;
  let observations = 0;
  let lastStates: string[] = [];
  for (;;) {
    const remaining = Math.ceil(deadline - performance.now());
    if (remaining <= 0)
      throw new Error('Command process group settlement was not confirmed after SIGKILL', {
        cause: { groupId: pid, observations, lastStates },
      });
    if (!processGroupExists(pid)) return;
    const table = await processGroups(remaining);
    observations++;
    if (!hasLiveGroupMember(table, pid)) return;
    lastStates = table
      .split(/\r?\n/)
      .flatMap((row) => {
        const fields = /^\s*(\d+)\s+(\S+)\s*$/.exec(row);
        return Number(fields?.[1]) === pid ? [fields?.[2] ?? 'unknown'] : [];
      })
      .slice(0, 16);
    // ps is a snapshot: do not let a stale row override a newer kernel absence,
    // including a snapshot that used the last of the observation budget.
    if (!processGroupExists(pid)) return;
    await sleep(Math.min(5, Math.max(0, deadline - performance.now())));
  }
}
