import { writeFileSync } from 'node:fs';
import { createAgentCodingTools } from '../../src/entrypoints/agent-runtime/coding-tools';
import { mountAgent } from '../../src/entrypoints/tools/agent';

const [, , root, pidFile] = process.argv;
if (!root || !pidFile) throw new Error('Missing probe arguments');
writeFileSync(pidFile, String(process.pid));
if (process.getuid?.() === 0) {
  process.setgid?.(65534);
  process.setuid?.(65534);
}
const tools = mountAgent([], {
  runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
});
const execute = tools.search_files?.execute;
if (!execute) throw new Error('Missing search_files');
console.log(
  JSON.stringify(
    await execute(
      { query: 'needle' },
      { toolCallId: 'permissions', messages: [], context: undefined },
    ),
  ),
);
