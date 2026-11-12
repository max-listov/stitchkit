import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindUnixSocket,
  createManagedFileBoundary,
  writeFileAtomic,
  writeFileAtomicSync,
} from 'stitchkit/files';
import { canonicalJson } from 'stitchkit/primitives';
import { runNativeCommand } from 'stitchkit/process';
import { verifyCommandLifecycle } from './command-lifecycle.mjs';
import { verifySettlementDiagnostics } from './command-settlement-diagnostics.mjs';

const root = await mkdtemp(join(tmpdir(), 'packed-native-primitives-'));
try {
  const value = {
    2: 2,
    10: 10,
    '\uE000': 'bmp',
    '\u{10000}': 'pair',
    optional: undefined,
    nested: [true, null],
  };
  const expected = '{"10":10,"2":2,"nested":[true,null],"𐀀":"pair","":"bmp"}';
  assert.equal(canonicalJson(value), expected);
  for (const invalid of [undefined, [undefined], Array(1), NaN, new Date()])
    assert.throws(() => canonicalJson(invalid), TypeError);
  const file = join(root, 'receipt');
  await writeFileAtomic(file, expected, {
    replace: false,
    durability: 'directory',
    mode: 0o640,
  });
  await assert.rejects(writeFileAtomic(file, 'wrong', { replace: false }), { code: 'EEXIST' });
  writeFileAtomicSync(join(root, 'sync'), expected, { durability: 'directory' });
  const files = await createManagedFileBoundary({ root });
  const source = await files.read('receipt', {
    rejectSymlinks: true,
    singleLink: true,
    stable: true,
    observe: true,
  });
  assert.equal(new TextDecoder().decode(source.bytes), expected);
  assert.equal(source.observation.nlink, 1);
  await symlink('receipt', join(root, 'link'));
  await assert.rejects(files.read('link', { rejectSymlinks: true }), {
    code: 'FILE_UNSAFE_LINK',
  });
  const output = await runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'process.stdout.write(Buffer.from([255,0,97]))'],
    capture: true,
    maxOutputBytes: 3,
    timeoutMs: 2000,
  });
  assert.deepEqual(Array.from(output.stdout), [255, 0, 97]);
  assert.equal(await readFile(file, 'utf8'), expected);
  const channels = { stdout: [], stderr: [] };
  const drained = await runNativeCommand({
    executable: process.execPath,
    args: [
      '-e',
      'for(let i=0;i<32;i++){process.stdout.write(Buffer.alloc(65536,i));process.stderr.write(Buffer.alloc(65536,255-i));}',
    ],
    signal: new AbortController().signal,
    onOutput: (bytes, channel) => {
      channels[channel].push(bytes);
    },
  });
  for (const channel of ['stdout', 'stderr']) {
    const expected = Buffer.concat(
      Array.from({ length: 32 }, (_, i) =>
        Buffer.alloc(65536, channel === 'stdout' ? i : 255 - i),
      ),
    );
    assert.deepEqual(Buffer.concat(channels[channel]), expected);
    assert.equal(drained[channel].length, 0, 'streaming owner retains no capture');
  }
  await verifyCommandLifecycle(root);
  await verifySettlementDiagnostics(root);
  const door = createServer((_request, response) => response.end('door'));
  const socket = join(root, 'd.sock');
  const listening = new Promise((resolve) => door.once('listening', resolve));
  bindUnixSocket({ path: socket, mode: 0o600 }, (path) => door.listen(path));
  await listening;
  assert.equal((await stat(socket)).mode & 0o777, 0o600);
  await new Promise((resolve) => door.close(resolve));
  assert.throws(
    () => bindUnixSocket({ path: file, mode: 0o600 }, () => undefined),
    /already exists/,
  );
  console.log('packed native primitives: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
