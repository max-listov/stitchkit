// Child `close` is never emitted: cleanup must still settle from the leader and pipe closure it observes itself.
import { ChildProcess } from 'node:child_process';

const emit = ChildProcess.prototype.emit;
let suppressed = 0;
ChildProcess.prototype.emit = function (
  this: ChildProcess,
  event: string | symbol,
  ...args: unknown[]
) {
  if (event === 'close') {
    suppressed++;
    return false;
  }
  return emit.call(this, event, ...args);
};
const { runNativeCommand } = await import('../../src/entrypoints/process');
try {
  await runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'setInterval(()=>{},20)'],
    timeoutMs: 30,
    cleanupTimeoutMs: 100,
  });
  throw new Error('must fail');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'COMMAND_LIMIT'))
    throw error;
}
if (!suppressed) throw new Error('negative control did not suppress child close');
console.log('individual handles released: ok');
