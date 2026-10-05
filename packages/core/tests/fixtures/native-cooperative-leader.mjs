// The leader of a command with one group member whose stdio is detached from the command pipes.
// It publishes the member's pid, records the signals it receives itself, and then, by `mode`:
//   exit-on-signal  exits 0 on the first SIGTERM or SIGINT (a cooperative stop);
//   write-on-signal writes 1 MiB to stdout first, records `flushed` once it is written, then exits;
//   ignore-signal   survives them (a stop that needs the grace to end);
//   exit-when-ready exits 0 at once, leaving the member behind.
import { spawn } from 'node:child_process';
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [dir, mode] = process.argv.slice(2);
const modes = ['exit-on-signal', 'write-on-signal', 'ignore-signal', 'exit-when-ready'];
if (!dir || !modes.includes(mode ?? '')) throw new Error('Expected a directory and a mode');
const recorder = fileURLToPath(new URL('./native-signal-recorder.mjs', import.meta.url));
const member = spawn(process.execPath, [recorder, join(dir, 'member-signals')], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    appendFileSync(join(dir, 'leader-signals'), `${signal}\n`);
    if (mode === 'exit-on-signal') process.exit(0);
    if (mode === 'write-on-signal')
      process.stdout.write(Buffer.alloc(1024 * 1024), (error) => {
        if (error) throw error;
        appendFileSync(join(dir, 'leader-signals'), 'flushed\n');
        process.exit(0);
      });
  });
member.stdout.once('data', () => {
  // Published by rename so a reader never sees an empty file.
  writeFileSync(join(dir, 'member-pid.tmp'), String(member.pid));
  renameSync(join(dir, 'member-pid.tmp'), join(dir, 'member-pid'));
  if (mode === 'exit-when-ready') process.exit(0);
  process.stdout.write('ready');
});
setInterval(() => undefined, 1000);
