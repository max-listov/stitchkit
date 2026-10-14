import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { waitForProcessGroupExit } from '../../src/process/group-settlement';

const root = await mkdtemp(join(tmpdir(), 'group-observation-'));
const table = join(root, 'table');
const failed = join(root, 'failed');
await writeFile(
  join(root, 'ps'),
  `#!/bin/sh
if [ -f '${failed}' ]; then exit 73; fi
/bin/cat '${table}'
`,
  { mode: 0o755 },
);
await writeFile(table, ' 123 S\n');
const originalPath = process.env.PATH;
process.env.PATH = `${root}:${originalPath}`;
const realKill = process.kill;
const realNow = performance.now;
let clock = 0;
try {
  // A stale process-table entry cannot override a fresh kernel absence.
  process.kill = () => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  await waitForProcessGroupExit(123, performance.now() + 3000);

  // A live snapshot can become stale while ps is running, including at the deadline.
  Object.defineProperty(performance, 'now', { value: () => clock });
  let calls = 0;
  process.kill = () => {
    if (++calls === 2) throw Object.assign(new Error('now gone'), { code: 'ESRCH' });
    clock += 3000;
    return true;
  };
  await waitForProcessGroupExit(123, clock + 3000);
  assert.equal(calls, 2);
  // Permission refusal and unknown states are not proof of death.
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  process.kill = () => {
    clock += 1000;
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  };
  await writeFile(table, ' 123 ?E\n');
  await assert.rejects(
    waitForProcessGroupExit(123, performance.now() + 3000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /settlement was not confirmed/);
      assert.ok(error.cause && typeof error.cause === 'object');
      assert.ok('observations' in error.cause && Number(error.cause.observations) > 0);
      assert.ok('lastStates' in error.cause);
      assert.deepEqual(error.cause.lastStates, ['?E']);
      return true;
    },
  );
  // A known zombie is dead even when the kernel still exposes its group.
  await writeFile(table, ' 123 Z\n 456 S\n');
  await waitForProcessGroupExit(123, performance.now() + 3000);
  // Failed observation remains a failure with the exact underlying cause.
  await writeFile(failed, 'refused');
  await assert.rejects(
    waitForProcessGroupExit(123, performance.now() + 3000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.cause instanceof Error);
      assert.ok('code' in error.cause && error.cause.code === 73);
      return true;
    },
  );
  console.log('kernel and process-table settlement controls: ok');
} finally {
  process.kill = realKill;
  Object.defineProperty(performance, 'now', { value: realNow });
  process.env.PATH = originalPath;
  await rm(root, { recursive: true, force: true });
}
