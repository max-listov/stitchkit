import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runNativeCommand } from 'stitchkit/process';

// The source suite covers the Bun owner; this control exercises the installed Node owner. It only
// waits, so it may run beside proofs that need the host to themselves.
const node = spawnSync('node', ['-p', 'process.execPath']).stdout.toString().trim();
assert.ok(node, 'native Node executable');
const deadline = new AbortController();
// The control takes 61 s by itself; the watchdog adds what a loaded host costs.
const watchdog = setTimeout(() => deadline.abort(new Error('61s control watchdog')), 120_000);
try {
  const result = await runNativeCommand({
    executable: node,
    args: ['-e', "setTimeout(()=>process.stdout.write('done'),61000)"],
    signal: deadline.signal,
    capture: true,
    maxOutputBytes: 4,
  });
  assert.equal(new TextDecoder().decode(result.stdout), 'done');
  assert.equal(result.exitCode, 0);
} finally {
  clearTimeout(watchdog);
}
console.log('packed command without a hidden deadline: ok');
