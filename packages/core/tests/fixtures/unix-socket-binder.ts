// Binds every name of `STITCHKIT_TEST_NAMES` (a JSON array) in order, in the current
// directory. In a name, `{inode}` stands for the inode of the socket bound first, and
// `{node}` for `ino:<ino> dev:<major>/<minor>` of the path in `STITCHKIT_TEST_VICTIM`. A name
// with a `/` gets its directory first, and one that starts with `@` is abstract (an
// environment cannot carry the NUL byte the kernel spells it with). Says `ready` and waits.
import { mkdirSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

function socketInodes(): Set<string> {
  const inodes = new Set<string>();
  for (const fd of readdirSync('/proc/self/fd')) {
    let link = '';
    try {
      link = readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      continue;
    }
    if (link.startsWith('socket:[')) inodes.add(link.slice(8, -1));
  }
  return inodes;
}

function listen(name: string): Promise<void> {
  const address = name.startsWith('@') ? `\0${name.slice(1)}` : name;
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(address, resolve);
  });
}

const names: string[] = JSON.parse(process.env.STITCHKIT_TEST_NAMES ?? '[]');
const victim = process.env.STITCHKIT_TEST_VICTIM;
let node = '';
if (victim) {
  const info = statSync(victim, { bigint: true });
  node = `ino:${info.ino} dev:${info.dev >> 20n}/${info.dev & 0xfffffn}`;
}
const [first, ...rest] = names;
if (first === undefined) throw new Error('Expected at least one name');
const before = socketInodes();
await listen(first);
const inode = [...socketInodes()].find((entry) => !before.has(entry)) ?? '';
for (const template of rest) {
  const name = template.replaceAll('{inode}', inode).replaceAll('{node}', node);
  if (name.includes('/')) mkdirSync(dirname(name), { recursive: true });
  await listen(name);
}
process.stdout.write('ready\n');
// Held until the test kills it: the sockets live as long as this process.
setInterval(() => undefined, 60_000);
