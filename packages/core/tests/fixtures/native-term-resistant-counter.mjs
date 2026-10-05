// Ignores SIGTERM and records a heartbeat, so a test can tell a live descendant from a stopped one.
import { writeFileSync } from 'node:fs';

const [counterFile] = process.argv.slice(2);
if (!counterFile) throw new Error('Expected a counter file');
process.on('SIGTERM', () => undefined);
let beats = 0;
const beat = () => writeFileSync(counterFile, String(++beats));
beat();
process.stdout.write('started');
setInterval(beat, 5);
