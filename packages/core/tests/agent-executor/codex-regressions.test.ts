/**
 * Codex driver regressions: a resumed thread keeps its policy, items classify by kind,
 * requests the interrupt answers or races, an honest `raw.type`, and empty ids.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexDriver } from '../../src/agent-executor/codex/driver';
import { codexPlanWindows } from '../../src/agent-executor/codex/limits';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import { type ExecutorDelta, ExecutorDeltaSchema } from '../../src/agent-executor/vocabulary';
import {
  ambientIn,
  drain,
  drainApproving,
  FAKE_CODEX,
  inScratch,
  readJsonLines,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

type CodexDriverOptions = Omit<
  Parameters<typeof createCodexDriver>[0],
  'executable' | 'prefixArgs' | 'ambient'
>;

function codexDriver(root: string, options: CodexDriverOptions = {}) {
  return createCodexDriver({
    executable: process.execPath,
    prefixArgs: [FAKE_CODEX],
    ambient: ambientIn(root),
    ...options,
  });
}

async function codexSession(
  root: string,
  label: string,
  steps: FakeEngineStep[],
  open: { options?: CodexDriverOptions; nativeThreadId?: string } = {},
) {
  const home = join(root, `home-${label}`);
  const session = await codexDriver(root, open.options).open({
    profile: {
      profileId: label,
      engine: 'codex',
      home,
      env: {
        FAKE_ENGINE_SCENARIO: await writeScenario(root, steps),
        FAKE_ENGINE_PID_FILE: trackedPidFile(root, label),
      },
    },
    cwd: root,
    ...(open.nativeThreadId !== undefined && { nativeThreadId: open.nativeThreadId }),
  });
  return { session, home };
}

const turnCompleted = (status: 'completed' | 'interrupted'): FakeEngineStep => ({
  do: 'emit',
  record: {
    method: 'turn/completed',
    params: { threadId: 'fake-thread', turn: { id: 'fake-turn', status, items: [] } },
  },
});

describe('Codex driver: a resumed thread whose turn calls tools and fails rate-limited', () => {
  let resumed: unknown;
  let cwd = '';
  let deltas: ExecutorDelta[] = [];

  beforeAll(() =>
    inScratch('codex-resume', async (root) => {
      cwd = root;
      const { session, home } = await codexSession(
        root,
        'codex-resume',
        [
          {
            do: 'emit',
            record: {
              method: 'item/started',
              params: {
                threadId: 'resumed-1',
                turnId: 'fake-turn',
                item: { type: 'dynamicToolCall', id: 'dt-1', tool: 'lookup_docs' },
              },
            },
          },
          {
            do: 'emit',
            record: {
              method: 'item/completed',
              params: {
                threadId: 'resumed-1',
                turnId: 'fake-turn',
                item: {
                  type: 'webSearch',
                  id: 'ws-1',
                  query: 'stitchkit',
                  results: [{ title: 'ok' }],
                },
              },
            },
          },
          {
            do: 'emit',
            record: {
              method: 'turn/completed',
              params: {
                threadId: 'resumed-1',
                turn: {
                  id: 'fake-turn',
                  status: 'failed',
                  items: [],
                  error: {
                    message: 'too many requests',
                    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
                  },
                },
              },
            },
          },
        ],
        {
          options: {
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            model: 'gpt-5-codex',
          },
          nativeThreadId: 'resumed-1',
        },
      );
      try {
        const [first] = (await readFile(join(home, 'thread-resume.jsonl'), 'utf8'))
          .trim()
          .split('\n');
        resumed = JSON.parse(first ?? '{}');
        deltas = await drain(
          await session.startTurn({
            turnId: 't1',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          }),
        );
      } finally {
        await session.close();
      }
    }),
  );

  test('thread/resume carries the cwd, approval policy, sandbox and model', () => {
    expect(resumed).toMatchObject({
      threadId: 'resumed-1',
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-5-codex',
    });
  });

  test('a dynamicToolCall item is a tool call named by its tool', () => {
    expect(deltas).toContainEqual(
      expect.objectContaining({ type: 'tool-call', callId: 'dt-1', toolName: 'lookup_docs' }),
    );
  });

  test('a completed webSearch item is a successful tool result', () => {
    expect(deltas).toContainEqual(
      expect.objectContaining({ type: 'tool-result', callId: 'ws-1', outcome: 'success' }),
    );
  });

  test('an HTTP 429 turn failure is a rateLimited error', () => {
    expect(deltas).toContainEqual(
      expect.objectContaining({ type: 'error', kind: 'rateLimited' }),
    );
  });
});

describe('Codex driver: requests and the interrupt', () => {
  test('an interrupt while requestUserInput waits answers it with empty answers', () =>
    inScratch('codex-input-interrupt', async (root) => {
      const { session, home } = await codexSession(root, 'codex-input-interrupt', [
        {
          do: 'emit',
          record: {
            id: 'input-req-1',
            method: 'item/tool/requestUserInput',
            params: {
              itemId: 'call-input-1',
              questions: [{ id: 'q1', question: 'Pick one', header: 'Choice' }],
            },
          },
        },
        { do: 'expect', type: 'response' },
        { do: 'expect', type: 'turn/interrupt' },
        turnCompleted('interrupted'),
      ]);
      try {
        const turn = await session.startTurn({
          turnId: 't-input',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'go' }],
        });
        const deltas: ExecutorDelta[] = [];
        for await (const delta of turn.deltas) {
          deltas.push(delta);
          if (delta.type === 'request') await turn.interrupt();
        }
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'interrupted' });
        expect(await readJsonLines(join(home, 'responses.jsonl'))).toContainEqual({
          id: 'input-req-1',
          result: { answers: {} },
        });
      } finally {
        await session.close();
      }
    }));

  test('an approval answered by respond() is resolved under its own request type', () =>
    inScratch('codex-respond', async (root) => {
      const { session } = await codexSession(root, 'codex-respond', [
        {
          do: 'emit',
          record: {
            id: 'appr-1',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'call-a1', command: 'echo ok' },
          },
        },
        { do: 'expect', type: 'response' },
        turnCompleted('completed'),
      ]);
      try {
        const deltas = await drainApproving(
          await session.startTurn({
            turnId: 't-appr',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          }),
        );
        const resolved = deltas.find((delta) => delta.type === 'request-resolved');
        expect(resolved?.raw).toEqual({
          source: 'codex',
          type: 'item/commandExecution/requestApproval',
        });
      } finally {
        await session.close();
      }
    }));

  test('a request the engine closes itself (serverRequest/resolved) is closed on the stream and never answered', () =>
    inScratch('codex-engine-resolved', async (root) => {
      const { session, home } = await codexSession(root, 'codex-engine-resolved', [
        {
          do: 'emit',
          record: {
            id: 'appr-closed',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'call-closed', command: 'echo closed' },
          },
        },
        {
          do: 'emit',
          record: { method: 'serverRequest/resolved', params: { requestId: 'appr-closed' } },
        },
        { do: 'delay', ms: 50 },
        turnCompleted('completed'),
      ]);
      try {
        const turn = await session.startTurn({
          turnId: 't-closed',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'go' }],
        });
        const deltas = await drain(turn);
        expect(
          deltas.filter(
            (delta) => delta.type === 'request' || delta.type === 'request-resolved',
          ),
        ).toMatchObject([
          { type: 'request', interactionId: 'appr-closed' },
          {
            type: 'request-resolved',
            interactionId: 'appr-closed',
            raw: { source: 'codex', type: 'serverRequest/resolved' },
          },
        ]);
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        await expect(turn.respond('appr-closed', { kind: 'approve' })).rejects.toThrow();
        const answered = join(home, 'responses.jsonl');
        // The fake writes this file only once the executor answers something.
        const responses = existsSync(answered) ? await readJsonLines(answered) : [];
        expect(responses).not.toContainEqual(expect.objectContaining({ id: 'appr-closed' }));
      } finally {
        await session.close();
      }
    }));

  describe('requests the engine sends after turn/interrupt', () => {
    const deltas: ExecutorDelta[] = [];
    let responses: unknown[] = [];

    beforeAll(() =>
      inScratch('codex-interrupt-race', async (root) => {
        const { session, home } = await codexSession(root, 'codex-interrupt-race', [
          {
            do: 'emit',
            record: {
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'fake-thread',
                turnId: 'fake-turn',
                itemId: 'm1',
                delta: 'hi',
              },
            },
          },
          { do: 'expect', type: 'turn/interrupt' },
          {
            do: 'emit',
            record: {
              id: 'race-appr',
              method: 'item/commandExecution/requestApproval',
              params: { itemId: 'c1', command: 'echo race' },
            },
          },
          { do: 'expect', type: 'response' },
          {
            do: 'emit',
            record: {
              id: 'race-input',
              method: 'item/tool/requestUserInput',
              params: {
                itemId: 'c2',
                questions: [{ id: 'q1', question: 'Choice?', header: 'Pick' }],
              },
            },
          },
          { do: 'expect', type: 'response' },
          turnCompleted('interrupted'),
        ]);
        try {
          const turn = await session.startTurn({
            turnId: 't-race',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          });
          let interrupted = false;
          const played = (async () => {
            for await (const delta of turn.deltas) {
              deltas.push(delta);
              if (!interrupted && delta.type === 'text') {
                interrupted = true;
                await turn.interrupt();
              }
            }
          })();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              played,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Timed out waiting for interrupted Codex turn')),
                  2_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          responses = await readJsonLines(join(home, 'responses.jsonl'));
        } finally {
          await session.close();
        }
      }),
    );

    test('are not offered to the consumer, and the turn ends interrupted', () => {
      expect(deltas.some((delta) => delta.type === 'request')).toBe(false);
      expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'interrupted' });
    });

    test('an approval is cancelled at once', () => {
      expect(responses).toContainEqual({ id: 'race-appr', result: { decision: 'cancel' } });
    });

    test('a user-input request is answered with empty answers at once', () => {
      expect(responses).toContainEqual({ id: 'race-input', result: { answers: {} } });
    });
  });
});

describe('Codex empty ids', () => {
  test('an empty tool name and an empty approval itemId still give deltas that pass ExecutorDeltaSchema', () =>
    inScratch('codex-empty-ids', async (root) => {
      const { session } = await codexSession(root, 'codex-empty-ids', [
        {
          do: 'emit',
          record: {
            method: 'item/started',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              item: { type: 'dynamicToolCall', id: 'dt-empty', tool: '' },
            },
          },
        },
        {
          do: 'emit',
          record: {
            id: 'appr-empty',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: '', command: 'echo 1' },
          },
        },
        { do: 'expect', type: 'response' },
        turnCompleted('completed'),
      ]);
      try {
        const deltas = await drainApproving(
          await session.startTurn({
            turnId: 't-codex',
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

describe('Codex plan windows', () => {
  test('a window whose resetsAt is out of the Date range keeps its usage', () => {
    expect(codexPlanWindows({ primary: { usedPercent: 25, resetsAt: 1e16 } })).toEqual([
      { name: 'primary', usedPercent: 25 },
    ]);
  });
});
