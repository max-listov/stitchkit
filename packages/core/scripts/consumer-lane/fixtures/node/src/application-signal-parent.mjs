import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function runSignalCase(mode) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./application-signal-child.mjs', import.meta.url)), mode],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let signalled = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!signalled && stdout.includes('APPLICATION_READY')) {
      signalled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(exitCode, 0, stderr);
  const encoded = stdout.match(/APPLICATION_RESULT (\{.*\})/)?.[1];
  assert.ok(encoded, stdout);
  return JSON.parse(encoded);
}

const clean = await runSignalCase('clean');
assert.equal(clean.outcome, 'clean');
assert.equal(clean.acceptedOperations, 1);
assert.equal(clean.completedOperations, 1);
assert.equal(clean.pendingOperations, 0);

const forced = await runSignalCase('forced');
assert.equal(forced.outcome, 'forced');
assert.equal(forced.reason, 'deadline');
assert.equal(forced.acceptedOperations, 1);
assert.equal(forced.completedOperations, 0);
assert.equal(forced.pendingOperations, 1);
assert.equal(forced.pendingOperationsAtForce, 1);
console.log('node application signal/drain/force: ok');
