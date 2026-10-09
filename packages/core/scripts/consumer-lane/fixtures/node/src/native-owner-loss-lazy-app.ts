import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapNativeCommandOwnerLoss } from 'stitchkit/process/owner-loss';

const TARGET_SOURCE = `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const phase = process.argv[1];
const root = process.argv[2];
if (!phase || !root) throw new Error('target phase and root are required');
writeFileSync(join(root, 'target.pid'), String(process.pid));
const member = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
if (member.pid === undefined) throw new Error('target descendant started without a pid');
writeFileSync(join(root, 'member.pid'), String(member.pid));
if (phase !== 'before-listen') {
  writeFileSync(join(root, 'listen'), 'ready');
  writeFileSync(join(root, 'initialized'), 'ready');
  if (phase === 'hanging-rpc') writeFileSync(join(root, 'rpc'), 'pending');
}
setInterval(() => {}, 1000);
`;

async function main(): Promise<void> {
  const [command, mode, phase, root] = process.argv.slice(2);
  const { runNativeCommand } = await import('stitchkit/process');
  if (command === 'probe') {
    const result = await runNativeCommand({
      executable: '/bin/echo',
      args: ['lazy-owner-loss'],
      ownerLoss: 'terminate',
      timeoutMs: 2000,
      capture: true,
      maxOutputBytes: 4096,
    });
    if (
      result.exitCode !== 0 ||
      new TextDecoder().decode(result.stdout).trim() !== 'lazy-owner-loss'
    )
      throw new Error('lazy owner-loss probe returned the wrong result');
    console.log('lazy owner-loss probe: ok');
    return;
  }
  if (
    command !== 'owner' ||
    (mode !== 'guarded' && mode !== 'unguarded') ||
    phase === undefined ||
    root === undefined
  ) {
    console.error('unknown application command');
    process.exitCode = 64;
    return;
  }
  await runNativeCommand({
    executable: process.execPath,
    args: ['-e', TARGET_SOURCE, phase, root],
    timeoutMs: 30_000,
    ...(mode === 'guarded' && { ownerLoss: 'terminate' as const }),
    onLeaderStarted: ({ pid }) => writeFileSync(join(root, 'leader.pid'), String(pid)),
  });
}

// The bootstrap owns only its private guard invocation. Every application invocation keeps the
// existing lazy dispatcher: the full process runner is imported only inside `main`.
if (!bootstrapNativeCommandOwnerLoss()) await main();
