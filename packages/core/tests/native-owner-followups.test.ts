import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withExclusiveLock } from '../src/entrypoints/files';
import {
  observeProcessInstance,
  probeProcessOwner,
  runNativeCommand,
} from '../src/entrypoints/process';
import {
  observeProcessInstanceAt,
  probeProcessOwnerWith,
} from '../src/internal/process-instance';

test('exact lock mode survives restrictive umask and null refuses ownerless locks and guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-owner-mode-'));
  const old = process.umask(0o077);
  try {
    for (const mode of [0o640, 0o600]) {
      await withExclusiveLock(
        join(root, 'lock'),
        async () => {
          expect((await stat(join(root, 'lock'))).mode & 0o777).toBe(mode);
        },
        { mode },
      );
    }
    for (const suffix of ['', '.reclaim']) {
      await writeFile(join(root, `lock${suffix}`), 'malformed');
      await utimes(join(root, `lock${suffix}`), 1, 1);
    }
    await expect(
      withExclusiveLock(
        join(root, 'lock'),
        () => {
          throw new Error('stolen');
        },
        {
          timeoutMs: 20,
          ownerlessGraceMs: null,
        },
      ),
    ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
    expect(await readFile(join(root, 'lock'), 'utf8')).toBe('malformed');
    expect(await readFile(join(root, 'lock.reclaim'), 'utf8')).toBe('malformed');
    const owner = await withExclusiveLock(join(root, 'known'), (held) => held.owner);
    if (owner.process) {
      await writeFile(
        join(root, 'lock'),
        JSON.stringify({ ...owner, process: { ...owner.process, bootId: 'previous-boot' } }),
      );
      await expect(
        withExclusiveLock(
          join(root, 'lock'),
          () => {
            throw new Error('stolen guard');
          },
          { timeoutMs: 20, ownerlessGraceMs: null },
        ),
      ).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
      expect(await readFile(join(root, 'lock.reclaim'), 'utf8')).toBe('malformed');
      expect(
        await withExclusiveLock(join(root, 'lock'), (held) => held.reclaimed, {
          timeoutMs: 200,
          ownerlessGraceMs: 0,
        }),
      ).toBe(true);
    }
    await expect(
      withExclusiveLock(join(root, 'lock'), () => undefined, { mode: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
  } finally {
    process.umask(old);
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'darwin')(
  'public process evidence matches native lifetime and unavailable observations preserve cause',
  async () => {
    const observation = await observeProcessInstance(process.pid);
    expect(observation.state).toBe('observed');
    if (observation.state !== 'observed') throw observation.cause;
    expect(await probeProcessOwner(process.pid, observation.instance)).toEqual({
      liveness: 'alive',
      identity: 'matched',
    });
    expect(
      await probeProcessOwner(process.pid, { ...observation.instance, bootId: 'other-boot' }),
    ).toEqual({ liveness: 'gone', identity: 'different-boot' });
    expect(
      await probeProcessOwner(process.pid, { ...observation.instance, startId: '0' }),
    ).toEqual({ liveness: 'gone', identity: 'reused-pid' });
    const failure = await observeProcessInstanceAt(process.pid, '/nonexistent-stitchkit-proc');
    expect(failure.state).toBe('unavailable');
    if (failure.state === 'unavailable')
      expect(failure.cause).toMatchObject({ code: 'ENOENT' });
    const denied = Object.assign(new Error('fixture denied'), { code: 'EPERM' });
    const result = await probeProcessOwnerWith(process.pid, observation.instance, {
      read: async () => observation.instance,
      liveness: async () => 'alive',
      observe: async () => ({ state: 'unavailable', cause: denied }),
    });
    expect(result).toEqual({ liveness: 'not-probed', identity: 'unavailable', cause: denied });
    await expect(observeProcessInstance(-1)).rejects.toBeInstanceOf(Error);
  },
);

test('descriptor mode failure retains cause and leaves a replacement inode untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-mode-failure-'));
  const path = join(root, 'lock');
  const entry = join(import.meta.dir, '../src/entrypoints/files.ts');
  const code = `import{mock}from'bun:test';const fs=await import('node:fs/promises');const realOpen=fs.open;const path=${JSON.stringify(path)};const failure=new Error('descriptor mode failed');mock.module('node:fs/promises',()=>({...fs,open:async(...args)=>{const handle=await realOpen(...args);if(args[0]===path&&args[1]==='wx')handle.chmod=async()=>{await fs.rename(path,path+'.original');await fs.writeFile(path,'replacement');throw failure};return handle}}));const{withExclusiveLock}=await import(${JSON.stringify(entry)});try{await withExclusiveLock(path,()=>{throw Error('callback must not run')});throw Error('must fail')}catch(e){if(e!==failure)throw e}if(await fs.readFile(path,'utf8')!=='replacement')throw Error('replacement removed');if(await fs.readFile(path+'.original','utf8')!=='')throw Error('false owner published');console.log('descriptor failure: ok');`;
  try {
    const result = Bun.spawn([process.execPath, '-e', code], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exit = await result.exited;
    if (exit !== 0) throw new Error(await new Response(result.stderr).text());
    expect(exit).toBe(0);
    expect(await new Response(result.stdout).text()).toContain('descriptor failure: ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('observed leader exit settles external scope before inherited pipe drain; no hook reaches declared deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-leader-'));
  const pidFile = join(root, 'member');
  const helper = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},20);`;
  const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit']});const fs=require('node:fs');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);process.exit(0)}},5);`;
  let calls = 0;
  try {
    const result = await runNativeCommand({
      executable: process.execPath,
      args: ['-e', script],
      timeoutMs: 2000,
      onLeaderSettled: async (event) => {
        calls++;
        expect(event).toEqual({ kind: 'exit', exitCode: 0, signal: null });
        process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGTERM');
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toBe(1);
    await rm(pidFile);
    await expect(
      runNativeCommand({ executable: process.execPath, args: ['-e', script], timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: 'COMMAND_LIMIT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 5000);

test('leader settlement runs once for nonzero, unavailable, sink failure and abort, and retains failure causes', async () => {
  const cause = new Error('sink failed');
  for (const scenario of ['nonzero', 'missing', 'sink', 'abort']) {
    let calls = 0;
    const controller = new AbortController();
    const command = runNativeCommand({
      executable: scenario === 'missing' ? '/nonexistent-stitchkit-command' : process.execPath,
      args: [
        '-e',
        scenario === 'nonzero'
          ? 'process.exit(7)'
          : "process.stdout.write('x');setInterval(()=>{},20)",
      ],
      timeoutMs: 2000,
      signal: controller.signal,
      onOutput:
        scenario === 'sink'
          ? () => {
              throw cause;
            }
          : undefined,
      onLeaderSettled: () => {
        calls++;
      },
    });
    if (scenario === 'abort') setTimeout(() => controller.abort(cause), 30);
    if (scenario === 'nonzero') expect((await command).exitCode).toBe(7);
    else if (scenario === 'missing')
      await expect(command).rejects.toMatchObject({ code: 'COMMAND_UNAVAILABLE' });
    else await expect(command).rejects.toBe(cause);
    expect(calls).toBe(1);
  }
  const cleanup = new Error('settlement failed');
  await expect(
    runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'process.exit(7)'],
      timeoutMs: 2000,
      onLeaderSettled: () => {
        throw cleanup;
      },
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_CLEANUP',
    cause: { errors: [{ kind: 'exit', exitCode: 7 }, cleanup] },
  });
});

test('cleanup observes native leader and pipe closure when aggregate child close is unavailable', async () => {
  const entry = join(import.meta.dir, '../src/entrypoints/process.ts');
  const code = `import{ChildProcess}from'node:child_process';const emit=ChildProcess.prototype.emit;let suppressed=0;ChildProcess.prototype.emit=function(event,...args){if(event==='close'){suppressed++;return false}return emit.call(this,event,...args)};const{runNativeCommand}=await import(${JSON.stringify(entry)});try{await runNativeCommand({executable:process.execPath,args:['-e','setInterval(()=>{},20)'],timeoutMs:30,cleanupTimeoutMs:100});throw Error('must fail')}catch(error){if(error.code!=='COMMAND_LIMIT')throw error}if(!suppressed)throw Error('negative control did not suppress child close');console.log('individual handles released: ok');`;
  const child = Bun.spawn([process.execPath, '-e', code], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(stderr);
  expect(stdout).toContain('individual handles released: ok');
});

test('hanging leader settlement is cancellable and signal-only execution has no cleanup execution deadline', async () => {
  let calls = 0;
  const controller = new AbortController();
  const reason = new Error('caller stopped');
  const command = runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'process.exit(0)'],
    signal: controller.signal,
    cleanupTimeoutMs: 1000,
    onLeaderSettled: () => {
      calls++;
      controller.abort(reason);
      return new Promise(() => undefined);
    },
  });
  await expect(command).rejects.toBe(reason);
  expect(calls).toBe(1);
  const result = await runNativeCommand({
    executable: process.execPath,
    args: ['-e', 'setTimeout(()=>process.exit(0),100)'],
    signal: new AbortController().signal,
    cleanupTimeoutMs: 20,
    onLeaderSettled: () => undefined,
  });
  expect(result.exitCode).toBe(0);
});
