// The leader exits at once; its descendant keeps the command pipes open and says so once the leader is reaped.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [role, leaderPid] = process.argv.slice(2);
if (role === 'holder') {
  const gone = () => {
    try {
      process.kill(Number(leaderPid), 0);
      return false;
    } catch {
      return true;
    }
  };
  const watch = setInterval(() => {
    if (!gone()) return;
    clearInterval(watch);
    process.stdout.write('leader gone');
    setInterval(() => undefined, 1000);
  }, 5);
} else {
  const self = fileURLToPath(import.meta.url);
  spawn(process.execPath, [self, 'holder', String(process.pid)], { stdio: ['ignore', 1, 2] });
  process.exit(0);
}
