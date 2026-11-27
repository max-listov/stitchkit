import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [root, mode] = process.argv.slice(2);
if (!root || !mode) throw new Error('Expected a scratch store and probe scenario');
const store = join(root, 'sessions.json');
writeFileSync(join(root, 'pid'), String(process.pid));

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  const sessions: string[] = JSON.parse(readFileSync(store, 'utf8'));
  appendFileSync(join(root, 'calls'), `${JSON.stringify([method, params?.sessionId])}\n`);
  const result = (payload: unknown) => console.log(JSON.stringify({ id, result: payload }));
  const refuse = () =>
    console.log(
      JSON.stringify({ id, error: { code: -32603, message: `provider refused ${method}` } }),
    );
  switch (method) {
    case 'initialize':
      result({
        protocolVersion: 1,
        agentCapabilities: {
          sessionCapabilities: mode === 'unsupported' ? {} : { close: {}, delete: {} },
        },
      });
      break;
    case 'session/new':
      writeFileSync(store, JSON.stringify([...sessions, 'probe-id']));
      result({
        sessionId: 'probe-id',
        configOptions: mode.startsWith('invalid-') ? 'invalid' : [],
      });
      break;
    case 'session/close':
      if (mode === 'hang-close' || mode === 'invalid-hang-close') break;
      if (mode === 'slow-close') {
        // Answers once the test released it: an abort can land while close is in flight.
        const poll = setInterval(() => {
          if (!existsSync(join(root, 'release-close'))) return;
          clearInterval(poll);
          result({});
        }, 10);
        break;
      }
      if (mode.includes('close')) refuse();
      else result({});
      break;
    case 'session/delete':
      if (mode === 'hang-delete') break;
      if (mode.includes('delete')) refuse();
      else {
        writeFileSync(
          store,
          JSON.stringify(sessions.filter((value) => value !== params.sessionId)),
        );
        result({});
      }
      break;
    default:
      refuse();
  }
}
