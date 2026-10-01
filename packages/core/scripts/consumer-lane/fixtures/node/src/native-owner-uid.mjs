import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Real UID/GID access and crash recovery, never a fixture substitute for kernel permissions. */
export async function verifySharedUID(specifier) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return;
  const root = await mkdtemp(join(tmpdir(), 'packed-lock-uid-'));
  const lock = join(root, 'lock');
  const bundle = join(root, 'files.mjs');
  let holder;
  try {
    const entry = join(root, 'entry.mjs');
    await writeFile(
      entry,
      `export{withExclusiveLock}from${JSON.stringify(fileURLToPath(import.meta.resolve(specifier)))};`,
    );
    execFileSync('bun', ['build', entry, '--target=node', '--outfile', bundle], {
      timeout: 30_000,
      stdio: 'pipe',
    });
    await chmod(bundle, 0o644);
    await chmod(root, 0o755);
    let runtime = process.execPath;
    if (runtime.includes('/root/')) {
      runtime = join(root, 'runtime');
      await copyFile(process.execPath, runtime);
      await chmod(runtime, 0o755);
    }
    const child = (code, gid) =>
      new Promise((resolve, reject) => {
        const reader = spawn(runtime, ['--input-type=module', '-e', code], {
          uid: 65534,
          gid,
          cwd: root,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        reader.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        reader.once('error', reject);
        reader.once('close', (code) => resolve({ code, stderr }));
      });
    holder = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import{withExclusiveLock}from${JSON.stringify(bundle)};await withExclusiveLock(${JSON.stringify(lock)},async()=>{console.log('held');setInterval(()=>{},20);await new Promise(()=>{})},{mode:0o640});`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('holder did not acquire')), 3000);
      holder.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      holder.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const read = `import{readFileSync}from'node:fs';JSON.parse(readFileSync(${JSON.stringify(lock)},'utf8'));`;
    assert.equal((await child(read, 0)).code, 0);
    const outsider = await child(read, 65534);
    assert.notEqual(outsider.code, 0);
    assert.match(outsider.stderr, /EACCES/);
    await chmod(root, 0o770);
    const closed = new Promise((resolve) => holder.once('close', resolve));
    holder.kill('SIGKILL');
    await closed;
    const reclaim = await child(
      `import{withExclusiveLock}from${JSON.stringify(bundle)};await withExclusiveLock(${JSON.stringify(lock)},l=>{if(!l.reclaimed)throw Error('not reclaimed')},{mode:0o640,ownerlessGraceMs:null,timeoutMs:300});`,
      0,
    );
    assert.deepEqual(reclaim, { code: 0, stderr: '' });
  } finally {
    holder?.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}
