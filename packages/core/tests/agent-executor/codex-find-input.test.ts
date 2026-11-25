/**
 * Codex `findInput` pagination regressions through the public `createCodexDriver`:
 * multi-page discovery, `userMessage`-only matching, opaque cursor handling (including `""`),
 * schema looseness (`backwardsCursor`), and fail-closed refusal on incomplete views,
 * mid-pagination errors, cursor cycles, and page-budget exhaustion.
 */
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexTurnsPageSchema } from '../../src/agent-executor/codex/protocol';
import { createLocalStepDurability } from '../../src/durability/engine';
import { dispatchTurn } from '../../src/entrypoints/agent-executor';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import { createMemoryAgentRuntimeStore } from '../../src/entrypoints/agent-runtime';
import { EffectUnresolvedError } from '../../src/entrypoints/tools';
import {
  ambientIn,
  inScratch,
  readJsonLines,
  trackedPidFile,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const TURNS_SERVER = fileURLToPath(
  new URL('../fixtures/codex-turns-server.ts', import.meta.url),
);

function turnsDriver(root: string) {
  return createCodexDriver({
    executable: process.execPath,
    prefixArgs: [TURNS_SERVER],
    ambient: ambientIn(root),
  });
}

function turnsProfile(root: string, label: string, scenarioPath: string, logPath: string) {
  return {
    profileId: 'codex-turns',
    engine: 'codex' as const,
    home: join(root, 'home'),
    env: {
      FAKE_ENGINE_PID_FILE: trackedPidFile(root, label),
      CODEX_TURNS_SCENARIO: scenarioPath,
      CODEX_TURNS_LOG: logPath,
    },
  };
}

describe('Codex findInput pagination', () => {
  test('walks all pages: finds first and later userMessage clientIds and ignores non-user items', () =>
    inScratch('codex-pages-ok', async (root) => {
      const scenarioPath = join(root, 'scenario.json');
      const logPath = join(root, 'requests.jsonl');
      writeFileSync(
        scenarioPath,
        JSON.stringify({
          pages: {
            __first__: {
              result: {
                data: [
                  {
                    id: 'turn-1',
                    status: 'completed',
                    itemsView: 'full',
                    items: [
                      { type: 'userMessage', id: 'u1', clientId: 'first' },
                      { type: 'agentMessage', id: 'a1', clientId: 'agent-fake' },
                    ],
                  },
                ],
                nextCursor: 'p2',
                backwardsCursor: 'prev-0',
              },
            },
            p2: {
              result: {
                data: [
                  {
                    id: 'turn-2',
                    status: 'inProgress',
                    items: [{ type: 'userMessage', id: 'u2', clientId: 'later' }],
                  },
                ],
                nextCursor: null,
              },
            },
          },
        }),
      );
      const driver = turnsDriver(root);
      const profile = turnsProfile(root, 'ok', scenarioPath, logPath);
      const base = { profile, cwd: root, nativeThreadId: 'thr-1' };

      expect(await driver.findInput?.({ ...base, clientId: 'first' })).toBe(true);
      expect(await driver.findInput?.({ ...base, clientId: 'later' })).toBe(true);
      expect(await driver.findInput?.({ ...base, clientId: 'agent-fake' })).toBe(false);
      expect(await driver.findInput?.({ ...base, clientId: 'absent' })).toBe(false);

      const requests = await readJsonLines(logPath);
      // 'first' stopped on page 1; 'later', 'agent-fake', 'absent' each walked 2 pages -> 1 + 2 + 2 + 2 = 7
      expect(requests).toHaveLength(7);
      expect(requests[1]).toEqual({ threadId: 'thr-1', limit: 50, itemsView: 'full' });
      expect(requests[2]).toEqual({
        threadId: 'thr-1',
        limit: 50,
        itemsView: 'full',
        cursor: 'p2',
      });
    }));

  test(
    'reads a single thread/turns/list response larger than 8 MiB under the 64 MiB line ceiling',
    () =>
      inScratch('codex-large-page', async (root) => {
        const scenarioPath = join(root, 'scenario.json');
        const logPath = join(root, 'requests.jsonl');
        writeFileSync(
          scenarioPath,
          JSON.stringify({
            pages: {
              __first__: {
                result: {
                  data: [
                    {
                      id: 'turn-big',
                      status: 'completed',
                      itemsView: 'full',
                      items: [
                        {
                          type: 'agentMessage',
                          id: 'a-big',
                          text: 'p'.repeat(9 * 1024 * 1024),
                        },
                        { type: 'userMessage', id: 'u-after-big', clientId: 'found-past-8mb' },
                      ],
                    },
                  ],
                  nextCursor: null,
                },
              },
            },
          }),
        );
        const driver = turnsDriver(root);
        const profile = turnsProfile(root, 'large-page', scenarioPath, logPath);
        expect(
          await driver.findInput?.({
            profile,
            cwd: root,
            nativeThreadId: 'thr-big',
            clientId: 'found-past-8mb',
          }),
        ).toBe(true);
      }),
    20_000,
  );

  test('handles empty-string opaque nextCursor and preserves unknown page fields on CodexTurnsPageSchema', () =>
    inScratch('codex-empty-cursor', async (root) => {
      const parsed = CodexTurnsPageSchema.parse({
        data: [{ id: 't1', status: 'completed', items: [], extraTurnField: 42 }],
        nextCursor: '',
        backwardsCursor: 'b0',
      });
      expect(Reflect.get(parsed, 'backwardsCursor')).toBe('b0');
      expect(Reflect.get(parsed.data[0] ?? {}, 'extraTurnField')).toBe(42);

      const scenarioPath = join(root, 'scenario.json');
      const logPath = join(root, 'requests.jsonl');
      writeFileSync(
        scenarioPath,
        JSON.stringify({
          pages: {
            __first__: {
              result: {
                data: [{ id: 't1', status: 'completed', items: [] }],
                nextCursor: '',
              },
            },
            '': {
              result: {
                data: [
                  {
                    id: 't2',
                    status: 'completed',
                    items: [{ type: 'userMessage', id: 'u2', clientId: 'after-empty' }],
                  },
                ],
                nextCursor: null,
              },
            },
          },
        }),
      );
      const driver = turnsDriver(root);
      const profile = turnsProfile(root, 'empty-cursor', scenarioPath, logPath);
      expect(
        await driver.findInput?.({
          profile,
          cwd: root,
          nativeThreadId: 'thr-empty',
          clientId: 'after-empty',
        }),
      ).toBe(true);
    }));

  test(
    'refuses page-2 RPC failure, cursor cycle, summary itemsView, missing items, and >256 page budget',
    () =>
      inScratch('codex-pages-fail', async (root) => {
        const driver = turnsDriver(root);

        const runCase = async (label: string, scenarioObj: unknown) => {
          const scenarioPath = join(root, `${label}.json`);
          const logPath = join(root, `${label}.jsonl`);
          writeFileSync(scenarioPath, JSON.stringify(scenarioObj));
          const profile = turnsProfile(root, label, scenarioPath, logPath);
          return {
            promise: driver.findInput?.({
              profile,
              cwd: root,
              nativeThreadId: 'thr-fail',
              clientId: 'absent',
            }),
            logPath,
          };
        };

        const failPage2 = await runCase('page2-err', {
          pages: {
            __first__: { result: { data: [], nextCursor: 'p2' } },
            p2: { error: { code: -32000, message: 'storage temporarily unavailable' } },
          },
        });
        await expect(failPage2.promise).rejects.toThrow(/storage temporarily unavailable/);

        const cycle = await runCase('cycle', {
          pages: {
            __first__: { result: { data: [], nextCursor: 'p2' } },
            p2: { result: { data: [], nextCursor: 'p2' } },
          },
        });
        await expect(cycle.promise).rejects.toThrow(/repeated cursor/i);

        const summaryView = await runCase('summary', {
          pages: {
            __first__: {
              result: {
                data: [{ id: 't1', status: 'completed', itemsView: 'summary', items: [] }],
                nextCursor: null,
              },
            },
          },
        });
        await expect(summaryView.promise).rejects.toThrow();

        const missingItems = await runCase('no-items', {
          pages: {
            __first__: {
              result: {
                data: [{ id: 't1', status: 'completed' }],
                nextCursor: null,
              },
            },
          },
        });
        await expect(missingItems.promise).rejects.toThrow();

        const infinite = await runCase('infinite', { pages: {}, infinite: true });
        await expect(infinite.promise).rejects.toThrow(/exceeded 256 pages/i);
        expect(await readJsonLines(infinite.logPath)).toHaveLength(256);
      }),
    20_000,
  );

  test('dispatchTurn treats page-2 failure as EffectUnresolvedError with zero resend', () =>
    inScratch('codex-dispatch-reconcile', async (root) => {
      const scenarioPath = join(root, 'scenario.json');
      const logPath = join(root, 'log.jsonl');
      writeFileSync(
        scenarioPath,
        JSON.stringify({
          pages: {
            __first__: { result: { data: [], nextCursor: 'p2' } },
            p2: { error: { code: -32000, message: 'backend down' } },
          },
        }),
      );
      const driver = turnsDriver(root);
      const profile = turnsProfile(root, 'dispatch', scenarioPath, logPath);
      const store = createMemoryAgentRuntimeStore();
      const beforeRestart = createLocalStepDurability({
        store,
        conversationId: 'conv-codex',
        runId: 'run-codex',
      });
      await expect(
        dispatchTurn({
          durability: beforeRestart,
          driver,
          session: {
            nativeThreadId: 'thr-d',
            async startTurn() {
              throw new Error('simulated crash mid-dispatch');
            },
            async close() {
              // no-op
            },
          },
          profile,
          cwd: root,
          turnId: 't1',
          input: [{ type: 'text', text: 'hi' }],
        }),
      ).rejects.toThrow(/simulated crash|unresolved/i);

      const afterRestart = createLocalStepDurability({
        store,
        conversationId: 'conv-codex',
        runId: 'run-codex',
      });
      let startCalls = 0;
      const error = await dispatchTurn({
        durability: afterRestart,
        driver,
        session: {
          nativeThreadId: 'thr-d',
          async startTurn() {
            startCalls += 1;
            throw new Error('must not resend');
          },
          async close() {
            // no-op
          },
        },
        profile,
        cwd: root,
        turnId: 't1',
        input: [{ type: 'text', text: 'hi' }],
      }).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(EffectUnresolvedError);
      expect(startCalls).toBe(0);
    }));
});
