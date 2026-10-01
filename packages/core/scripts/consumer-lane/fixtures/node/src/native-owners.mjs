import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import {
  AtomicFilePublicationError,
  withExclusiveLock,
  writeFileAtomic,
} from 'stitchkit/files';
import {
  observeProcessInstance,
  probeProcessOwner,
  runNativeCommand,
} from 'stitchkit/process';
import { verifySharedUID } from './native-owner-uid.mjs';

const root = await mkdtemp(join(tmpdir(), 'packed-native-owners-'));
const old = process.umask(0o077);
try {
  const observed = await observeProcessInstance(process.pid);
  assert.equal(observed.state, 'observed');
  assert.equal(observed.instance.platform, process.platform);
  assert.deepEqual(await probeProcessOwner(process.pid, observed.instance), {
    identity: 'matched',
    liveness: 'alive',
  });
  for (const change of [{ bootId: 'other-boot' }, { startId: '0' }]) {
    assert.equal(
      (await probeProcessOwner(process.pid, { ...observed.instance, ...change })).liveness,
      'gone',
    );
  }
  const unavailable = await probeProcessOwner(process.pid, null);
  assert.equal(unavailable.identity, 'unavailable');
  assert.ok(unavailable.cause);
  const child = await runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 2000,
  });
  assert.equal(child.exitCode, 0);
  // Native missing-PID IO produces unavailable evidence with its syscall cause.
  const absent = await observeProcessInstance(2_147_483_647);
  assert.equal(absent.state, 'unavailable');
  assert.ok(absent.cause instanceof Error);
  await assert.rejects(observeProcessInstance(4_294_967_297));
  const lock = join(root, 'lock');
  for (const mode of [0o640, 0o600]) {
    await withExclusiveLock(
      lock,
      async () => assert.equal((await stat(lock)).mode & 0o777, mode),
      { mode },
    );
  }
  await writeFile(lock, 'malformed');
  await utimes(lock, 1, 1);
  await assert.rejects(
    withExclusiveLock(
      lock,
      () => {
        throw new Error('stolen');
      },
      { timeoutMs: 20, ownerlessGraceMs: null },
    ),
    { code: 'LOCK_TIMEOUT' },
  );
  assert.equal(await readFile(lock, 'utf8'), 'malformed');
  await writeFile(join(root, 'lock.reclaim'), 'malformed');
  await utimes(join(root, 'lock.reclaim'), 1, 1);
  const owner = await withExclusiveLock(join(root, 'known'), (held) => held.owner);
  await writeFile(
    lock,
    JSON.stringify({ ...owner, process: { ...owner.process, bootId: 'previous-boot' } }),
  );
  await assert.rejects(
    withExclusiveLock(
      lock,
      () => {
        throw new Error('stolen guard');
      },
      { timeoutMs: 20, ownerlessGraceMs: null },
    ),
    { code: 'LOCK_TIMEOUT' },
  );
  assert.equal(await readFile(join(root, 'lock.reclaim'), 'utf8'), 'malformed');
  assert.equal(
    await withExclusiveLock(lock, (held) => held.reclaimed, {
      timeoutMs: 200,
      ownerlessGraceMs: 0,
    }),
    true,
  );
  const file = join(root, 'durable');
  await writeFileAtomic(file, 'bytes', { durability: 'directory', replace: false });
  await assert.rejects(writeFileAtomic(file, 'wrong', { replace: false }), { code: 'EEXIST' });
  const directory = await open(root, 'r');
  const prototype = Object.getPrototypeOf(directory);
  const sync = prototype.sync;
  const cause = new Error('directory durability unavailable');
  const ambiguous = join(root, 'ambiguous');
  try {
    prototype.sync = async function () {
      if ((await this.stat()).isDirectory()) throw cause;
      return sync.call(this);
    };
    await assert.rejects(
      writeFileAtomic(ambiguous, 'published', { durability: 'directory', replace: false }),
      (error) =>
        error instanceof AtomicFilePublicationError &&
        error.published === true &&
        error.cause === cause,
    );
    assert.equal(await readFile(ambiguous, 'utf8'), 'published');
  } finally {
    prototype.sync = sync;
    await directory.close();
  }
  const member = join(root, 'member');
  const helper = `require('node:fs').writeFileSync(${JSON.stringify(member)},String(process.pid));setInterval(()=>{},20)`;
  const launcher = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(member)}))process.exit(0)},5)`;
  let calls = 0;
  const result = await runNativeCommand({
    executable: process.execPath,
    args: ['-e', launcher],
    signal: new AbortController().signal,
    onLeaderSettled: async (event) => {
      calls++;
      assert.equal(event.kind, 'exit');
      process.kill(Number(await readFile(member, 'utf8')), 'SIGTERM');
    },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls, 1);
  await rm(member);
  await assert.rejects(
    runNativeCommand({ executable: process.execPath, args: ['-e', launcher], timeoutMs: 150 }),
    (error) => {
      if (error.code !== 'COMMAND_LIMIT') console.error(inspect(error, { depth: 8 }));
      assert.equal(error.code, 'COMMAND_LIMIT');
      return true;
    },
  );
  await verifySharedUID('stitchkit/files');
  console.log('packed native owners: ok');
} finally {
  process.umask(old);
  await rm(root, { recursive: true, force: true });
}
