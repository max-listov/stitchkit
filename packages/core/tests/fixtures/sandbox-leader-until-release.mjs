// The leader starts a pipe-free member and exits once the release file appears.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [marker, release] = process.argv.slice(2);
if (!marker || !release) throw new Error('Expected marker and release files');
const member = fileURLToPath(new URL('./sandbox-pipe-free-member.mjs', import.meta.url));
spawn(process.execPath, [member, marker], { stdio: 'ignore' });
setInterval(() => {
  if (existsSync(release)) process.exit(0);
}, 5);
