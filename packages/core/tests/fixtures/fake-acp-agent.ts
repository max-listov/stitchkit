/**
 * A scripted ACP v1 agent for the driver's conformance: answers the protocol
 * itself, keeps each prompt where a test counts them, and plays the scenario
 * in `FAKE_ENGINE_SCENARIO` once a prompt arrives. `FAKE_ACP_PROTOCOL` sets
 * the protocol version it claims.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { FakeEngineScenarioSchema } from '../../src/agent-executor/testing/fake-engine';

if (process.env.FAKE_ENGINE_PID_FILE !== undefined) {
  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });
  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));
}

/** Where the fake keeps what it was sent; a probe without a profile (`info`) keeps nothing. */
const home = process.env.FAKE_ACP_HOME;
if (home !== undefined) mkdirSync(home, { recursive: true });
const record = (file: string, value: unknown) => {
  if (home !== undefined) appendFileSync(`${home}/${file}`, `${JSON.stringify(value)}\n`);
};
const write = (message: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const scenario = FakeEngineScenarioSchema.parse(
  // A probe without a profile (`info`) runs no scenario.
  process.env.FAKE_ENGINE_SCENARIO === undefined
    ? { steps: [] }
    : JSON.parse(readFileSync(process.env.FAKE_ENGINE_SCENARIO, 'utf8')),
);
const waiting: { type: string; resolve(): void }[] = [];
const buffered: string[] = [];
const options: {
  id: string;
  category: string;
  currentValue: string;
  options:
    | { value: string; name: string }[]
    | { group: string; options: { value: string; name: string }[] }[];
}[] = [
  {
    id: 'model',
    category: 'model',
    currentValue: 'large',
    options: [
      { group: 'Fast', options: [{ value: 'small', name: 'Small' }] },
      { group: 'Deep', options: [{ value: 'large', name: 'Large' }] },
    ],
  },
  {
    id: 'thought',
    category: 'thought_level',
    currentValue: 'high',
    options: [
      { value: 'low', name: 'Low' },
      { value: 'high', name: 'High' },
    ],
  },
  {
    id: 'mode',
    category: 'mode',
    currentValue: 'default',
    options: [
      { value: 'default', name: 'Ask' },
      { value: 'plan', name: 'Plan' },
    ],
  },
];
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
const play = async (promptId: unknown) => {
  for (const step of scenario.steps) {
    if (step.do === 'emit') {
      const record = step.record;
      if (
        typeof record === 'object' &&
        record !== null &&
        !Array.isArray(record) &&
        'answerPrompt' in record
      ) {
        write({ id: promptId, result: record.answerPrompt });
      } else if (
        typeof record === 'object' &&
        record !== null &&
        !Array.isArray(record) &&
        'refusePrompt' in record
      ) {
        write({ id: promptId, error: record.refusePrompt });
      } else {
        process.stdout.write(`${JSON.stringify(record)}\n`);
      }
    } else if (step.do === 'emit-raw') process.stdout.write(`${step.line}\n`);
    else if (step.do === 'delay') await new Promise((resolve) => setTimeout(resolve, step.ms));
    else if (step.do === 'expect') await expectEvent(step.type);
    else if (step.do === 'exit') process.exit(step.code);
    else process.kill(process.pid, 'SIGKILL');
  }
};
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    record('responses.jsonl', message);
    seen('response');
    continue;
  }
  seen(message.method);
  record('methods.jsonl', { method: message.method, params: message.params });
  if (message.id === undefined) continue;
  const reply = (result: unknown) => write({ id: message.id, result });
  if (process.env.FAKE_ACP_SILENT === '1') continue;
  switch (message.method) {
    case 'initialize':
      // Which home the agent was given: the one an agent keeps its sign-in under.
      record('home.jsonl', { HOME: process.env.HOME });
      reply({
        protocolVersion: Number(process.env.FAKE_ACP_PROTOCOL ?? 1),
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: process.env.FAKE_ACP_IMAGE === '1' },
          sessionCapabilities: {
            load: {},
            list: {},
            close: {},
            ...(process.env.FAKE_ACP_RESUME === '1' && { resume: {} }),
          },
          // A vendor's own keys beside the standard ones, as agy sends them.
          session_capabilities: { load: {} },
          _meta: { vendor: { tier: true } },
        },
        agentInfo: { name: 'fake', version: '9.9.9' },
        authMethods: [{ id: 'oauth-personal', name: 'Log in' }],
      });
      break;
    case 'session/new':
      // A probe has no profile, so its scenario comes in the agent's arguments.
      if (process.argv.includes('--refuse-session-new')) {
        write({ id: message.id, error: { code: -32603, message: 'probe refused' } });
        break;
      }
      if (process.argv.includes('--offer-no-models')) {
        reply({ sessionId: 'fake-session' });
        break;
      }
      if (process.env.FAKE_ACP_NEW_ERROR !== undefined) {
        write({ id: message.id, error: JSON.parse(process.env.FAKE_ACP_NEW_ERROR) });
        break;
      }
      if (process.env.FAKE_ACP_SIGNED_OUT === '1') {
        write({ id: message.id, error: { code: -32000, message: 'Authentication required' } });
        break;
      }
      reply({ sessionId: 'fake-session', configOptions: options, _meta: { vendor: {} } });
      break;
    case 'session/set_config_option': {
      const option = options.find((candidate) => candidate.id === message.params.configId);
      if (option !== undefined) option.currentValue = message.params.value;
      // Choosing a model narrows the thought levels, as agy does.
      if (message.params.configId === 'model' && message.params.value === 'small') {
        const thought = options.find((candidate) => candidate.id === 'thought');
        if (thought !== undefined) thought.options = [{ value: 'low', name: 'Low' }];
      }
      write({
        method: 'session/update',
        params: {
          sessionId: message.params.sessionId,
          update: { sessionUpdate: 'config_option_update', configOptions: options },
        },
      });
      reply({ configOptions: options });
      break;
    }
    case 'session/load':
    case 'session/resume':
      if (message.method === 'session/load') {
        // An agent replays the session's history as updates before it answers the load.
        for (const text of ['old question', 'old answer']) {
          write({
            method: 'session/update',
            params: {
              sessionId: message.params.sessionId,
              update: {
                sessionUpdate:
                  text === 'old question' ? 'user_message_chunk' : 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: text.repeat(Number(process.env.FAKE_ACP_REPLAY_REPEAT ?? 1)),
                },
              },
            },
          });
        }
      }
      reply({ configOptions: options });
      break;
    case 'session/list':
      reply({
        sessions: [
          {
            sessionId: 'kept',
            cwd: message.params.cwd,
            title: 'Old work',
            updatedAt: '2026-11-23T10:00:00Z',
          },
        ],
      });
      break;
    case 'session/close': {
      const delayMs = Number(process.env.FAKE_ACP_CLOSE_DELAY_MS ?? 0);
      if (delayMs > 0) setTimeout(() => reply({}), delayMs);
      else reply({});
      break;
    }
    case 'session/prompt':
      buffered.length = 0;
      record('prompts.jsonl', message.params.prompt);
      void play(message.id);
      break;
    default:
      write({
        id: message.id,
        error: { code: -32601, message: `${message.method} is not faked` },
      });
  }
}
