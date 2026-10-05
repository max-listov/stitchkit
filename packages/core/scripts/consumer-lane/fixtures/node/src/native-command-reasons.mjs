import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCommandError, runNativeCommand } from 'stitchkit/process';
import { verifyNativeStartFailure } from './native-start-failure.mjs';

const command = (script) => ({ executable: process.execPath, args: ['-e', script] });
async function failure(input) {
  try {
    await runNativeCommand(input);
  } catch (error) {
    assert.ok(error instanceof NativeCommandError);
    return error;
  }
  throw new Error('Expected command failure');
}

const deadline = await failure({
  ...command('setInterval(()=>{},1000)'),
  timeoutMs: 30,
  stop: { target: 'group', graceMs: 0 },
});
const script =
  'process.stdout.write(Buffer.from([255,0,97]));process.stderr.write(Buffer.from([98]));';
for (const capture of [true, false]) {
  const budget = await failure({
    ...command(script),
    capture,
    maxOutputBytes: 3,
    timeoutMs: 2000,
    stop: { target: 'group', graceMs: 0 },
  });
  deadline.message = budget.message = 'identical localized message';
  assert.equal(deadline.code, 'COMMAND_LIMIT');
  assert.equal(deadline.reason, 'deadline');
  assert.equal(budget.code, 'COMMAND_LIMIT');
  assert.equal(budget.reason, 'output-budget');
  const exact = await runNativeCommand({
    ...command(script),
    capture: true,
    maxOutputBytes: 4,
    timeoutMs: 2000,
  });
  assert.deepEqual([...exact.stdout], [255, 0, 97]);
  assert.deepEqual([...exact.stderr], [98]);
}

const caller = new Error('Command deadline exceeded');
const controller = new AbortController();
await assert.rejects(
  runNativeCommand({
    ...command("process.stdout.write('ready');setInterval(()=>{},1000)"),
    signal: controller.signal,
    stop: { target: 'group', graceMs: 0 },
    onOutput: () => controller.abort(caller),
  }),
  (error) => error === caller,
);
const missing = await failure({
  executable: '/nonexistent-stitchkit-command',
  timeoutMs: 2000,
});
assert.equal(missing.code, 'COMMAND_UNAVAILABLE');
assert.equal(missing.reason, undefined);
assert.equal(missing.cause.code, 'ENOENT');

const cleanupCause = new Error('cleanup failure');
let calls = 0;
let eventCause;
const cleanup = await failure({
  ...command('setInterval(()=>{},1000)'),
  timeoutMs: 30,
  stop: { target: 'group', graceMs: 0 },
  onLeaderSettled: (event) => {
    calls++;
    assert.equal(event.kind, 'error');
    eventCause = event.cause;
    throw cleanupCause;
  },
});
assert.equal(cleanup.code, 'COMMAND_CLEANUP');
assert.equal(cleanup.reason, undefined);
assert.ok(cleanup.cause instanceof AggregateError);
assert.equal(cleanup.cause.errors[0], eventCause);
assert.equal(eventCause.reason, 'deadline');
assert.equal(calls, 1);

const root = await mkdtemp(join(tmpdir(), 'packed-command-reasons-'));
try {
  const marker = join(root, 'spawned');
  const input = command(
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned')`,
  );
  for (const invalid of [
    { timeoutMs: 0 },
    { timeoutMs: 2_147_483_648 },
    { timeoutMs: 100, capture: true },
    { timeoutMs: 100, maxOutputBytes: 0 },
  ])
    assert.throws(() => runNativeCommand({ ...input, ...invalid }));
  const aborted = new AbortController();
  aborted.abort(caller);
  assert.throws(
    () => runNativeCommand({ ...input, signal: aborted.signal }),
    (error) => error === caller,
  );
  await assert.rejects(access(marker), { code: 'ENOENT' });
} finally {
  await rm(root, { recursive: true, force: true });
}
await verifyNativeStartFailure();
console.log('packed native command reasons: ok');
