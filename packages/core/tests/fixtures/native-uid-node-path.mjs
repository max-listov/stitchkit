// A Bun parent selects the actual Node on PATH and refuses Bun disguised as `node`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [helper, files] = process.argv.slice(2);
const { verifySharedUID } = await import(helper);
assert.ok(process.versions.bun);
const node = execFileSync(
  'node',
  ['-e', 'if(process.versions.bun)throw Error("not Node");console.log(process.execPath)'],
  { encoding: 'utf8', timeout: 3000 },
).trim();
const root = await mkdtemp(join(tmpdir(), 'uid-node-path-'));
const selected = join(root, 'node');
const previous = process.env.PATH;
try {
  await copyFile(node, selected);
  await chmod(selected, 0o755);
  process.env.PATH = `${root}:${previous}`;
  let resolved;
  await verifySharedUID(files, {
    onResolvedNode(value) {
      resolved = value;
    },
  });
  assert.equal(resolved, selected);
  assert.ok(process.versions.bun);
  await rm(selected);
  await symlink(process.execPath, selected);
  await assert.rejects(verifySharedUID(files), (cause) =>
    String(cause.stderr).includes('Expected Node, received Bun'),
  );
} finally {
  process.env.PATH = previous;
  await rm(root, { recursive: true, force: true });
}
console.log('validated Node PATH controls: ok');
