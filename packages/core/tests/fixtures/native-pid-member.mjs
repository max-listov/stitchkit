// A group member that records its pid and then lives until it is signalled.
import { renameSync, writeFileSync } from 'node:fs';

const [pidFile] = process.argv.slice(2);
if (!pidFile) throw new Error('Expected a pid file');
// Published by rename so a reader never sees an empty file.
writeFileSync(`${pidFile}.tmp`, String(process.pid));
renameSync(`${pidFile}.tmp`, pidFile);
setInterval(() => undefined, 20);
