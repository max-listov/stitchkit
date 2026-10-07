// Child `close` is never emitted: cleanup must still settle from the leader and pipe closure it observes itself.
import { EventEmitter } from 'node:events';

// The command's child (a Node child process or the Bun adapter) is the emitter that has a
// `kill`; its pipes keep emitting `close`.
const emit = EventEmitter.prototype.emit;
let suppressed = 0;
EventEmitter.prototype.emit = function (
  this: EventEmitter,
  event: string | symbol,
  ...args: unknown[]
) {
  if (event === 'close' && 'kill' in this) {
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
