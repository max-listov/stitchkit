// Leader of a command whose descendant ignores SIGTERM. It reports `ready` once the descendant beats.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [counterFile, pidFile] = process.argv.slice(2);
if (!counterFile || !pidFile) throw new Error('Expected counter and pid files');
const helper = fileURLToPath(new URL('./native-term-resistant-counter.mjs', import.meta.url));
const descendant = spawn(process.execPath, [helper, counterFile], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
descendant.stdout.once('data', () => {
  writeFileSync(pidFile, String(descendant.pid));
  process.stdout.write('ready');
});
setInterval(() => undefined, 1000);
