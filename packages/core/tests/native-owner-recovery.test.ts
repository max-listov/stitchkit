import { expect, test } from 'bun:test';
import { join } from 'node:path';

async function isolated(code: string) {
  const child = Bun.spawn([process.execPath, '-e', code], { stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw new Error(stderr);
  return stdout;
}

test('a paused stale guard removal blocks competing recovery through a separately owned guard', async () => {
  const entry = join(import.meta.dir, '../src/entrypoints/files.ts');
  const code = `
    import {mock} from 'bun:test';
    const fs=await import('node:fs/promises');
    const root=await fs.mkdtemp('/tmp/stitchkit-guard-pause-');
    const path=root+'/lock', guard=path+'.reclaim', unlink=fs.unlink;
    let paused=false, entered=false, unblock, announce;
    const held=new Promise(r=>unblock=r), waiting=new Promise(r=>announce=r);
    mock.module('node:fs/promises',()=>({...fs,unlink:async(name)=>{
      if(name===guard&&!paused){paused=true;announce();await held}return unlink(name)
    }}));
    const {withExclusiveLock}=await import(${JSON.stringify(entry)});
    let first,second;
    try{
      const owner=await withExclusiveLock(root+'/known',l=>l.owner,{machineIdentity:'fixture'});
      if(!owner.process)throw Error('native lifetime missing');
      const stale=JSON.stringify({...owner,process:{...owner.process,bootId:'previous-boot'}});
      await fs.writeFile(path,stale);await fs.writeFile(guard,stale);
      first=withExclusiveLock(path,()=>{}, {machineIdentity:'fixture',timeoutMs:2000});
      await waiting;
      second=withExclusiveLock(path,()=>{entered=true},{machineIdentity:'fixture',timeoutMs:2000});
      await Bun.sleep(50);
      if(entered)throw Error('competing writer bypassed paused guard recovery');
      unblock();await Promise.all([first,second]);
      if(!entered)throw Error('second writer never acquired');
      console.log('serialized guard recovery: ok');
    }finally{unblock();await Promise.allSettled([first,second]);await fs.rm(root,{recursive:true,force:true})}
  `;
  expect(await isolated(code)).toContain('serialized guard recovery: ok');
});

test('Darwin transient group EPERM settles only on a real signal or absence; persistent denial stays red', async () => {
  const entry = join(import.meta.dir, '../src/process/group.ts');
  const code = `
    Object.defineProperty(process,'platform',{value:'darwin'});
    const {stopCommandGroup}=await import(${JSON.stringify(entry)});
    const denied=Object.assign(new Error('permission denied'),{code:'EPERM'});
    const gone=Object.assign(new Error('group reaped'),{code:'ESRCH'});
    let probes=0,kills=0;
    process.kill=(_pid,signal)=>{
      if(signal==='SIGTERM')return true;
      if(signal===0){probes++;throw denied}
      if(signal==='SIGKILL'){if(++kills<3)throw denied;throw gone}
      throw Error('unexpected signal');
    };
    await stopCommandGroup(4242,20,100);
    if(!probes||kills!==3)throw Error('transient denial was suppressed');
    process.kill=()=>{throw denied};
    const began=performance.now();
    try{await stopCommandGroup(4242,0,20);throw Error('must refuse')}catch(error){if(error!==denied)throw error}
    if(performance.now()-began<15)throw Error('denial did not wait within declared budget');
    console.log('bounded EPERM controls: ok');
  `;
  expect(await isolated(code)).toContain('bounded EPERM controls: ok');
});
