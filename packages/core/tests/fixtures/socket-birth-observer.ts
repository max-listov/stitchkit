// Watches one path from a separate process and prints the permission bits of
// the first thing that appears there: the rights a socket is born with, not
// the rights it ends with. Polls without pauses, bounded by its own deadline.
import { lstatSync } from 'node:fs';

const path = process.argv[2];
if (!path) throw new Error('usage: socket-birth-observer.ts <path>');
const deadline = Date.now() + 10_000;
process.stdout.write('ready\n');
while (Date.now() < deadline) {
  const stats = lstatSync(path, { throwIfNoEntry: false });
  if (stats !== undefined) {
    process.stdout.write(`${(stats.mode & 0o777).toString(8)}\n`);
    process.exit(0);
  }
}
process.stdout.write('timeout\n');
process.exit(1);
