/**
 * ACP driver regressions: a long multi-step turn, refusals at open, how a refusal is
 * classified, stream errors that keep their type, empty ids, and close.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { closeRequestTimeoutMs } from '../../src/agent-executor/acp/v1-connect';
import { createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
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
  trackedPidFile,
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
