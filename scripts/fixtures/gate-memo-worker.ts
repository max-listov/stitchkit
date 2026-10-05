// One of several processes writing the green memo at once. It reports `ready`, then waits for stdin to close.
import { writeGreenGate } from '../gate-memo';

const [root, id] = Bun.argv.slice(2);
if (!root || !id) throw new Error('Expected a scratch directory and a worker id');
console.log('ready');
await Bun.stdin.text();
const record = { tree: id, toolchain: 'bun:test', at: 'now', commit: '(no commit)' };
await writeGreenGate(`gate-${id}`, record, `${root}/memo.json`);
await writeGreenGate('shared', record, `${root}/memo.json`);
