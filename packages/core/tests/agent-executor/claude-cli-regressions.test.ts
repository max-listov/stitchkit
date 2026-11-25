/**
 * Claude CLI driver regressions: the transcript path and its uuid match, open refusals that
 * leave no listener behind, `auth status` expiry and plan windows, and records with empty
 * tool ids and names, classified directly and end to end.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  classifyClaudeRecord,
  newClaudeTurnState,
} from '../../src/agent-executor/claude/classify';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { claudePlanWindows } from '../../src/agent-executor/claude/limits';
import {
  claudeTranscriptHasUuid,
  claudeTranscriptPath,
} from '../../src/agent-executor/claude/transcript';
import { ExecutorDeltaSchema } from '../../src/agent-executor/vocabulary';
import {
  ambientIn,
  countedSignal,
  drainApproving,
  FAKE_CLAUDE,
  inScratch,
  readJsonLines,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

function claudeDriver(root: string) {
  return createClaudeCliDriver({
    executable: process.execPath,
    prefixArgs: [FAKE_CLAUDE],
    ambient: ambientIn(root),
  });
}

function claudeProfile(root: string, label: string, env: Record<string, string> = {}) {
  return {
    profileId: 'p',
    engine: 'claude-cli' as const,
    home: join(root, 'home'),
    env: { FAKE_ENGINE_PID_FILE: trackedPidFile(root, label), ...env },
  };
}

describe('Claude transcript', () => {
  test.each(['../escape', 'nested/id', '', 'a\\b', '..'])(
    'a session id %p that could leave the projects directory is refused',
    (sessionId) => {
      expect(() =>
        claudeTranscriptPath({ home: '/home/someone', cwd: '/work', sessionId }),
      ).toThrow(TypeError);
    },
  );

  test('a uuid is found only as the uuid field, not as text inside a message', () =>
    inScratch('transcript-uuid', async (root) => {
      const path = claudeTranscriptPath({
        home: join(root, 'home'),
        cwd: join(root, 'work'),
        sessionId: 'valid_session-1',
      });
      await Bun.write(
        path,
        [
          JSON.stringify({
            type: 'user',
            uuid: 'other-id',
            message: { text: 'contains target-uuid in text' },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'assistant-only-uuid',
            message: { text: 'assistant reply' },
          }),
          JSON.stringify({ type: 'user', uuid: 'target-uuid', message: { text: 'real' } }),
        ].join('\n'),
      );
      expect(await claudeTranscriptHasUuid(path, 'target-uuid')).toBe(true);
      expect(await claudeTranscriptHasUuid(path, 'contains target-uuid')).toBe(false);
      expect(await claudeTranscriptHasUuid(path, 'assistant-only-uuid')).toBe(false);
    }));
});

describe('Claude CLI open', () => {
  test('a start that throws leaves no abort listener on the caller signal', () =>
    inScratch('claude-start-throws', async (root) => {
      const counted = countedSignal();
      const driver = createClaudeCliDriver({ executable: '', ambient: ambientIn(root) });
      await expect(
        driver.open({
          profile: claudeProfile(root, 'claude-bad'),
          cwd: root,
          signal: counted.signal,
        }),
      ).rejects.toThrow();
      expect(counted.listeners()).toBe(0);
    }));

  test('an abort while the transcript is checked rejects open with its reason', () =>
    inScratch('claude-abort-open', async (root) => {
      const aborted = new AbortController();
      const opening = claudeDriver(root).open({
        profile: claudeProfile(root, 'claude-aborted'),
        cwd: root,
        nativeThreadId: 'resume-id',
        signal: aborted.signal,
      });
      aborted.abort(new Error('claude-aborted-mid-open'));
      await expect(opening).rejects.toThrow('claude-aborted-mid-open');
    }));
});

describe('Claude status and plan windows', () => {
  const statusOf = (root: string, authStatus: Record<string, unknown>) =>
    claudeDriver(root).status(
      claudeProfile(root, 'claude-status', {
        FAKE_CLAUDE_AUTH_STATUS: JSON.stringify(authStatus),
      }),
    );

  test.each([
    ['seconds in the future', () => Math.floor(Date.now() / 1000) + 3600],
    ['seconds in the past', () => Math.floor(Date.now() / 1000) - 3600],
    ['milliseconds in the future', () => Date.now() + 3_600_000],
    ['milliseconds in the past', () => Date.now() - 3_600_000],
  ])('an epoch loginExpiresAt (%s) is not a form the CLI writes: unknown', (_, at) =>
    inScratch('claude-expiry-epoch', async (root) => {
      const status = await statusOf(root, {
        loggedIn: true,
        authMethod: 'claude.ai',
        loginExpiresAt: at(),
      });
      expect(status.login.state).toBe('unknown');
    }),
  );

  test('an ISO loginExpiresAt in the future is signed-in', () =>
    inScratch('claude-expiry-iso', async (root) => {
      const loginExpiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const status = await statusOf(root, {
        loggedIn: true,
        authMethod: 'claude.ai',
        loginExpiresAt,
      });
      expect(status.login.state).toBe('signed-in');
    }));

  test('an unreadable loginExpiresAt is unknown', () =>
    inScratch('claude-expiry-invalid', async (root) => {
      const status = await statusOf(root, {
        loggedIn: true,
        authMethod: 'claude.ai',
        loginExpiresAt: 'not-a-valid-date',
      });
      expect(status.login.state).toBe('unknown');
    }));

  test('a Claude plan window whose resetsAt is out of the Date range keeps its usage', () => {
    expect(
      claudePlanWindows({
        unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: 1e16 } },
      }),
    ).toEqual([{ name: 'seven_day', usedPercent: 50 }]);
  });
});

describe('Claude records with empty tool ids and names', () => {
  test('tool_use blocks with empty or null ids and names get positional ids and the unknown name', () => {
    const verdict = classifyClaudeRecord(
      {
        type: 'assistant',
        message: {
          id: 'msg-1',
          content: [
            { type: 'tool_use', id: '', name: '', input: { a: 1, b: undefined } },
            {
              type: 'tool_use',
              id: null,
              name: null,
              input: { ok: true, skipped: undefined },
            },
          ],
        },
      },
      newClaudeTurnState('t-direct'),
    );
    expect(verdict.kind).toBe('deltas');
    const deltas = verdict.kind === 'deltas' ? verdict.deltas : [];
    for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
    expect(deltas).toMatchObject([
      { type: 'tool-call', callId: 'msg-1:0', toolName: 'unknown', input: { a: 1 } },
      { type: 'tool-call', callId: 'msg-1:1', toolName: 'unknown', input: { ok: true } },
    ]);
  });

  test('tool_result blocks with empty or null ids get positional ids and drop undefined values', () => {
    const verdict = classifyClaudeRecord(
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: '', content: { r: 1, u: undefined } },
            { type: 'tool_result', tool_use_id: null, content: { r: 2, u: undefined } },
          ],
        },
      },
      newClaudeTurnState('t-direct'),
    );
    expect(verdict.kind).toBe('deltas');
    const deltas = verdict.kind === 'deltas' ? verdict.deltas : [];
    for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
    expect(deltas).toMatchObject([
      { type: 'tool-result', callId: 'result-0', toolName: 'unknown', output: { r: 1 } },
      { type: 'tool-result', callId: 'result-1', toolName: 'unknown', output: { r: 2 } },
    ]);
  });

  test('a can_use_tool request with an empty name and id names the tool "tool" and carries no callId', () => {
    const verdict = classifyClaudeRecord(
      {
        type: 'control_request',
        request_id: 'req-direct',
        request: { subtype: 'can_use_tool', tool_name: '', tool_use_id: '', input: { x: 1 } },
      },
      newClaudeTurnState('t-direct'),
    );
    expect(verdict.kind).toBe('request');
    if (verdict.kind !== 'request') return;
    ExecutorDeltaSchema.parse(verdict.delta);
    expect(verdict.delta.toolName).toBe('tool');
    expect(verdict.delta.callId).toBeUndefined();
  });

  test('the CLI driver turns such records into deltas that pass ExecutorDeltaSchema', () =>
    inScratch('claude-empty-ids', async (root) => {
      const scenario = await writeScenario(root, [
        { do: 'expect', type: 'user' },
        {
          do: 'emit',
          record: {
            type: 'assistant',
            message: {
              id: 'm1',
              content: [{ type: 'tool_use', id: '', name: '', input: {} }],
            },
          },
        },
        {
          do: 'emit',
          record: {
            type: 'control_request',
            request_id: 'req-empty',
            request: { subtype: 'can_use_tool', tool_name: '', tool_use_id: '', input: {} },
          },
        },
        { do: 'expect', type: 'control_response', subtype: 'success' },
        {
          do: 'emit',
          record: { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
        },
      ]);
      const session = await claudeDriver(root).open({
        profile: claudeProfile(root, 'claude-empty', { FAKE_ENGINE_SCENARIO: scenario }),
        cwd: root,
      });
      try {
        const deltas = await drainApproving(
          await session.startTurn({
            turnId: 't-claude',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'hi' }],
          }),
        );
        for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
        expect(deltas.some((delta) => delta.type === 'tool-call')).toBe(true);
        expect(deltas.some((delta) => delta.type === 'request')).toBe(true);
      } finally {
        await session.close();
      }
    }));
});

describe('Claude CLI control requests', () => {
  test('a control_request of a subtype the driver does not know is answered with an error, and the turn goes on', () =>
    inScratch('claude-unknown-control', async (root) => {
      const scenario = await writeScenario(root, [
        { do: 'expect', type: 'user' },
        {
          do: 'emit',
          record: {
            type: 'control_request',
            request_id: 'req-vendor',
            request: { subtype: 'vendor_future_request' },
          },
        },
        { do: 'expect', type: 'control_response', subtype: 'error' },
        {
          do: 'emit',
          record: { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
        },
      ]);
      const profile = claudeProfile(root, 'claude-unknown-control', {
        FAKE_ENGINE_SCENARIO: scenario,
      });
      const session = await claudeDriver(root).open({ profile, cwd: root });
      try {
        const turn = await session.startTurn({
          turnId: 't-unknown-control',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'hi' }],
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deltas = await Promise.race([
          drainApproving(turn),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('the CLI was left waiting for an answer')),
              3_000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        expect(deltas).toContainEqual(
          expect.objectContaining({
            type: 'error',
            kind: 'unhandled',
            raw: { source: 'claude', type: 'control_request/vendor_future_request' },
          }),
        );
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(await readJsonLines(join(profile.home, 'stdin.jsonl'))).toContainEqual({
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: 'req-vendor',
            error: 'Claude control request vendor_future_request is not known to this driver',
          },
        });
      } finally {
        await session.close();
      }
    }));
});
