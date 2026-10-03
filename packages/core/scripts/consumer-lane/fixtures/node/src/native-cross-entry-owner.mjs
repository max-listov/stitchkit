import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentCodingTools } from 'stitchkit/agent-runtime/coding-tools';
import { createBubblewrapSandboxBackend } from 'stitchkit/agent-runtime/sandbox';
import { observeProcessInstance, probeProcessOwner } from 'stitchkit/process';
import { mountAgent } from 'stitchkit/tools';

assert.equal(
  process.platform,
  'linux',
  'Cross-entry backend transport qualification requires Linux',
);
const root = await mkdtemp(join(tmpdir(), 'packed-cross-entry-owner-'));
const marker = join(root, 'member');
let handle;
let member;
let identity;
async function memberOwner() {
  try {
    return JSON.parse(await readFile(marker, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return undefined;
    throw cause;
  }
}
try {
  // Exercise the built-in host launcher across public bundles. This fixture
  // intentionally forwards the command; it makes no claim of sandbox isolation.
  const wrapper = join(root, 'transport');
  await writeFile(
    wrapper,
    '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
  );
  await chmod(wrapper, 0o755);
  const backend = await createBubblewrapSandboxBackend({
    stateDirectory: join(root, 'state'),
    executable: wrapper,
    onBrokerError(cause) {
      throw cause;
    },
  });
  const warmed = await backend.prewarm({ template: 'empty' });
  handle = await backend.create({ template: warmed.templateKey, network: 'deny-all' });
  const helper = `(async()=>{const{observeProcessInstance}=await import(${JSON.stringify(import.meta.resolve('stitchkit/process'))});const observed=await observeProcessInstance(process.pid);if(observed.state!=='observed')throw observed.cause;require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,identity:observed.instance}));setInterval(()=>{},20)})()`;
  const leader = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(helper)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(marker)})){process.stdout.write('spawned');process.exit(0)}},5)`;
  let groupAfterLeader;
  let leaderReaped;
  let memberGroup;
  let exitEvidenceFailure;
  const adapter = {
    ...handle.coding.adapter,
    spawn(command) {
      const child = handle.coding.adapter.spawn(command);
      child.on('exit', () => {
        try {
          ({ pid: member, identity } = JSON.parse(readFileSync(marker, 'utf8')));
          leaderReaped = !existsSync(`/proc/${child.pid}`);
          process.kill(-child.pid, 0);
          groupAfterLeader = true;
          const record = readFileSync(`/proc/${member}/stat`, 'utf8');
          memberGroup = Number(record.slice(record.lastIndexOf(')') + 2).split(' ')[2]);
          assert.equal(memberGroup, child.pid);
        } catch (cause) {
          exitEvidenceFailure = cause;
        }
      });
      return child;
    },
  };
  const tools = mountAgent([], {
    runtimeTools: createAgentCodingTools({
      root: handle.coding.root,
      authorize: () => true,
      executables: { test: process.execPath },
      sandbox: { adapter, required: [] },
      limits: {
        shellTimeoutMs: 2000,
        shellTerminationGraceMs: 100,
        maxShellOutputBytes: 1024,
      },
    }),
  });
  const execute = tools.run_command?.execute;
  assert.ok(execute);
  const result = await execute(
    { executable: 'test', args: ['-e', leader] },
    {
      toolCallId: 'packed-cross-entry-owner',
      messages: [],
      context: undefined,
    },
  );
  ({ pid: member, identity } = JSON.parse(await readFile(marker, 'utf8')));
  assert.equal(
    result.outcome,
    'exited',
    'Shared private group ownership must survive packed entrypoint crossing',
  );
  assert.equal(result.stdout, 'spawned');
  assert.equal(exitEvidenceFailure, undefined);
  assert.equal(leaderReaped, true);
  assert.equal(groupAfterLeader, true);
  const observed = await observeProcessInstance(member);
  if (observed.state === 'observed') {
    // Linux zombies have finished executing and hold no inherited pipe handles.
    const stat = await readFile(`/proc/${member}/stat`, 'utf8');
    assert.match(stat.slice(stat.lastIndexOf(')') + 2), /^Z /);
  } else {
    assert.equal(observed.cause?.code, 'ENOENT');
  }
  await handle.stop();
  console.log('packed cross-entry native ownership: ok');
} finally {
  try {
    if (!member) {
      const owner = await memberOwner();
      if (owner) ({ pid: member, identity } = owner);
    }
    if (member && identity && (await probeProcessOwner(member, identity)).liveness === 'alive')
      process.kill(member, 'SIGKILL');
    await handle?.delete();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
