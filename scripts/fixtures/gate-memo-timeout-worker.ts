// Writes the memo while another holder owns its lock and prints the lock timeout diagnosis it receives.
import { mock } from 'bun:test';

const [path] = Bun.argv.slice(2);
if (!path) throw new Error('Expected a memo path');
const owner = new URL(
  '../../packages/core/src/internal/with-exclusive-lock.ts',
  import.meta.url,
).pathname;
const { withExclusiveLock: actual } = await import(owner);
mock.module(owner, () => ({
  withExclusiveLock: (lockPath: string, run: () => unknown, options: object) =>
    actual(lockPath, run, { ...options, timeoutMs: 30 }),
}));
const { writeGreenGate } = await import('../gate-memo');
const record = { tree: 'one', toolchain: 'bun:test', at: 'now', commit: '(no commit)' };
try {
  await writeGreenGate('blocked', record, path);
} catch (error) {
  if (!(error instanceof Error)) throw error;
  const { code, label } = {
    code: Reflect.get(error, 'code'),
    label: Reflect.get(error, 'label'),
  };
  console.log(JSON.stringify({ code, label, message: error.message }));
  process.exit(0);
}
throw new Error('A live transaction lock was bypassed');
