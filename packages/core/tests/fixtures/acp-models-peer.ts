/**
 * An ACP agent with two models that describes `thought_level` only for the active one, keeps its
 * sessions in `<root>/sessions.json`, and declares image input when `mode` is `images`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root = '.', mode = 'text'] = process.argv.slice(2);
const store = join(root, 'sessions.json');
const levels: Record<string, string[]> = { 'm-a': ['low', 'high'], 'm-b': ['off', 'max'] };
let active = 'm-a';
const write = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const sessions = (): string[] => JSON.parse(readFileSync(store, 'utf8'));
const options = () => [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: active,
    options: Object.keys(levels).map((value) => ({ value, name: value })),
  },
  {
    id: 'thought_level',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: levels[active]?.[0],
    options: (levels[active] ?? []).map((value) => ({ value, name: value })),
  },
];

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  if (message.method === 'initialize')
    write({
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: { close: {}, delete: {} },
          promptCapabilities: { image: mode === 'images' },
        },
      },
    });
  else if (message.method === 'session/new') {
    const id = `s-${sessions().length + 1}`;
    writeFileSync(store, JSON.stringify([...sessions(), id]));
    write({ id: message.id, result: { sessionId: id, configOptions: options() } });
  } else if (message.method === 'session/set_config_option') {
    if (message.params?.configId === 'model') active = String(message.params.value);
    write({ id: message.id, result: { configOptions: options() } });
  } else if (message.method === 'session/delete') {
    writeFileSync(
      store,
      JSON.stringify(sessions().filter((id) => id !== message.params?.sessionId)),
    );
    write({ id: message.id, result: {} });
  } else write({ id: message.id, result: {} });
}
