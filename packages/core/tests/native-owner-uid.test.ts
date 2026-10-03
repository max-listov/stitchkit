import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  installedConsumerProofs,
  runInstalledConsumerProofs,
} from '../scripts/consumer-lane/installed-proofs';

const capable = process.platform === 'linux' && process.getuid?.() === 0;
const helper = new URL(
  '../scripts/consumer-lane/fixtures/node/src/native-owner-uid.mjs',
  import.meta.url,
).href;
const files = new URL('../src/entrypoints/files.ts', import.meta.url).href;

function fixture(code: string, executable = process.execPath) {
  const result = spawnSync(executable, ['--eval', code], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

test.skipIf(!capable)(
  'native mixed UID validates Node from PATH, outsider EACCES and SIGKILL reclaim',
  () => {
    const output = fixture(
      `import{verifySharedUID}from${JSON.stringify(helper)};await verifySharedUID(${JSON.stringify(files)});console.log('native mixed UID: ok');`,
    );
    expect(output.trim()).toBe('native mixed UID: ok');
  },
);

test.skipIf(!capable)(
  'a Bun parent selects actual Node outside /usr/bin and refuses Bun disguised as node',
  () => {
    const output = fixture(`
    import assert from 'node:assert/strict';
    import{execFileSync}from'node:child_process';
    import{mkdtemp,copyFile,chmod,symlink,rm}from'node:fs/promises';
    import{tmpdir}from'node:os';import{join}from'node:path';
    import{verifySharedUID}from${JSON.stringify(helper)};
    assert.ok(process.versions.bun);
    const node=execFileSync('node',['-e','if(process.versions.bun)throw Error("not Node");console.log(process.execPath)'],{encoding:'utf8',timeout:3000}).trim();
    const root=await mkdtemp(join(tmpdir(),'uid-node-path-'));
    const selected=join(root,'node');
    const previous=process.env.PATH;
    try {
      await copyFile(node,selected);await chmod(selected,0o755);
      process.env.PATH=root+':'+previous;
      let resolved;
      await verifySharedUID(${JSON.stringify(files)},{onResolvedNode(value){resolved=value}});
      assert.equal(resolved,selected);
      assert.ok(process.versions.bun);
      await rm(selected);await symlink(process.execPath,selected);
      await assert.rejects(verifySharedUID(${JSON.stringify(files)}),(cause)=>String(cause.stderr).includes('Expected Node, received Bun'));
    } finally {process.env.PATH=previous;await rm(root,{recursive:true,force:true})}
    console.log('validated Node PATH controls: ok');
  `);
    expect(output.trim()).toBe('validated Node PATH controls: ok');
  },
);

test.skipIf(!capable)(
  'UID holder readiness and post-acquisition assertion failures kill and reap their exact child',
  () => {
    const output = fixture(`
    import assert from 'node:assert/strict';
    import{verifySharedUID}from${JSON.stringify(helper)};
    for(const readiness of [false,true]) {
      let pid;
      const refusal=new Error('assertion control');
      await assert.rejects(verifySharedUID(${JSON.stringify(files)},{
        ...(readiness?{holderCode:'setInterval(()=>{},20)'}:{}),
        onHolder(value){pid=value},afterHeld(){throw refusal},
      }), readiness?/Holder did not acquire/:(error)=>error===refusal);
      assert.ok(pid>0);
      assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
    }
    console.log('UID owned holder controls: ok');
  `);
    expect(output.trim()).toBe('UID owned holder controls: ok');
  },
);

test('UID proof capability is separate from generic ownership and mandatory qualification cannot skip', async () => {
  const proof = installedConsumerProofs.find((entry) => entry.id === 'native-owner-uid');
  expect(proof?.marker).toBe('packed Linux mixed UID: ok');
  expect(proof?.capability).toBe('linux-root');
  const results: string[] = [];
  let invoked = 0;
  const input = {
    ids: ['native-owner-uid'],
    platform: 'linux' as const,
    uid: 1000,
    run: async () => {
      invoked++;
      return 'packed Linux mixed UID: ok';
    },
    verdict: (_proof: unknown, runtime: string, state: string) =>
      results.push(`${runtime}:${state}`),
  };
  await runInstalledConsumerProofs(input);
  expect(results).toEqual(['platform:not-applicable']);
  expect(invoked).toBe(0);
  await expect(
    runInstalledConsumerProofs({
      ...input,
      platform: 'darwin',
      uid: 0,
      requireCapabilities: true,
    }),
  ).rejects.toThrow('requires Linux UID0');
  expect(invoked).toBe(0);
  await expect(
    runInstalledConsumerProofs({ ...input, requireCapabilities: true }),
  ).rejects.toThrow('requires Linux UID0');
  expect(invoked).toBe(0);
  await expect(
    runInstalledConsumerProofs({
      ...input,
      uid: 0,
      run: async () => 'packed native owners: ok',
    }),
  ).rejects.toThrow('no exact success marker');
});
