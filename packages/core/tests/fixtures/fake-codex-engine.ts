/**
 * A scripted Codex app-server for the driver's conformance: answers
 * `--version`, `login status` and the protocol requests itself, keeps each
 * turn's `clientUserMessageId` where `thread/turns/list` finds it, and plays
 * the scenario in `FAKE_ENGINE_SCENARIO` once a turn starts.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { FakeEngineScenarioSchema } from '../../src/agent-executor/testing/fake-engine';

if (process.env.FAKE_ENGINE_PID_FILE !== undefined) {
  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });
  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));
}

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('codex-cli 9.9.9\n');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  process.stderr.write('Logged in using ChatGPT\n');
  process.exit(0);
}
const home = process.env.CODEX_HOME ?? '/nonexistent';
mkdirSync(home, { recursive: true });
const ledger = `${home}/client-ids.jsonl`;
const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
const scenario = FakeEngineScenarioSchema.parse(
  JSON.parse(readFileSync(process.env.FAKE_ENGINE_SCENARIO ?? '/nonexistent', 'utf8')),
);
const waiting: { type: string; resolve(): void }[] = [];
const buffered: string[] = [];
const seen = (type: string) => {
  const index = waiting.findIndex((entry) => entry.type === type);
  if (index !== -1) {
    waiting.splice(index, 1)[0]?.resolve();
    return;
  }
  buffered.push(type);
};
const expectEvent = (type: string) => {
  const index = buffered.indexOf(type);
  if (index !== -1) {
    buffered.splice(index, 1);
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => waiting.push({ type, resolve }));
};
const play = async () => {
  for (const step of scenario.steps) {
    if (step.do === 'emit') write(step.record);
    else if (step.do === 'emit-raw') process.stdout.write(`${step.line}\n`);
    else if (step.do === 'delay') await new Promise((resolve) => setTimeout(resolve, step.ms));
    else if (step.do === 'expect') await expectEvent(step.type);
    else if (step.do === 'exit') process.exit(step.code);
    else process.kill(process.pid, 'SIGKILL');
  }
};
const clientIds = () => {
  try {
    return readFileSync(ledger, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    appendFileSync(`${home}/responses.jsonl`, `${JSON.stringify(message)}\n`);
    seen('response');
    continue;
  }
  seen(message.method);
  if (message.id === undefined) continue;
  const reply = (result: unknown) => write({ id: message.id, result });
  switch (message.method) {
    case 'initialize':
      reply({ userAgent: 'fake', codexHome: home });
      break;
    case 'thread/start':
      appendFileSync(`${home}/thread-start.jsonl`, `${JSON.stringify(message.params)}\n`);
      reply({ thread: { id: 'fake-thread' } });
      break;
    case 'thread/resume':
      appendFileSync(`${home}/thread-resume.jsonl`, `${JSON.stringify(message.params)}\n`);
      reply({ thread: { id: message.params?.threadId ?? 'fake-thread' } });
      break;
    case 'turn/start':
      buffered.length = 0;
      appendFileSync(ledger, `${message.params.clientUserMessageId}\n`);
      reply({ turn: { id: 'fake-turn', status: 'inProgress', items: [] } });
      void play();
      break;
    case 'turn/interrupt':
      reply({});
      break;
    case 'thread/turns/list':
      reply({
        data: clientIds().map((clientId, index) => ({
          id: `turn-${index}`,
          status: 'completed',
          items: [{ type: 'userMessage', id: `m-${index}`, clientId }],
        })),
      });
      break;
    case 'account/rateLimits/read':
      reply({
        rateLimits: {
          primary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: 1796032800 },
        },
      });
      break;
    default:
      write({
        id: message.id,
        error: { code: -32601, message: `${message.method} is not faked` },
      });
  }
}
