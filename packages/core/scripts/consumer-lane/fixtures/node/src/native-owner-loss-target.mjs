import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [phase, root] = process.argv.slice(2);
if (!phase || !root) throw new Error('phase and root are required');

writeFileSync(join(root, 'target.pid'), String(process.pid));
const member = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
  stdio: 'ignore',
});
if (member.pid === undefined) throw new Error('member started without a pid');
writeFileSync(join(root, 'member.pid'), String(member.pid));

if (phase !== 'before-listen') {
  writeFileSync(join(root, 'listen'), 'ready');
  writeFileSync(join(root, 'initialized'), 'ready');
  if (phase === 'hanging-rpc') writeFileSync(join(root, 'rpc'), 'pending');
}

setInterval(() => {
  // Keep the target and its descendant observable until the owner-loss control acts.
}, 1000);
