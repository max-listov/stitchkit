import { execFileSync } from 'node:child_process';

/** A zombie is dead: it only awaits a reaper that this host may not run. */
export function processAlive(pid: number): boolean {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
    return state.trim() !== '' && !state.trim().startsWith('Z');
  } catch {
    return false;
  }
}
