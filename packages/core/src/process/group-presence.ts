import { errnoOf } from '../internal/errno';

/** A kernel absence is decisive; a Darwin permission refusal is still unknown. */
export function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ESRCH') return false;
    if (process.platform === 'darwin' && code === 'EPERM') return true;
    throw error;
  }
}
