// A group member with no pipes to the command: it records its pid as JSON and lives until it is stopped.
import { renameSync, writeFileSync } from 'node:fs';

const [marker] = process.argv.slice(2);
if (!marker) throw new Error('Expected a marker file');
// Published by rename so a reader never sees a partial file.
writeFileSync(`${marker}.tmp`, JSON.stringify({ pid: process.pid }));
renameSync(`${marker}.tmp`, marker);
setInterval(() => undefined, 20);
