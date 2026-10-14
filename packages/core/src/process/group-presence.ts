/** A kernel absence is decisive; a Darwin permission refusal is still unknown. */
export function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'ESRCH') return false;
      if (process.platform === 'darwin' && error.code === 'EPERM') return true;
    }
    throw error;
  }
}
