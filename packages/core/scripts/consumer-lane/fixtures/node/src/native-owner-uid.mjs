import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeIdentity =
  "if(process.versions.bun)throw Error('Expected Node, received Bun');console.log(process.execPath)";

/** Resolve Node through PATH, then validate the same binary as the target UID. */
async function nodeForUID(root, control) {
  const original = execFileSync('node', ['-e', nodeIdentity], {
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 8192,
  }).trim();
  control.onResolvedNode?.(original);
  // A Node installed below a private home is not executable by another UID.
  const runtime = join(root, 'node-runtime');
  await copyFile(original, runtime);
  await chmod(runtime, 0o755);
  try {
    assert.equal(
      execFileSync(runtime, ['-e', nodeIdentity], {
        uid: 65534,
        gid: 0,
        cwd: root,
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 8192,
      }).trim(),
      runtime,
    );
  } catch (cause) {
    throw new Error('Resolved Node cannot execute as UID65534/GID0', { cause });
  }
  return runtime;
}

function ownedChild(runtime, code, options = {}) {
  const child = spawn(runtime, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  let stdout = '';
  let stderr = '';
  let failure;
  const ready = Promise.withResolvers();
  const closed = new Promise((resolve) =>
    child.once('close', (code) => resolve({ code, stdout, stderr })),
  );
  child.once('error', (error) => {
    failure = error;
    ready.reject(error);
  });
  child.stdout.on('data', (bytes) => {
    stdout = (stdout + bytes).slice(-8192);
    if (stdout.split(/\r?\n/).includes('held')) ready.resolve();
  });
  child.stderr.on('data', (bytes) => {
    stderr = (stderr + bytes).slice(-8192);
  });
  void closed.then(() =>
    ready.reject(failure ?? new Error(`Holder exited before readiness: ${stderr}`)),
  );
  void ready.promise.catch(() => undefined);
  const wait = async (promise, message) => {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message, { cause: failure })), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    child,
    ready: () => wait(ready.promise, 'Holder did not acquire within 3000ms'),
    result: async () => {
      const result = await wait(closed, 'UID reader did not close within 3000ms');
      if (failure) throw failure;
      return result;
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await wait(closed, 'Owned UID process did not close within 3000ms');
    },
  };
}

/** Real UID/GID permissions and crash recovery; unsupported callers fail explicitly. */
export async function verifySharedUID(specifier, control = {}) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0)
    throw new Error(
      'Mixed-UID proof requires Linux UID0; registry must report not-applicable',
    );
  const root = await mkdtemp(join(tmpdir(), 'packed-lock-uid-'));
  const lock = join(root, 'lock');
  const bundle = join(root, 'files.mjs');
  let holder;
  try {
    await chmod(root, 0o755);
    const runtime = await nodeForUID(root, control);
    const entry = join(root, 'entry.mjs');
    await writeFile(
      entry,
      `export{withExclusiveLock}from${JSON.stringify(fileURLToPath(import.meta.resolve(specifier)))};`,
    );
    execFileSync(
      'bun',
      ['build', entry, '--target=node', '--outdir', root, '--entry-naming=files.mjs'],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        stdio: 'pipe',
      },
    );
    await chmod(bundle, 0o644);
    const reader = async (code, gid) => {
      const owned = ownedChild(runtime, code, { uid: 65534, gid, cwd: root });
      try {
        const { code: exit, stderr } = await owned.result();
        return { code: exit, stderr };
      } finally {
        await owned.stop();
      }
    };
    holder = ownedChild(
      runtime,
      control.holderCode ??
        `import{withExclusiveLock}from${JSON.stringify(bundle)};await withExclusiveLock(${JSON.stringify(lock)},async()=>{console.log('held');setInterval(()=>{},20);await new Promise(()=>{})},{mode:0o640});`,
    );
    control.onHolder?.(holder.child.pid);
    await holder.ready();
    await control.afterHeld?.();
    const read = `import{readFileSync}from'node:fs';JSON.parse(readFileSync(${JSON.stringify(lock)},'utf8'));`;
    assert.equal((await reader(read, 0)).code, 0);
    const outsider = await reader(read, 65534);
    assert.notEqual(outsider.code, 0);
    assert.match(outsider.stderr, /EACCES/);
    await chmod(root, 0o770);
    await holder.stop();
    const reclaim = await reader(
      `import{withExclusiveLock}from${JSON.stringify(bundle)};await withExclusiveLock(${JSON.stringify(lock)},l=>{if(!l.reclaimed)throw Error('not reclaimed')},{mode:0o640,ownerlessGraceMs:null,timeoutMs:300});`,
      0,
    );
    assert.deepEqual(reclaim, { code: 0, stderr: '' });
  } finally {
    try {
      await holder?.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await verifySharedUID('stitchkit/files');
  console.log('packed Linux mixed UID: ok');
}
