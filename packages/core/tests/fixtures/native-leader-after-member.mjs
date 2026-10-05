// The leader starts a member that shares its pipes and exits as soon as the member has recorded its pid.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [pidFile] = process.argv.slice(2);
if (!pidFile) throw new Error('Expected a pid file');
const member = fileURLToPath(new URL('./native-pid-member.mjs', import.meta.url));
spawn(process.execPath, [member, pidFile], { stdio: ['ignore', 'inherit', 'inherit'] });
const watch = setInterval(() => {
  if (!existsSync(pidFile)) return;
  clearInterval(watch);
  process.exit(0);
}, 5);
