/**
 * The engine's requests outside the consumer's reach: one sent between turns is refused to the
 * engine at once, so no engine waits on an answer nobody can give; one whose parameters do not
 * parse is refused and never closed on a stream that did not offer it.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { createCodexDriver } from '../../src/agent-executor/codex/driver';
import type { AgentEngineSession } from '../../src/agent-executor/engine';
import {
  answerEngineRequest,
  holdEngineRequest,
} from '../../src/agent-executor/engine-requests';
import { createTurnDeltaChannel } from '../../src/agent-executor/session-primitives';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import {
  ambientIn,
  drain,
  FAKE_ACP,
  FAKE_CLAUDE,
  FAKE_CODEX,
  inScratch,
  trackedPidFile,
  untilRecorded,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

type Json = Extract<FakeEngineStep, { do: 'emit' }>['record'];
const emit = (record: Json): FakeEngineStep => ({ do: 'emit', record });

function startTurn(session: AgentEngineSession) {
  return session.startTurn({
    turnId: 't',
    clientId: crypto.randomUUID(),
    input: [{ type: 'text', text: 'go' }],
  });
}

/** A field-by-field match on one recorded line. */
const has =
  (fields: Record<string, unknown>) =>
  (line: unknown): boolean => {
    try {
      expect(line).toMatchObject(fields);
      return true;
    } catch {
      return false;
    }
  };

/** Open `driver`'s session on a fake playing `steps`, run one turn to its end, and close. */
async function oneTurn(
  root: string,
  open: (env: Record<string, string>) => Promise<AgentEngineSession>,
  steps: FakeEngineStep[],
  whileOpen: (deltas: Awaited<ReturnType<typeof drain>>) => Promise<void>,
): Promise<void> {
  const session = await open({
    FAKE_ENGINE_SCENARIO: await writeScenario(root, steps),
    FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'engine'),
  });
  try {
    await whileOpen(await drain(await startTurn(session)));
  } finally {
    await session.close();
  }
}

describe('a request the engine sends between turns', () => {
  test('Claude CLI: is denied at once on stdin', () =>
    inScratch('claude-between', async (root) => {
      const home = join(root, 'home');
      const driver = createClaudeCliDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CLAUDE],
        ambient: ambientIn(root),
      });
      await oneTurn(
        root,
        (env) =>
          driver.open({
            profile: { profileId: 'p', engine: 'claude-cli', home, env },
            cwd: root,
          }),
        [
          emit({ type: 'system', subtype: 'init', session_id: 's', model: 'fake' }),
          { do: 'expect', type: 'user' },
          emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            result: '',
            session_id: 's',
          }),
          emit({
            type: 'control_request',
            request_id: 'req-between',
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Write',
              tool_use_id: 'call-between',
              input: { file_path: 'x' },
            },
          }),
        ],
        async (deltas) => {
          expect(deltas.at(-1)).toMatchObject({ type: 'turn-end' });
          await untilRecorded(
            join(home, 'stdin.jsonl'),
            has({
              type: 'control_response',
              response: { request_id: 'req-between', response: { behavior: 'deny' } },
            }),
          );
        },
      );
    }));

  test('Codex: is refused at once with -32601', () =>
    inScratch('codex-between', async (root) => {
      const home = join(root, 'home');
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: ambientIn(root),
      });
      await oneTurn(
        root,
        (env) =>
          driver.open({ profile: { profileId: 'p', engine: 'codex', home, env }, cwd: root }),
        [
          emit({
            method: 'turn/completed',
            params: {
              threadId: 'fake-thread',
              turn: { id: 'fake-turn', status: 'completed' },
            },
          }),
          emit({
            id: 'between-1',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'call-between', command: 'touch x' },
          }),
        ],
        async (deltas) => {
          expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
          await untilRecorded(
            join(home, 'responses.jsonl'),
            has({ id: 'between-1', error: { code: -32601 } }),
          );
        },
      );
    }));

  test('ACP: is refused at once with -32601', () =>
    inScratch('acp-between', async (root) => {
      const home = join(root, 'home');
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        ambient: ambientIn(root),
      });
      await oneTurn(
        root,
        (env) =>
          driver.open({
            profile: {
              profileId: 'p',
              engine: 'acp',
              home,
              env: { ...env, FAKE_ACP_HOME: home },
            },
            cwd: root,
          }),
        [
          emit({ answerPrompt: { stopReason: 'end_turn' } }),
          emit({
            jsonrpc: '2.0',
            id: 'between-1',
            method: 'session/request_permission',
            params: {
              sessionId: 'fake-session',
              toolCall: { toolCallId: 'call-between' },
              options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
            },
          }),
        ],
        async (deltas) => {
          expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
          await untilRecorded(
            join(home, 'responses.jsonl'),
            has({ id: 'between-1', error: { code: -32601 } }),
          );
        },
      );
    }));
});

describe('a request whose parameters do not parse', () => {
  test('is refused to the engine and never closed on the stream that did not offer it', () =>
    inScratch('codex-unparsed-request', async (root) => {
      const home = join(root, 'home');
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: ambientIn(root),
      });
      await oneTurn(
        root,
        (env) =>
          driver.open({ profile: { profileId: 'p', engine: 'codex', home, env }, cwd: root }),
        [
          // No `itemId`: the approval cannot be read, so it cannot be offered.
          emit({
            id: 'unparsed-1',
            method: 'item/commandExecution/requestApproval',
            params: { command: 'touch x' },
          }),
          { do: 'expect', type: 'response' },
          emit({
            method: 'turn/completed',
            params: {
              threadId: 'fake-thread',
              turn: { id: 'fake-turn', status: 'completed' },
            },
          }),
        ],
        async (deltas) => {
          await untilRecorded(
            join(home, 'responses.jsonl'),
            has({ id: 'unparsed-1', error: { code: -32603 } }),
          );
          expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
          expect(
            deltas.filter(
              (delta) =>
                (delta.type === 'request' || delta.type === 'request-resolved') &&
                delta.interactionId === 'unparsed-1',
            ),
          ).toEqual([]);
        },
      );
    }));
});

describe('an answer the engine could not take', () => {
  test('leaves its request held and open to another answer, and closes nothing on the stream', () => {
    const turn = {
      state: { turnId: 't', interruptRequested: false },
      channel: createTurnDeltaChannel(),
      pending: new Map(),
    };
    let writable = false;
    const written: string[] = [];
    holdEngineRequest(turn, {
      interactionId: 'req-1',
      detail: {},
      answeredBy: { source: 'claude', type: 'control_response' },
      delta: () => ({
        type: 'request',
        turnId: 't',
        itemId: 'request:req-1',
        raw: { source: 'claude', type: 'control_request' },
        interactionId: 'req-1',
        kind: 'approval',
      }),
      refusal: 'deny',
      resolve(answer: string) {
        // As Claude CLI's stdin refuses a line once it is closed or full.
        if (!writable) throw new RangeError('Engine stdin queue exceeded');
        written.push(answer);
      },
    });
    expect(() => answerEngineRequest(turn, 'req-1', 'allow')).toThrow(RangeError);
    expect(turn.pending.has('req-1')).toBe(true);
    expect(turn.channel.getSnapshot().queuedItems).toBe(1);
    writable = true;
    expect(answerEngineRequest(turn, 'req-1', 'allow')).toBe(true);
    expect(written).toEqual(['allow']);
    expect(turn.pending.has('req-1')).toBe(false);
    expect(turn.channel.getSnapshot().queuedItems).toBe(2);
  });
});
