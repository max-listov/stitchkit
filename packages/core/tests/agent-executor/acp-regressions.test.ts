/**
 * ACP driver regressions: a long multi-step turn, refusals at open, how a refusal is
 * classified, stream errors that keep their type, empty ids, and close.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { closeRequestTimeoutMs } from '../../src/agent-executor/acp/v1-connect';
import { createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
import type {
  AcpPermissionRequestEvent,
  AcpUpdateEvent,
} from '../../src/agent-executor/acp/v1-handlers';
import { classifyAcpRpcRefusal } from '../../src/agent-executor/acp/v1-map';
import { JsonRpcError } from '../../src/agent-executor/json-rpc-peer';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import { type ExecutorDelta, ExecutorDeltaSchema } from '../../src/agent-executor/vocabulary';
import { StreamLineLimitError } from '../../src/internal/bounded-lines';
import {
  ambientIn,
  drain,
  drainApproving,
  FAKE_ACP,
  inScratch,
  readJsonLines,
  recordedLines,
  trackedPidFile,
  untilRecorded,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

type AcpDriverOptions = Omit<
  Parameters<typeof createAcpDriver>[0],
  'executable' | 'args' | 'ambient'
>;

function acpDriver(root: string, options: AcpDriverOptions = {}) {
  return createAcpDriver({
    executable: process.execPath,
    args: [FAKE_ACP],
    ambient: ambientIn(root),
    ...options,
  });
}

function acpProfile(root: string, label: string, env: Record<string, string> = {}) {
  const home = join(root, 'home');
  return {
    profileId: 'fake',
    engine: 'acp' as const,
    home,
    env: { FAKE_ACP_HOME: home, FAKE_ENGINE_PID_FILE: trackedPidFile(root, label), ...env },
  };
}

/** A JSON value a scripted engine writes. */
type EngineJson = Extract<FakeEngineStep, { do: 'emit' }>['record'];

function update(update: { [key: string]: EngineJson }): FakeEngineStep {
  return {
    do: 'emit',
    record: {
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId: 'fake-session', update },
    },
  };
}

function startText(session: Awaited<ReturnType<ReturnType<typeof acpDriver>['open']>>) {
  return session.startTurn({
    turnId: 't',
    clientId: crypto.randomUUID(),
    input: [{ type: 'text', text: 'go' }],
  });
}

describe('ACP driver: a long turn of text, a tool call, an unknown request and a permission', () => {
  /**
   * The bound every request but `session/prompt` waits under. `initialize` is one of them, and it
   * is sent the moment the agent is spawned, so this bound also covers the fake agent's cold start
   * (a Bun process loading Zod), which a loaded machine stretches past half a second: it is kept
   * well above that, and the prompt below outlives it by the scenario's own delay.
   */
  const REQUEST_TIMEOUT_MS = 3_000;
  let deltas: ExecutorDelta[] = [];
  let responses: unknown[] = [];

  beforeAll(async () => {
    await inScratch('acp-long-turn', async (root) => {
      const scenario = await writeScenario(root, [
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'first ' },
        }),
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'ReadFile',
          status: 'in_progress',
        }),
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          rawOutput: { ok: true },
        }),
        {
          do: 'emit',
          record: {
            jsonrpc: '2.0',
            id: 'unknown-req-1',
            method: 'vendor/unknown_request',
            params: {},
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            jsonrpc: '2.0',
            id: 'perm-1',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: { toolCallId: 'tc-2' },
              options: [
                { optionId: 'always', kind: 'allow_always' },
                { optionId: 'once', kind: 'allow_once' },
              ],
            },
          },
        },
        { do: 'expect', type: 'response' },
        // Longer than the driver's requestTimeoutMs below.
        { do: 'delay', ms: REQUEST_TIMEOUT_MS + 300 },
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'second' },
        }),
        { do: 'emit', record: { answerPrompt: { stopReason: 'end_turn', usage: null } } },
      ]);
      const profile = acpProfile(root, 'acp-long-turn', { FAKE_ENGINE_SCENARIO: scenario });
      const session = await acpDriver(root, { requestTimeoutMs: REQUEST_TIMEOUT_MS }).open({
        profile,
        cwd: root,
      });
      try {
        deltas = await drainApproving(await startText(session));
      } finally {
        await session.close();
      }
      responses = await readJsonLines(join(profile.home, 'responses.jsonl'));
    });
  }, 20_000);

  test('a prompt that outlives requestTimeoutMs and answers usage: null completes', () => {
    expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
  });

  test('the text before and after a tool call are two items with distinct ids', () => {
    const textIds = deltas
      .filter((delta) => delta.type === 'text')
      .map((delta) => delta.itemId);
    expect(textIds).toHaveLength(2);
    expect(textIds[0]).not.toBe(textIds[1]);
  });

  test('a tool result keeps the name of its call', () => {
    const result = deltas.find((delta) => delta.type === 'tool-result');
    expect(result?.type === 'tool-result' ? result.toolName : undefined).toBe('ReadFile');
  });

  test('a request the driver does not know is carried as unhandled', () => {
    expect(deltas.some((delta) => delta.type === 'error' && delta.kind === 'unhandled')).toBe(
      true,
    );
  });

  test('an approved permission selects allow_once over allow_always', () => {
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: 'perm-1',
        result: { outcome: { outcome: 'selected', optionId: 'once' } },
      }),
    );
  });
});

describe('ACP driver: refusals before work', () => {
  test('invalid mcpServers are refused before the engine is spawned', () =>
    inScratch('acp-bad-mcp', async (root) => {
      const profile = acpProfile(root, 'acp-bad-mcp');
      await expect(
        acpDriver(root, { mcpServers: JSON.parse('[{"name":"","command":""}]') }).open({
          profile,
          cwd: root,
        }),
      ).rejects.toThrow();
      expect(existsSync(profile.env.FAKE_ENGINE_PID_FILE)).toBe(false);
    }));

  test('an already-aborted signal refuses open with its reason', () =>
    inScratch('acp-aborted', async (root) => {
      const aborted = new AbortController();
      aborted.abort(new Error('cancelled-before-open'));
      await expect(
        acpDriver(root).open({
          profile: acpProfile(root, 'acp-aborted'),
          cwd: root,
          signal: aborted.signal,
        }),
      ).rejects.toThrow('cancelled-before-open');
    }));

  test.each([Number.NaN, 0, -1, 1.5])(
    'maxImageBytes %p is refused when the driver is created',
    (maxImageBytes) => {
      expect(() =>
        createAcpDriver({
          executable: '/nonexistent/must-not-spawn',
          maxImageBytes,
          ambient: ambientIn('/nonexistent'),
        }),
      ).toThrow(TypeError);
    },
  );
});

describe('ACP refusal classification', () => {
  test.each([
    'Failed to generate response',
    'Cannot iterate over items',
    'Migration failed',
    'HTTP 4290 backend failure',
    'Unknown author in metadata',
    'Parse error at line 4010',
  ])(
    'a prompt refused with "%s" fails with the engine message, not a refusal kind',
    (message) =>
      inScratch('acp-false-positive', async (root) => {
        const scenario = await writeScenario(root, [
          { do: 'emit', record: { refusePrompt: { code: -32603, message } } },
        ]);
        const session = await acpDriver(root).open({
          profile: acpProfile(root, 'acp-false-positive', { FAKE_ENGINE_SCENARIO: scenario }),
          cwd: root,
        });
        try {
          await expect(drain(await startText(session))).rejects.toThrow(message);
        } finally {
          await session.close();
        }
      }),
  );

  test.each(['Unknown author', 'Error at line 4010', 'Failed to generate response'])(
    'status() reads a session/new refusal "%s" as an unknown login',
    (message) =>
      inScratch('acp-status-unknown', async (root) => {
        const status = await acpDriver(root).status(
          acpProfile(root, 'acp-status-unknown', {
            FAKE_ACP_NEW_ERROR: JSON.stringify({ code: -32603, message }),
          }),
        );
        expect(status.login.state).toBe('unknown');
      }),
  );

  test('status() reads the -32000 auth code as signed-out', () =>
    inScratch('acp-status-auth', async (root) => {
      const status = await acpDriver(root).status(
        acpProfile(root, 'acp-status-auth', {
          FAKE_ACP_NEW_ERROR: JSON.stringify({ code: -32000, message: 'Please sign in' }),
        }),
      );
      expect(status.login.state).toBe('signed-out');
    }));

  test.each(['RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED', 'ERR_429'])(
    'an underscore-separated code %s is rateLimited',
    (message) => {
      expect(classifyAcpRpcRefusal(new JsonRpcError(-32603, message))).toBe('rateLimited');
    },
  );

  test.each([
    'UNAUTHENTICATED',
    'UNAUTHENTICATED: please log in',
    'Please log in to continue',
    'AUTH_REQUIRED',
    'ERR_401',
  ])('"%s" is authRequired', (message) => {
    expect(classifyAcpRpcRefusal(new JsonRpcError(-32603, message))).toBe('authRequired');
  });

  test.each(['generate', 'iterate', 'migrate', 'author', '4290', '4010'])(
    'a word or number that merely contains a code (%s) is no refusal kind',
    (message) => {
      expect(classifyAcpRpcRefusal(new JsonRpcError(-32603, message))).toBeUndefined();
    },
  );

  test('an error that is not a JSON-RPC refusal is not classified', () => {
    expect(classifyAcpRpcRefusal(new Error('RATE_LIMIT_EXCEEDED'))).toBeUndefined();
  });
});

describe('ACP stream errors keep their type', () => {
  test('an invalid line fails the turn with SyntaxError, not "could not run"', () =>
    inScratch('acp-syntax', async (root) => {
      const scenario = await writeScenario(root, [{ do: 'emit-raw', line: '{"jsonrpc":' }]);
      const session = await acpDriver(root).open({
        profile: acpProfile(root, 'acp-syntax', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const failure = await drain(await startText(session)).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(SyntaxError);
        expect(String(failure)).not.toContain('could not run');
      } finally {
        await session.close();
      }
    }));

  test('an overlong replayed line fails open with StreamLineLimitError, not "could not run"', () =>
    inScratch('acp-limit', async (root) => {
      const failure = await acpDriver(root, { maxFrameBytes: 64 * 1024 })
        .open({
          profile: acpProfile(root, 'acp-limit', { FAKE_ACP_REPLAY_REPEAT: '20000' }),
          cwd: root,
          nativeThreadId: 'kept',
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StreamLineLimitError);
      expect(String(failure)).not.toContain('could not run');
    }));
});

describe('ACP empty ids', () => {
  test('empty tool call ids, names and titles still give deltas that pass ExecutorDeltaSchema', () =>
    inScratch('acp-empty-ids', async (root) => {
      const scenario = await writeScenario(root, [
        update({ sessionUpdate: 'tool_call', toolCallId: '', name: '', title: '', kind: '' }),
        {
          do: 'emit',
          record: {
            jsonrpc: '2.0',
            id: 'perm-empty',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: { toolCallId: '', name: '', title: '' },
              options: [{ optionId: 'yes', kind: 'allow_once' }],
            },
          },
        },
        { do: 'expect', type: 'response' },
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: '',
          name: '',
          title: '',
          status: 'completed',
        }),
        { do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } },
      ]);
      const session = await acpDriver(root).open({
        profile: acpProfile(root, 'acp-empty-ids', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drainApproving(await startText(session));
        for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
        for (const type of ['tool-call', 'request', 'tool-result'] as const) {
          expect(deltas.some((delta) => delta.type === type)).toBe(true);
        }
      } finally {
        await session.close();
      }
    }));
});

describe('ACP close', () => {
  async function closingSession(
    root: string,
    label: string,
    closeDelayMs: number,
    options: AcpDriverOptions = {},
  ) {
    const scenario = await writeScenario(root, []);
    return acpDriver(root, options).open({
      profile: acpProfile(root, label, {
        FAKE_ENGINE_SCENARIO: scenario,
        FAKE_ACP_CLOSE_DELAY_MS: String(closeDelayMs),
      }),
      cwd: root,
    });
  }

  test('startTurn while session/close is in flight is refused as closing', () =>
    inScratch('acp-closing-turn', async (root) => {
      const session = await closingSession(root, 'acp-closing-turn', 200);
      const closing = session.close();
      try {
        await expect(startText(session)).rejects.toThrow(/closing/i);
      } finally {
        await closing;
      }
    }));

  test('setConfigOption while session/close is in flight is refused as closing', () =>
    inScratch('acp-closing-config', async (root) => {
      const session = await closingSession(root, 'acp-closing-config', 200);
      const closing = session.close();
      try {
        await expect(session.setConfigOption('mode', 'plan')).rejects.toThrow(/closing/i);
      } finally {
        await closing;
      }
    }));

  test('the session/close wait follows requestTimeoutMs, at most 5 s', () => {
    expect(closeRequestTimeoutMs({ requestTimeoutMs: 150 })).toBe(150);
    expect(closeRequestTimeoutMs({ requestTimeoutMs: 600 })).toBe(600);
    expect(closeRequestTimeoutMs({ requestTimeoutMs: 60_000 })).toBe(5_000);
    expect(closeRequestTimeoutMs({})).toBe(5_000);
  });

  test('close() stops waiting for a slow session/close at that bound', () =>
    inScratch('acp-close-bound', async (root) => {
      const session = await closingSession(root, 'acp-close-bound', 3_000, {
        requestTimeoutMs: 600,
      });
      const startedAt = Date.now();
      await session.close();
      expect(Date.now() - startedAt).toBeLessThan(1_800);
    }));
});

describe('ACP approval enforcement contract', () => {
  test('declares approvalEnforcement as agent-initiated and never synthesizes a request for unprompted tool_call', () =>
    inScratch('acp-approval-enforcement', async (root) => {
      const scenario = await writeScenario(root, [
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-unprompted',
          name: 'write_file',
          status: 'in_progress',
          rawInput: { path: 'hello.txt', content: 'hi' },
        }),
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-unprompted',
          status: 'completed',
          rawOutput: { written: true },
        }),
        { do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } },
      ]);
      const driver = acpDriver(root, { mode: 'default' });
      expect(driver.approvalEnforcement).toBe('agent-initiated');
      const session = await driver.open({
        profile: acpProfile(root, 'acp-approval-enforcement', {
          FAKE_ENGINE_SCENARIO: scenario,
        }),
        cwd: root,
      });
      try {
        expect(session.approvalEnforcement).toBe('agent-initiated');
        const deltas = await drain(await startText(session));
        expect(deltas.some((delta) => delta.type === 'tool-call')).toBe(true);
        expect(deltas.some((delta) => delta.type === 'tool-result')).toBe(true);
        expect(deltas.some((delta) => delta.type === 'request')).toBe(false);
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      } finally {
        await session.close();
      }
    }));

  test('accepts explicit scope once and interrupt false, and refuses session-scoped approve or turn-cancelling deny fail-closed', () =>
    inScratch('acp-reply-bounds', async (root) => {
      const scenario = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            id: 'perm-bounds-1',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: { toolCallId: 'tc-1', title: 'Run' },
              options: [
                { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'perm-bounds-2',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: { toolCallId: 'tc-2', title: 'Write' },
              options: [
                { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ],
            },
          },
        },
        { do: 'expect', type: 'response' },
        { do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } },
      ]);
      const profile = acpProfile(root, 'acp-reply-bounds', { FAKE_ENGINE_SCENARIO: scenario });
      const session = await acpDriver(root).open({
        profile,
        cwd: root,
      });
      try {
        const turn = await startText(session);
        const deltas = [];
        for await (const delta of turn.deltas) {
          deltas.push(delta);
          if (delta.type === 'request' && delta.interactionId === 'perm-bounds-1') {
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'approve',
                updatedInput: { path: 'rewritten' },
              }),
            ).rejects.toThrow(TypeError);
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'deny',
                message: 'stop',
                interrupt: true,
              }),
            ).rejects.toThrow(TypeError);
            await turn.respond(delta.interactionId, { kind: 'approve', scope: 'once' });
          } else if (delta.type === 'request' && delta.interactionId === 'perm-bounds-2') {
            // `perm-bounds-2` offers no `allow_always`, so session-scoped approve must fail closed.
            await expect(
              turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' }),
            ).rejects.toThrow(TypeError);
            await turn.respond(delta.interactionId, {
              kind: 'deny',
              message: 'no thanks',
              interrupt: false,
            });
          }
        }
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        const responses = await readJsonLines(join(profile.home, 'responses.jsonl'));
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'perm-bounds-1',
          result: { outcome: { outcome: 'selected', optionId: 'once' } },
        });
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'perm-bounds-2',
          result: { outcome: { outcome: 'selected', optionId: 'reject' } },
        });
      } finally {
        await session.close();
      }
    }));
});

const RecordedMethodLineSchema = z.looseObject({
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

async function readMethodLines(path: string) {
  return (await readJsonLines(path)).map((line) => RecordedMethodLineSchema.parse(line));
}

/** Write a small self-contained ACP test agent script inside a scratch root (with PID tracking). */
async function writeCustomAcpAgent(root: string, name: string, body: string): Promise<string> {
  const scriptPath = join(root, `${name}.mjs`);
  const source = [
    `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';`,
    `import { dirname } from 'node:path';`,
    `import { createInterface } from 'node:readline';`,
    'if (process.env.FAKE_ENGINE_PID_FILE) {',
    '  mkdirSync(dirname(process.env.FAKE_ENGINE_PID_FILE), { recursive: true });',
    '  writeFileSync(process.env.FAKE_ENGINE_PID_FILE, String(process.pid));',
    '}',
    'const home = process.env.FAKE_ACP_HOME;',
    'if (home) mkdirSync(home, { recursive: true });',
    'const record = (file, value) => {',
    `  if (home) appendFileSync(home + '/' + file, JSON.stringify(value) + '\\n');`,
    '};',
    `const write = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\\n');`,
    body,
  ].join('\n');
  await writeFile(scriptPath, source);
  return scriptPath;
}

describe('ACP protocol compatibility, probes, post-settle events, usage, steering and overrides', () => {
  test('clientInfo is sent on initialize and sessionMeta attaches _meta on session/new and session/resume', () =>
    inScratch('acp-client-meta', async (root) => {
      const profile = acpProfile(root, 'acp-client-meta', { FAKE_ACP_RESUME: '1' });
      const staticDriver = acpDriver(root, {
        clientInfo: { name: 'stitch-host', version: '1.2.3', title: 'Stitch Host' },
        sessionMeta: { host: { mode: 'static' } },
      });
      const first = await staticDriver.open({ profile, cwd: root });
      await first.close();

      const dynamicDriver = acpDriver(root, {
        clientInfo: { name: 'stitch-host', version: '1.2.3' },
        sessionMeta: (init) => ({
          observedAgent: init.agentInfo?.version ?? 'unknown',
        }),
      });
      const resumed = await dynamicDriver.open({
        profile,
        cwd: root,
        nativeThreadId: 'kept',
      });
      await resumed.close();

      const methods = await readMethodLines(join(profile.home, 'methods.jsonl'));
      const initCalls = methods.filter((entry) => entry.method === 'initialize');
      expect(initCalls[0]?.params).toMatchObject({
        clientInfo: { name: 'stitch-host', version: '1.2.3', title: 'Stitch Host' },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      });
      expect(methods.find((entry) => entry.method === 'session/new')?.params).toMatchObject({
        _meta: { host: { mode: 'static' } },
      });
      expect(methods.find((entry) => entry.method === 'session/resume')?.params).toMatchObject(
        {
          sessionId: 'kept',
          _meta: { observedAgent: '9.9.9' },
        },
      );

      // Negative control: invalid clientInfo or non-object sessionMeta refuses before spawn.
      const badProfile = acpProfile(root, 'acp-bad-meta');
      expect(() =>
        createAcpDriver({
          executable: process.execPath,
          args: [FAKE_ACP],
          clientInfo: { name: '', version: '1.0.0' },
          ambient: ambientIn(root),
        }),
      ).toThrow();
      expect(() =>
        createAcpDriver({
          executable: process.execPath,
          args: [FAKE_ACP],
          sessionMeta: JSON.parse('"not-an-object"'),
          ambient: ambientIn(root),
        }),
      ).toThrow(TypeError);
      expect(existsSync(badProfile.env.FAKE_ENGINE_PID_FILE)).toBe(false);
    }));

  test('stdoutLineFilter skips non-JSON stdout lines while unfiltered non-JSON still fails the session', () =>
    inScratch('acp-stdout-filter', async (root) => {
      const script = await writeCustomAcpAgent(
        root,
        'noisy-agent',
        `
        process.stdout.write('Open the following link in your browser: https://example.test/auth\\n');
        for await (const line of createInterface({ input: process.stdin })) {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            write({ id: msg.id, result: { protocolVersion: 2, agentCapabilities: {}, agentInfo: { name: 'noisy', version: '1.5.0' } } });
          } else if (msg.method === 'session/new') {
            write({ id: msg.id, result: { sessionId: 's-noisy' } });
          } else if (msg.method === 'session/prompt') {
            process.stdout.write('OAuth notice: refreshing session...\\n');
            write({
              method: 'session/update',
              params: {
                sessionId: 's-noisy',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'clean' } },
              },
            });
            write({ id: msg.id, result: { stopReason: 'end_turn' } });
          }
        }
        `,
      );
      const filteredDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
        stdoutLineFilter: (line) => line.trimStart().startsWith('{'),
      });
      const session = await filteredDriver.open({
        profile: acpProfile(root, 'acp-noisy-ok'),
        cwd: root,
      });
      try {
        const deltas = await drain(await startText(session));
        expect(deltas.filter((delta) => delta.type === 'text')).toMatchObject([
          { text: 'clean' },
        ]);
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      } finally {
        await session.close();
      }

      // Negative control: without stdoutLineFilter, non-JSON stdout fails with SyntaxError.
      const unfilteredDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
      });
      const failure = await unfilteredDriver
        .open({ profile: acpProfile(root, 'acp-noisy-fail'), cwd: root })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SyntaxError);
    }));

  test('probeMode passive spawns zero processes with passiveVersion, initialize-only skips session/new, and ephemeral-session falls back to session/delete', () =>
    inScratch('acp-probe-modes', async (root) => {
      const markerFile = join(root, 'spawned.marker');
      const deleteAgent = await writeCustomAcpAgent(
        root,
        'delete-probe-agent',
        `
        writeFileSync(${JSON.stringify(markerFile)}, 'spawned');
        for await (const line of createInterface({ input: process.stdin })) {
          const msg = JSON.parse(line);
          record('methods.jsonl', { method: msg.method, params: msg.params });
          if (msg.method === 'initialize') {
            write({
              id: msg.id,
              result: {
                protocolVersion: 1,
                agentCapabilities: {
                  sessionCapabilities: {
                    close: process.env.FAIL_CLOSE === '1' ? {} : null,
                    delete: {},
                  },
                },
                agentInfo: { name: 'probe-agent', version: '2.4.0' },
              },
            });
          } else if (msg.method === 'session/new') {
            write({
              id: msg.id,
              result: {
                sessionId: 'probe-s1',
                models: { availableModels: [{ modelId: 'm-fast' }] },
              },
            });
          } else if (msg.method === 'session/close') {
            write({ id: msg.id, error: { code: -32601, message: 'close unsupported' } });
          } else if (msg.method === 'session/delete') {
            write({ id: msg.id, result: {} });
          }
        }
        `,
      );

      // 1. Passive mode spawns ZERO processes and reports honest unknown / passiveVersion.
      const passiveNamed = createAcpDriver({
        executable: process.execPath,
        args: [deleteAgent],
        ambient: ambientIn(root),
        probeMode: 'passive',
        passiveVersion: '1.5.14',
      });
      const passiveDefault = createAcpDriver({
        executable: process.execPath,
        args: [deleteAgent],
        ambient: ambientIn(root),
        probeMode: 'passive',
      });
      expect(await passiveNamed.info()).toMatchObject({
        engine: 'acp',
        version: '1.5.14',
        reconcile: 'none',
        models: { answer: 'not-asked' },
      });
      expect(await passiveDefault.info()).toMatchObject({
        engine: 'acp',
        version: 'unknown',
        models: { answer: 'not-asked' },
      });
      expect(await passiveNamed.status(acpProfile(root, 'acp-passive-status'))).toEqual({
        login: { state: 'unknown' },
        effectiveCredential: 'unknown',
      });
      expect(existsSync(markerFile)).toBe(false);

      // 2. initialize-only spawns initialize ONLY and skips session/new.
      const initProfile = acpProfile(root, 'acp-init-only');
      const initDriver = createAcpDriver({
        executable: process.execPath,
        args: [deleteAgent],
        ambient: ambientIn(root),
        probeMode: 'initialize-only',
      });
      expect(await initDriver.info()).toMatchObject({
        engine: 'acp',
        version: '2.4.0',
        models: { answer: 'not-asked' },
      });
      expect(await initDriver.status(initProfile)).toEqual({
        login: { state: 'unknown' },
        effectiveCredential: 'unknown',
      });
      const initMethods = await readMethodLines(join(initProfile.home, 'methods.jsonl'));
      expect(initMethods.map((entry) => entry.method)).toEqual(['initialize']);

      // 3. ephemeral-session cleans up via session/delete when close is absent OR fails.
      for (const failClose of ['0', '1']) {
        const ephemeralProfile = acpProfile(root, `acp-ephemeral-${failClose}`, {
          FAIL_CLOSE: failClose,
        });
        const ephemeralDriver = createAcpDriver({
          executable: process.execPath,
          args: [deleteAgent],
          ambient: ambientIn(root),
          probeMode: 'ephemeral-session',
        });
        expect(await ephemeralDriver.status(ephemeralProfile)).toEqual({
          login: { state: 'signed-in' },
          effectiveCredential: 'unknown',
        });
        const methods = (
          await readMethodLines(join(ephemeralProfile.home, 'methods.jsonl'))
        ).map((entry) => entry.method);
        expect(methods).toContain('session/new');
        expect(methods).toContain('session/delete');
      }
    }));

  test('transformUpdate normalizes or drops updates before mapping to turn deltas', () =>
    inScratch('acp-transform-update', async (root) => {
      const scenario = await writeScenario(root, [
        update({ sessionUpdate: 'vendor_checklist', steps: ['a', 'b'] }),
        update({ sessionUpdate: 'vendor_noise' }),
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        }),
        { do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } },
      ]);
      const driver = acpDriver(root, {
        transformUpdate(incoming) {
          if (incoming.sessionUpdate === 'vendor_noise') return null;
          if (incoming.sessionUpdate === 'vendor_checklist') {
            return [
              {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: 'checklist updated' },
              },
              { sessionUpdate: 'plan' },
            ];
          }
          return incoming;
        },
      });
      const session = await driver.open({
        profile: acpProfile(root, 'acp-transform-ok', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drain(await startText(session));
        expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
        expect(deltas.filter((delta) => delta.type === 'reasoning')).toMatchObject([
          { text: 'checklist updated' },
        ]);
        expect(deltas.filter((delta) => delta.type === 'text')).toMatchObject([
          { text: 'done' },
        ]);
      } finally {
        await session.close();
      }

      // Negative control: without transformUpdate, vendor updates produce unhandled errors.
      const rawSession = await acpDriver(root).open({
        profile: acpProfile(root, 'acp-transform-raw', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const rawDeltas = await drain(await startText(rawSession));
        const unhandled = rawDeltas.filter(
          (delta) => delta.type === 'error' && delta.kind === 'unhandled',
        );
        expect(unhandled).toHaveLength(2);
      } finally {
        await rawSession.close();
      }
    }));

  test('onUpdate and onPermissionRequest handle post-settle events via event.respond and session.respond, isolating observer errors and enforcing pending bounds', () =>
    inScratch('acp-post-settle', async (root) => {
      const script = await writeCustomAcpAgent(
        root,
        'post-settle-agent',
        `
        for await (const line of createInterface({ input: process.stdin })) {
          const msg = JSON.parse(line);
          if (msg.method === undefined) {
            record('responses.jsonl', msg);
            continue;
          }
          if (msg.method === 'initialize') {
            write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, agentInfo: { name: 'bg', version: '1.0.0' } } });
          } else if (msg.method === 'session/load') {
            write({
              method: 'session/update',
              params: {
                sessionId: msg.params.sessionId,
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'replayed history' } },
              },
            });
            write({ id: msg.id, result: {} });
          } else if (msg.method === 'session/new') {
            write({ id: msg.id, result: { sessionId: 's-bg' } });
          } else if (msg.method === 'session/prompt') {
            write({
              method: 'session/update',
              params: {
                sessionId: 's-bg',
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'active' } },
              },
            });
            write({ id: msg.id, result: { stopReason: 'end_turn' } });
            if (process.env.MODE === 'cap') {
              for (let i = 1; i <= 257; i += 1) {
                write({
                  id: 'cap-' + i,
                  method: 'session/request_permission',
                  params: {
                    sessionId: 's-bg',
                    toolCall: { toolCallId: 'tc-' + i, title: 'Bg' },
                    options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }],
                  },
                });
              }
            } else {
              setTimeout(() => {
                write({
                  method: 'session/update',
                  params: {
                    sessionId: 's-bg',
                    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'post-settle-bg' } },
                  },
                });
                write({
                  id: 'bg-perm-1',
                  method: 'session/request_permission',
                  params: {
                    sessionId: 's-bg',
                    toolCall: { toolCallId: 'bg-tc-1', title: 'BgCmd', rawInput: { cmd: 'echo 1' } },
                    options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }],
                  },
                });
                write({
                  id: 'bg-perm-2',
                  method: 'session/request_permission',
                  params: {
                    sessionId: 's-bg',
                    toolCall: { toolCallId: 'interaction_bg', title: 'Pick' },
                    options: [
                      { optionId: 'opt-a', kind: 'allow_once', name: 'Option A' },
                      { optionId: 'opt-b', kind: 'allow_once', name: 'Option B' },
                    ],
                  },
                });
                // Duplicate id while bg-perm-2 is still pending must be refused -32603.
                write({
                  id: 'bg-perm-2',
                  method: 'session/request_permission',
                  params: {
                    sessionId: 's-bg',
                    toolCall: { toolCallId: 'interaction_bg_dup', title: 'Dup' },
                    options: [{ optionId: 'opt-a', kind: 'allow_once', name: 'Option A' }],
                  },
                });
                // Observer crash test: throws internal secret -> isolated as cancelled without leaking.
                write({
                  id: 'bg-perm-crash',
                  method: 'session/request_permission',
                  params: {
                    sessionId: 's-bg',
                    toolCall: { toolCallId: 'bg-tc-crash', title: 'Crash' },
                    options: [{ optionId: 'allow-c', kind: 'allow_once', name: 'Allow' }],
                  },
                });
              }, 20);
            }
          }
        }
        `,
      );

      // Verify session/load history replay does not trigger onUpdate before open() resolves.
      const replayEvents: AcpUpdateEvent[] = [];
      const replayDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
        onUpdate: (event) => replayEvents.push(event),
      });
      const loaded = await replayDriver.open({
        profile: acpProfile(root, 'acp-bg-load'),
        cwd: root,
        nativeThreadId: 'kept-bg',
      });
      await loaded.close();
      expect(replayEvents).toEqual([]);

      // Verify live active + post-settle onUpdate, event.respond, session.respond, duplicate guard, and error isolation.
      const updates: AcpUpdateEvent[] = [];
      const deferred = Promise.withResolvers<AcpPermissionRequestEvent>();
      const profile = acpProfile(root, 'acp-bg-live');
      const liveDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
        onUpdate(event) {
          updates.push(event);
          if (!event.duringActiveTurn) throw new Error('observer throw must be isolated');
        },
        async onPermissionRequest(event) {
          if (event.interactionId === 'bg-perm-1') {
            await event.respond({ kind: 'approve' });
            return;
          }
          if (event.interactionId === 'bg-perm-2') {
            deferred.resolve(event);
            return;
          }
          if (event.interactionId === 'bg-perm-crash') {
            throw new Error('SECRET_HOST_DETAIL_MUST_NOT_LEAK');
          }
        },
      });
      const session = await liveDriver.open({ profile, cwd: root });
      try {
        const deltas = await drain(await startText(session));
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        const secondPerm = await deferred.promise;
        expect(secondPerm.delta.type).toBe('request');
        // Wait for the duplicate id error and observer-crash cancellation BEFORE answering bg-perm-2,
        // proving both duplicate rejection and that the original pending request remains intact.
        await untilRecorded(
          join(profile.home, 'responses.jsonl'),
          (line) =>
            Reflect.get(Object(line), 'id') === 'bg-perm-2' &&
            Reflect.get(Object(line), 'error') !== undefined,
        );
        await untilRecorded(
          join(profile.home, 'responses.jsonl'),
          (line) => Reflect.get(Object(line), 'id') === 'bg-perm-crash',
        );
        await session.respond(secondPerm.interactionId, {
          kind: 'input',
          value: { optionId: 'opt-b' },
        });
        const responses = await untilRecorded(
          join(profile.home, 'responses.jsonl'),
          (line) =>
            Reflect.get(Object(line), 'id') === 'bg-perm-2' &&
            Reflect.get(Object(line), 'result') !== undefined,
        );
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'bg-perm-1',
          result: { outcome: { outcome: 'selected', optionId: 'allow-1' } },
        });
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'bg-perm-2',
          result: { outcome: { outcome: 'selected', optionId: 'opt-b' } },
        });
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'bg-perm-2',
          error: {
            code: -32603,
            message: expect.stringContaining(
              'Duplicate pending external ACP permission request',
            ),
          },
        });
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'bg-perm-crash',
          result: { outcome: { outcome: 'cancelled' } },
        });
        expect(JSON.stringify(responses)).not.toContain('SECRET_HOST_DETAIL_MUST_NOT_LEAK');
        expect(updates.some((event) => event.duringActiveTurn)).toBe(true);
        expect(
          updates.some(
            (event) =>
              !event.duringActiveTurn &&
              event.deltas.some(
                (delta) => delta.type === 'text' && delta.text === 'post-settle-bg',
              ),
          ),
        ).toBe(true);
      } finally {
        await session.close();
      }

      // Verify cap 256 guard on externalPending.
      const capProfile = acpProfile(root, 'acp-bg-cap', { MODE: 'cap' });
      const capDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
        onPermissionRequest: () => undefined,
      });
      const capSession = await capDriver.open({ profile: capProfile, cwd: root });
      try {
        await drain(await startText(capSession));
        const capResponses = await untilRecorded(
          join(capProfile.home, 'responses.jsonl'),
          (line) => Reflect.get(Object(line), 'id') === 'cap-257',
        );
        expect(capResponses).toContainEqual({
          jsonrpc: '2.0',
          id: 'cap-257',
          error: { code: -32603, message: expect.stringContaining('limit 256') },
        });
      } finally {
        await capSession.close();
      }
    }));

  test('onDisconnect fires only for unexpected post-open disconnects and never on close, abort, or open failure', () =>
    inScratch('acp-disconnect', async (root) => {
      const crashScript = await writeCustomAcpAgent(
        root,
        'crash-after-open',
        `
        for await (const line of createInterface({ input: process.stdin })) {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            if (process.env.FAIL_OPEN === '1') {
              write({ id: msg.id, result: { protocolVersion: 2, info: { name: 'v2' } } });
            } else {
              write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
            }
          } else if (msg.method === 'session/new') {
            write({ id: msg.id, result: { sessionId: 's-disc' } });
            if (process.env.CRASH_AFTER_MS) {
              setTimeout(() => process.exit(1), Number(process.env.CRASH_AFTER_MS));
            }
          }
        }
        `,
      );

      // 1. Unexpected crash after open fires onDisconnect (and throws inside callback are isolated).
      const disconnected = Promise.withResolvers<Error>();
      const crashDriver = createAcpDriver({
        executable: process.execPath,
        args: [crashScript],
        ambient: ambientIn(root),
        onDisconnect(error) {
          disconnected.resolve(error);
          throw new Error('disconnect observer error must be isolated');
        },
      });
      const crashing = await crashDriver.open({
        profile: acpProfile(root, 'acp-disc-crash', { CRASH_AFTER_MS: '40' }),
        cwd: root,
      });
      const disconnectError = await disconnected.promise;
      expect(disconnectError).toBeInstanceOf(Error);
      await crashing.close();

      // 2. Normal close, caller abort, and failed open do NOT fire onDisconnect.
      const spurious: Error[] = [];
      const quietDriver = createAcpDriver({
        executable: process.execPath,
        args: [crashScript],
        ambient: ambientIn(root),
        onDisconnect: (error) => spurious.push(error),
      });
      const normal = await quietDriver.open({
        profile: acpProfile(root, 'acp-disc-normal'),
        cwd: root,
      });
      await normal.close();

      const abortController = new AbortController();
      const aborted = await quietDriver.open({
        profile: acpProfile(root, 'acp-disc-abort'),
        cwd: root,
        signal: abortController.signal,
      });
      abortController.abort(new Error('caller-stop'));
      await Bun.sleep(60);
      await aborted.close();

      await expect(
        quietDriver.open({
          profile: acpProfile(root, 'acp-disc-open-fail', { FAIL_OPEN: '1' }),
          cwd: root,
        }),
      ).rejects.toThrow(/protocol v2/i);
      await Bun.sleep(40);
      expect(spurious).toEqual([]);
    }));

  test('watchPromptOutcome runs before session/prompt and can override end_turn into failed with errorKind and threadDisposition', () =>
    inScratch('acp-watch-outcome', async (root) => {
      const events: string[] = [];
      const scenario = await writeScenario(root, [
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'masked' },
        }),
        {
          do: 'emit',
          record: {
            answerPrompt: {
              stopReason: 'end_turn',
              usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            },
          },
        },
      ]);
      const profile = acpProfile(root, 'acp-watch-broken', { FAKE_ENGINE_SCENARIO: scenario });
      const brokenDriver = acpDriver(root, {
        async watchPromptOutcome(ctx) {
          events.push(`before:${ctx.turnId}:${ctx.generation}`);
          // Prove session/prompt has NOT been written yet when watchPromptOutcome starts.
          expect(await recordedLines(join(profile.home, 'prompts.jsonl'))).toEqual([]);
          return (result) => {
            events.push(`after:${result.stopReason}`);
            return {
              outcome: 'failed',
              errorKind: 'rateLimited',
              message: 'QUOTA_EXHAUSTED hidden behind end_turn',
              threadDisposition: 'broken',
            };
          };
        },
      });
      const session = await brokenDriver.open({ profile, cwd: root });
      try {
        const deltas = await drain(await startText(session));
        for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
        expect(events).toEqual(['before:t:1', 'after:end_turn']);
        expect(deltas.find((delta) => delta.type === 'usage')).toMatchObject({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        });
        expect(deltas.find((delta) => delta.type === 'error')).toMatchObject({
          kind: 'rateLimited',
          message: 'QUOTA_EXHAUSTED hidden behind end_turn',
        });
        expect(deltas.at(-1)).toMatchObject({
          type: 'turn-end',
          outcome: 'failed',
          threadDisposition: 'broken',
        });
      } finally {
        await session.close();
      }

      // Reusable disposition override AND clean pass-through when returning undefined.
      const reusableDriver = acpDriver(root, {
        watchPromptOutcome: () => () => ({
          errorKind: 'restartRecommended',
          message: 'Transient 502 masked behind end_turn',
          threadDisposition: 'reusable',
        }),
      });
      const reusableSession = await reusableDriver.open({
        profile: acpProfile(root, 'acp-watch-reusable', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drain(await startText(reusableSession));
        expect(deltas.at(-1)).toMatchObject({
          type: 'turn-end',
          outcome: 'failed',
          threadDisposition: 'reusable',
        });
      } finally {
        await reusableSession.close();
      }

      const passthroughSession = await acpDriver(root, {
        watchPromptOutcome: () => () => undefined,
      }).open({
        profile: acpProfile(root, 'acp-watch-pass', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drain(await startText(passthroughSession));
        expect(deltas.filter((delta) => delta.type === 'error')).toEqual([]);
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        const end = deltas.at(-1);
        expect(
          end?.type === 'turn-end' ? end.threadDisposition : 'unexpected',
        ).toBeUndefined();
      } finally {
        await passthroughSession.close();
      }
    }));

  test('request_permission exposes option name and _meta in delta.input, supports allow_always and input optionId, and rejects updatedInput fail-closed', () =>
    inScratch('acp-permission-rich', async (root) => {
      const scenario = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            jsonrpc: '2.0',
            id: 'perm-question',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: {
                toolCallId: 'interaction_42',
                title: 'Choose approach',
                rawInput: { path: 'src/index.ts' },
              },
              options: [
                {
                  optionId: 'choice-1',
                  kind: 'allow_once',
                  name: 'Keep minimal',
                  _meta: { 'security.warning': { title: 'Safe' } },
                },
                {
                  optionId: 'choice-2',
                  kind: 'allow_always',
                  name: 'Allow always',
                  _meta: { 'security.warning': { message: 'Persists for session' } },
                },
              ],
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            jsonrpc: '2.0',
            id: 'perm-session',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: { toolCallId: 'tc-session', title: 'Run test' },
              options: [
                { optionId: 'once', kind: 'allow_once', name: 'Once' },
                { optionId: 'always', kind: 'allow_always', name: 'Always' },
                { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
              ],
            },
          },
        },
        { do: 'expect', type: 'response' },
        { do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } },
      ]);
      const profile = acpProfile(root, 'acp-permission-rich', {
        FAKE_ENGINE_SCENARIO: scenario,
      });
      const session = await acpDriver(root).open({ profile, cwd: root });
      try {
        const turn = await startText(session);
        const deltas: ExecutorDelta[] = [];
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          deltas.push(delta);
          if (delta.type === 'request' && delta.interactionId === 'perm-question') {
            expect(delta.prompt).toBe('Choose approach');
            expect(delta.input).toEqual({
              path: 'src/index.ts',
              options: [
                {
                  optionId: 'choice-1',
                  kind: 'allow_once',
                  name: 'Keep minimal',
                  _meta: { 'security.warning': { title: 'Safe' } },
                },
                {
                  optionId: 'choice-2',
                  kind: 'allow_always',
                  name: 'Allow always',
                  _meta: { 'security.warning': { message: 'Persists for session' } },
                },
              ],
            });
            // Fail-closed checks must throw TypeError WITHOUT consuming the pending request.
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'approve',
                updatedInput: { path: 'tampered.ts' },
              }),
            ).rejects.toThrow(TypeError);
            await expect(
              turn.respond(delta.interactionId, { kind: 'input', value: 'choice-2' }),
            ).rejects.toThrow(TypeError);
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'input',
                value: { optionId: 'missing' },
              }),
            ).rejects.toThrow(TypeError);
            await turn.respond(delta.interactionId, {
              kind: 'input',
              value: { optionId: 'choice-2' },
            });
          } else if (delta.type === 'request' && delta.interactionId === 'perm-session') {
            await turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' });
          }
        }
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        const responses = await readJsonLines(join(profile.home, 'responses.jsonl'));
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'perm-question',
          result: { outcome: { outcome: 'selected', optionId: 'choice-2' } },
        });
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'perm-session',
          result: { outcome: { outcome: 'selected', optionId: 'always' } },
        });
      } finally {
        await session.close();
      }
    }));

  test('usage preserves cachedWriteTokens, thoughtTokens, totalTokens and usageInputIncludesCachedRead false adds cachedReadTokens to inputTokens', () =>
    inScratch('acp-usage-full', async (root) => {
      const scenario = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            answerPrompt: {
              stopReason: 'end_turn',
              usage: {
                inputTokens: 1000,
                outputTokens: 200,
                cachedReadTokens: 400,
                cachedWriteTokens: 50,
                thoughtTokens: 120,
                totalTokens: 1600,
              },
            },
          },
        },
      ]);
      const includedSession = await acpDriver(root).open({
        profile: acpProfile(root, 'acp-usage-default', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drain(await startText(includedSession));
        const usage = deltas.find((delta) => delta.type === 'usage');
        expect(usage).toMatchObject({
          type: 'usage',
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 400,
          cacheCreationInputTokens: 50,
          thinkingTokens: 120,
          totalTokens: 1600,
        });
      } finally {
        await includedSession.close();
      }

      const excludedSession = await acpDriver(root, {
        usageInputIncludesCachedRead: false,
      }).open({
        profile: acpProfile(root, 'acp-usage-excluded', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drain(await startText(excludedSession));
        const usage = deltas.find((delta) => delta.type === 'usage');
        expect(usage).toMatchObject({
          type: 'usage',
          inputTokens: 1400,
          outputTokens: 200,
          cachedInputTokens: 400,
          cacheCreationInputTokens: 50,
          thinkingTokens: 120,
          totalTokens: 1600,
        });
      } finally {
        await excludedSession.close();
      }
    }));

  test('steerMode prompt steers an active turn across session/prompt generations summing usage, while steerMode none refuses steerTurn with TypeError', () =>
    inScratch('acp-steer-prompt', async (root) => {
      const script = await writeCustomAcpAgent(
        root,
        'steer-agent',
        `
        let firstPromptId;
        for await (const line of createInterface({ input: process.stdin })) {
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
          } else if (msg.method === 'session/new') {
            write({ id: msg.id, result: { sessionId: 's-steer' } });
          } else if (msg.method === 'session/prompt') {
            record('prompts.jsonl', msg.params.prompt);
            if (firstPromptId === undefined) {
              firstPromptId = msg.id;
              write({
                method: 'session/update',
                params: {
                  sessionId: 's-steer',
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first ' } },
                },
              });
            } else {
              // Answer first prompt with end_turn right away, then continue streaming under second prompt.
              write({
                id: firstPromptId,
                result: {
                  stopReason: 'end_turn',
                  usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    cachedReadTokens: 10,
                    cachedWriteTokens: 5,
                    thoughtTokens: 8,
                    totalTokens: 130,
                  },
                },
              });
              write({
                method: 'session/update',
                params: {
                  sessionId: 's-steer',
                  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'steered' } },
                },
              });
              write({
                id: msg.id,
                result: {
                  stopReason: 'end_turn',
                  usage: {
                    inputTokens: 200,
                    outputTokens: 40,
                    cachedReadTokens: 30,
                    cachedWriteTokens: 7,
                    thoughtTokens: 12,
                    totalTokens: 270,
                  },
                },
              });
            }
          }
        }
        `,
      );

      // Default steerMode ('none') refuses steerTurn with TypeError.
      const noSteerDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
      });
      expect(noSteerDriver.capabilities.steer).toBe(false);
      const noSteerSession = await noSteerDriver.open({
        profile: acpProfile(root, 'acp-steer-none'),
        cwd: root,
      });
      try {
        await expect(
          noSteerSession.steerTurn({ input: [{ type: 'text', text: 'nope' }] }),
        ).rejects.toThrow(TypeError);
      } finally {
        await noSteerSession.close();
      }

      // steerMode: 'prompt' keeps turn.channel open across first prompt end_turn and sums usage.
      const watchedGenerations: number[] = [];
      const steerDriver = createAcpDriver({
        executable: process.execPath,
        args: [script],
        ambient: ambientIn(root),
        steerMode: 'prompt',
        watchPromptOutcome: (ctx) => {
          watchedGenerations.push(ctx.generation);
          return () => undefined;
        },
      });
      expect(steerDriver.capabilities.steer).toBe(true);
      const profile = acpProfile(root, 'acp-steer-ok');
      const session = await steerDriver.open({ profile, cwd: root });
      try {
        const turn = await startText(session);
        const deltas: ExecutorDelta[] = [];
        let steered = false;
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          deltas.push(delta);
          if (!steered && delta.type === 'text' && delta.text === 'first ') {
            steered = true;
            const receipt = await session.steerTurn({
              input: [{ type: 'text', text: 'change direction' }],
            });
            expect(receipt).toEqual({ turnId: 't' });
          }
        }
        expect(watchedGenerations).toEqual([1, 2]);
        expect(
          deltas.filter((delta) => delta.type === 'text').map((delta) => delta.text),
        ).toEqual(['first ', 'steered']);
        expect(deltas.filter((delta) => delta.type === 'usage')).toMatchObject([
          {
            inputTokens: 300,
            outputTokens: 60,
            cachedInputTokens: 40,
            cacheCreationInputTokens: 12,
            thinkingTokens: 20,
            totalTokens: 400,
          },
        ]);
        expect(deltas.filter((delta) => delta.type === 'turn-end')).toMatchObject([
          { outcome: 'completed' },
        ]);
        expect(await readJsonLines(join(profile.home, 'prompts.jsonl'))).toEqual([
          [{ type: 'text', text: 'go' }],
          [{ type: 'text', text: 'change direction' }],
        ]);
      } finally {
        await session.close();
      }
    }));

  test('per-open model, thoughtLevel and mode override driver defaults on session/new and session/resume, falling back to session/set_model', () =>
    inScratch('acp-open-overrides', async (root) => {
      const profile = acpProfile(root, 'acp-open-overrides', { FAKE_ACP_RESUME: '1' });
      const driver = acpDriver(root, {
        model: 'large',
        thoughtLevel: 'high',
        mode: 'default',
      });
      const fresh = await driver.open({
        profile,
        cwd: root,
        model: 'small',
        thoughtLevel: 'low',
        mode: 'plan',
      });
      await fresh.close();
      const resumed = await driver.open({
        profile,
        cwd: root,
        nativeThreadId: 'kept',
        model: 'small',
        thoughtLevel: 'low',
        mode: 'plan',
      });
      await resumed.close();

      const methods = await readMethodLines(join(profile.home, 'methods.jsonl'));
      const sets = methods
        .filter((entry) => entry.method === 'session/set_config_option')
        .map((entry) => [entry.params?.configId, entry.params?.value]);
      expect(sets).toEqual([
        ['model', 'small'],
        ['thought', 'low'],
        ['mode', 'plan'],
        ['model', 'small'],
        ['thought', 'low'],
        ['mode', 'plan'],
      ]);

      // Fallback to session/set_model when agent advertises `models` without a `model` configOption.
      const legacyModelScript = await writeCustomAcpAgent(
        root,
        'set-model-agent',
        `
        for await (const line of createInterface({ input: process.stdin })) {
          const msg = JSON.parse(line);
          record('methods.jsonl', { method: msg.method, params: msg.params });
          if (msg.method === 'initialize') {
            write({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } } });
          } else if (msg.method === 'session/new') {
            write({
              id: msg.id,
              result: {
                sessionId: 'm-1',
                models: {
                  currentModelId: 'alpha',
                  availableModels: [{ modelId: 'alpha' }, { modelId: 'beta' }],
                },
              },
            });
          } else if (msg.method === 'session/resume') {
            write({
              id: msg.id,
              result: {
                models: {
                  currentModelId: 'alpha',
                  availableModels: [{ modelId: 'alpha' }, { modelId: 'beta' }],
                },
              },
            });
          } else if (msg.method === 'session/set_model') {
            write({ id: msg.id, result: {} });
          }
        }
        `,
      );
      const legacyProfile = acpProfile(root, 'acp-set-model');
      const legacyDriver = createAcpDriver({
        executable: process.execPath,
        args: [legacyModelScript],
        ambient: ambientIn(root),
      });
      const legacyFresh = await legacyDriver.open({
        profile: legacyProfile,
        cwd: root,
        model: 'beta',
      });
      await legacyFresh.close();
      const legacyResumed = await legacyDriver.open({
        profile: legacyProfile,
        cwd: root,
        nativeThreadId: 'm-1',
        model: 'beta',
      });
      await legacyResumed.close();
      const legacyMethods = await readMethodLines(join(legacyProfile.home, 'methods.jsonl'));
      expect(
        legacyMethods
          .filter((entry) => entry.method === 'session/set_model')
          .map((e) => e.params),
      ).toEqual([
        { sessionId: 'm-1', modelId: 'beta' },
        { sessionId: 'm-1', modelId: 'beta' },
      ]);
      // Negative control: unlisted model is refused even on session/set_model fallback.
      await expect(
        legacyDriver.open({ profile: legacyProfile, cwd: root, model: 'gamma' }),
      ).rejects.toThrow('has no value gamma (offered: alpha, beta)');
    }));

  test('driver capabilities reflect sessionApproval, structuredInput, steerMode, post-settle hooks, and resolveFile', () => {
    const basic = createAcpDriver({ executable: 'acp-agent' });
    expect(basic.capabilities).toEqual({
      runtimePolicyEnforcement: 'client-boundary',
      sessionApproval: true,
      interruptOnDeny: false,
      updatedToolInput: false,
      structuredInput: true,
      steer: false,
      fork: false,
      revert: false,
      compact: false,
      injectItems: false,
      backgroundWorkOutlivesTurn: false,
      multiThreadPerProcess: false,
      images: false,
      planLimits: 'none',
    });

    const full = createAcpDriver({
      executable: 'acp-agent',
      steerMode: 'prompt',
      onUpdate: () => undefined,
      resolveFile: async () => new Uint8Array(),
    });
    expect(full.capabilities.steer).toBe(true);
    expect(full.capabilities.backgroundWorkOutlivesTurn).toBe(true);
    expect(full.capabilities.images).toBe(true);

    const permOnly = createAcpDriver({
      executable: 'acp-agent',
      onPermissionRequest: () => undefined,
    });
    expect(permOnly.capabilities.backgroundWorkOutlivesTurn).toBe(true);
  });

  test('throwing stdoutLineFilter fails the session fail-closed', async () => {
    await inScratch('acp-filter-throw', async (root) => {
      const home = join(root, 'home');
      const pidFile = trackedPidFile(root, 'acp-filter-throw.pid');
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        ambient: ambientIn(root),
        stdoutLineFilter: () => {
          throw new Error('filter exploded');
        },
      });
      await expect(
        driver.open({
          profile: {
            profileId: 'p-filter-throw',
            engine: 'acp',
            home,
            env: { FAKE_ACP_HOME: home, FAKE_ENGINE_PID_FILE: pidFile },
          },
          cwd: root,
        }),
      ).rejects.toThrow(/filter exploded/);
    });
  });
});
