/**
 * Scripted stdio Codex app-server focused on `thread/turns/list` pagination scenarios.
 * Reads its scenario JSON from `CODEX_TURNS_SCENARIO` and records every `thread/turns/list`
 * request to `CODEX_TURNS_LOG`.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

if (process.env.FAKE_ENGINE_PID_FILE !== undefined) {
  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });
  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));
}

interface PageReply {
  result?: unknown;
  error?: { code: number; message: string };
}

interface TurnsScenario {
  pages: Record<string, PageReply>;
  /** Optional synthetic infinite-cursor generator when `infinite: true`. */
  infinite?: boolean;
}

const scenario: TurnsScenario = JSON.parse(
  readFileSync(process.env.CODEX_TURNS_SCENARIO ?? '/nonexistent', 'utf8'),
);
const logPath = process.env.CODEX_TURNS_LOG;
const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
let generatedPages = 0;

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.id === undefined) continue;
  const reply = (result: unknown) => write({ id: message.id, result });
  switch (message.method) {
    case 'initialize':
      reply({ userAgent: 'fake-turns' });
      break;
    case 'thread/turns/list': {
      if (logPath !== undefined) {
        mkdirSync(dirname(logPath), { recursive: true });
        appendFileSync(logPath, `${JSON.stringify(message.params)}\n`);
      }
      if (scenario.infinite) {
        generatedPages += 1;
        reply({
          data: [
            {
              id: `turn-${generatedPages}`,
              status: 'completed',
              items: [
                {
                  type: 'userMessage',
                  id: `m-${generatedPages}`,
                  clientId: `other-${generatedPages}`,
                },
              ],
            },
          ],
          nextCursor: `auto-${generatedPages}`,
        });
        break;
      }
      const key =
        message.params?.cursor === undefined ? '__first__' : String(message.params.cursor);
      const entry = scenario.pages[key];
      if (!entry) {
        write({
          id: message.id,
          error: { code: -32602, message: `Unexpected cursor ${key}` },
        });
      } else if (entry.error) {
        write({ id: message.id, error: entry.error });
      } else {
        reply(entry.result);
      }
      break;
    }
    default:
      write({
        id: message.id,
        error: { code: -32601, message: `${message.method} unsupported` },
      });
  }
}
