/**
 * An ACP agent that runs one prompt at a time: a second `session/prompt` while the first runs is
 * refused with a JSON-RPC error. Modes: `hold` ends the first prompt once `<root>/release` appears;
 * `burst` ends it in the same write as the refusal, so both arrive together.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root = '.', mode = 'hold'] = process.argv.slice(2);
const write = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const chunk = (text: string) => ({
  method: 'session/update',
  params: {
    sessionId: 's1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  },
});
let first: unknown;

function endFirst(): void {
  write(chunk('first-done'));
  write({ id: first, result: { stopReason: 'end_turn' } });
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    write({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (message.method === 'session/new')
    write({ id: message.id, result: { sessionId: 's1' } });
  else if (message.method === 'session/prompt') {
    if (first === undefined) {
      first = message.id;
      write(chunk('first '));
      continue;
    }
    write({ id: message.id, error: { code: -32603, message: 'a prompt is already running' } });
    if (mode === 'burst') endFirst();
    else {
      const poll = setInterval(() => {
        if (!existsSync(join(root, 'release'))) return;
        clearInterval(poll);
        endFirst();
      }, 10);
    }
  }
}
