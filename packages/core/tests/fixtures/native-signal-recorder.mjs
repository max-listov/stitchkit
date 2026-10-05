// A group member that records every SIGTERM or SIGINT it receives, survives them, and says `ready`
// on its own stdout once its handlers are installed. Its stdio is not the command's.
import { appendFileSync } from 'node:fs';

const [markerFile] = process.argv.slice(2);
if (!markerFile) throw new Error('Expected a marker file');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => appendFileSync(markerFile, `${signal}\n`));
process.stdout.write('ready');
setInterval(() => undefined, 1000);
