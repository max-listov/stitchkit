import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeRuntimeEvent } from '../../src/agent-executor/claude/events';
import { createClaudeCliDriver } from '../../src/entrypoints/agent-executor/claude';
import {
  type ClaudeSdkPermissionRequestMeta,
  type ClaudeSdkQuery,
  createClaudeSdkDriver,
} from '../../src/entrypoints/agent-executor/claude-sdk';
import { probeLiveness } from '../../src/internal/process-identity';
import { ambientIn, countedSignal, drain, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const CLI_PEER = resolve(import.meta.dir, '../fixtures/claude-cli-liveness-peer.ts');

function readJsonLines(path: string): unknown[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for marker file ${path}`);
}

async function waitForProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await probeLiveness(pid)) === 'gone') return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`);
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function assertNotTypeError(error: unknown, pattern: RegExp): void {
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(TypeError);
  expect(error instanceof Error ? error.message : String(error)).toMatch(pattern);
}

function textTurn(turnId: string) {
  return {
    turnId,
    clientId: crypto.randomUUID(),
    input: [{ type: 'text' as const, text: 'go' }],
  };
}

function cliDriver(root: string, mode: string) {
  return createClaudeCliDriver({
    executable: process.execPath,
    prefixArgs: [CLI_PEER, root, mode],
    ambient: ambientIn(root),
  });
}

function cliProfile(root: string) {
  return { profileId: 'p-cli', engine: 'claude-cli' as const, home: join(root, 'home') };
}

function sdkProfile(root: string) {
  return { profileId: 'p-sdk', engine: 'claude-sdk' as const, home: join(root, 'home') };
}

describe('Claude CLI turn respond, interrupt, and teardown liveness', () => {
  test('positive control: live turn answers permission request, refuses unknown id with TypeError, and ignores interrupt on settled turn', () =>
    inScratch('cli-liveness-positive', async (root) => {
      trackPidFile(join(root, 'pid'));
      const session = await cliDriver(root, 'live-positive').open({
        profile: cliProfile(root),
        cwd: root,
      });
      try {
        const turn = await session.startTurn(textTurn('t-live'));
        const deltas = [];
        for await (const delta of turn.deltas) {
          deltas.push(delta);
          if (delta.type === 'request') {
            await expect(turn.respond('no-such-id', { kind: 'approve' })).rejects.toThrow(
              TypeError,
            );
            await turn.respond(delta.interactionId, { kind: 'approve' });
          }
        }
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        await expect(turn.respond('req-live-1', { kind: 'approve' })).rejects.toThrow(
          TypeError,
        );
        await turn.interrupt();
      } finally {
        await session.close();
      }
      const stdin = readJsonLines(join(root, 'stdin.jsonl'));
      expect(
        stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_response'),
      ).toHaveLength(1);
      expect(
        stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_request'),
      ).toEqual([]);
    }));

  test('close() deduplicates, rejects turn.respond() with closed error (not TypeError), ignores interrupt, and writes zero control frames', () =>
    inScratch('cli-liveness-close', async (root) => {
      trackPidFile(join(root, 'pid'));
      const caller = countedSignal();
      const session = await cliDriver(root, 'close-active').open({
        profile: cliProfile(root),
        cwd: root,
        signal: caller.signal,
      });
      const turn = await session.startTurn(textTurn('t-close'));
      const iter = turn.deltas[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe('request');
      const deltaErr = captureRejection(
        (async () => {
          for (;;) {
            const next = await iter.next();
            if (next.done) break;
          }
        })(),
      );
      const closeFirst = session.close();
      const closeSecond = session.close();
      expect(closeFirst).toBe(closeSecond);
      await closeFirst;
      assertNotTypeError(await deltaErr, /closed/i);
      assertNotTypeError(
        await captureRejection(turn.respond('req-act-1', { kind: 'approve' })),
        /closed/i,
      );
      await turn.interrupt();
      expect(caller.listeners()).toBe(0);
      const stdin = readJsonLines(join(root, 'stdin.jsonl'));
      expect(
        stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_response'),
      ).toEqual([]);
      expect(
        stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_request'),
      ).toEqual([]);
    }));

  test('unexpected process exit rejects turn.respond() with exit error (not TypeError) and suppresses interrupt', () =>
    inScratch('cli-liveness-disconnect', async (root) => {
      trackPidFile(join(root, 'pid'));
      const session = await cliDriver(root, 'disconnect-active').open({
        profile: cliProfile(root),
        cwd: root,
      });
      try {
        const turn = await session.startTurn(textTurn('t-disc'));
        const iter = turn.deltas[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.value?.type).toBe('request');
        writeFileSync(join(root, 'trigger-exit'), '1');
        const deltaErr = await captureRejection(
          (async () => {
            for (;;) {
              const next = await iter.next();
              if (next.done) break;
            }
          })(),
        );
        assertNotTypeError(deltaErr, /exited/i);
        assertNotTypeError(
          await captureRejection(turn.respond('req-act-1', { kind: 'approve' })),
          /exited/i,
        );
        await turn.interrupt();
        const stdin = readJsonLines(join(root, 'stdin.jsonl'));
        expect(
          stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_response'),
        ).toEqual([]);
        expect(
          stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_request'),
        ).toEqual([]);
      } finally {
        await session.close();
      }
    }));

  test('AbortSignal.abort(reason) rejects pre-open sync listener, live-child window, and post-exit turn.respond() with exact reason without writing to stdin', () =>
    inScratch('cli-liveness-abort', async (root) => {
      trackPidFile(join(root, 'pid'));
      const controller = new AbortController();
      let activeTurn:
        | Awaited<
            ReturnType<Awaited<ReturnType<ReturnType<typeof cliDriver>['open']>>['startTurn']>
          >
        | undefined;
      let syncListenerResult: Promise<unknown> | undefined;
      // Register BEFORE open() so EventTarget fires this listener before linkAbortSignals forwarder.
      controller.signal.addEventListener(
        'abort',
        () => {
          if (activeTurn !== undefined) {
            syncListenerResult = captureRejection(
              activeTurn.respond('req-act-1', { kind: 'approve' }),
            );
          }
        },
        { once: true },
      );

      const driver = cliDriver(root, 'abort-active');
      const session = await driver.open({
        profile: cliProfile(root),
        cwd: root,
        signal: controller.signal,
      });
      const turn = await session.startTurn(textTurn('t-abort'));
      activeTurn = turn;
      const iter = turn.deltas[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.value?.type).toBe('request');
      await waitForFile(join(root, 'pid'));
      const pid = Number(readFileSync(join(root, 'pid'), 'utf8').trim());

      const seenLateDeltas: unknown[] = [];
      const deltaErr = captureRejection(
        (async () => {
          for (;;) {
            const next = await iter.next();
            if (next.done) break;
            seenLateDeltas.push(next.value);
          }
        })(),
      );

      const reason = new Error('cli-caller-aborted');
      controller.abort(reason);
      // 1. Pre-open sync listener rejected with exact caller reason.
      expect(await syncListenerResult).toBe(reason);
      // 2. While child is STILL ALIVE after SIGTERM (before release-exit): respond & interrupt blocked.
      await waitForFile(join(root, 'sigterm-received'));
      expect(await captureRejection(turn.respond('req-act-1', { kind: 'approve' }))).toBe(
        reason,
      );
      await turn.interrupt();
      expect(await deltaErr).toBe(reason);
      // Only the pre-abort held request's `request-resolved` delta from `loseEngineTurn` may appear;
      // late text and late permission records emitted after SIGTERM must be dropped.
      expect(seenLateDeltas).toEqual([
        expect.objectContaining({ type: 'request-resolved', interactionId: 'req-act-1' }),
      ]);

      // 3. After child actually exits: post-exit respond still preserves exact caller reason,
      // and late rate_limit_event emitted after SIGTERM never updates driver planLimits.
      writeFileSync(join(root, 'release-exit'), '1');
      await waitForProcessGone(pid);
      await Bun.sleep(20);
      expect(await captureRejection(turn.respond('req-act-1', { kind: 'approve' }))).toBe(
        reason,
      );
      expect((await driver.status(cliProfile(root))).planLimits).toBeUndefined();
      const stdin = readJsonLines(join(root, 'stdin.jsonl'));
      expect(
        stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_response'),
      ).toEqual([]);
      expect(
        stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_request'),
      ).toEqual([]);
      await session.close();
    }));

  test('calling interrupt() on a settled turn does not interrupt a subsequent active turn', () =>
    inScratch('cli-liveness-settled-interrupt', async (root) => {
      trackPidFile(join(root, 'pid'));
      const session = await cliDriver(root, 'settled-interrupt').open({
        profile: cliProfile(root),
        cwd: root,
      });
      try {
        const turn1 = await session.startTurn(textTurn('t-1'));
        const deltas1 = await drain(turn1);
        expect(deltas1.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });

        const turn2 = await session.startTurn(textTurn('t-2'));
        const iter2 = turn2.deltas[Symbol.asyncIterator]();
        const first2 = await iter2.next();
        expect(first2.value).toMatchObject({ type: 'text', text: 'turn-2-live' });
        await turn1.interrupt();
        writeFileSync(join(root, 'release-turn-2'), '1');
        const rest2 = [];
        for (;;) {
          const next = await iter2.next();
          if (next.done) break;
          rest2.push(next.value);
        }
        expect(rest2.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        const stdin = readJsonLines(join(root, 'stdin.jsonl'));
        expect(
          stdin.filter((line) => Reflect.get(Object(line), 'type') === 'control_request'),
        ).toEqual([]);
      } finally {
        await session.close();
      }
    }));
});

describe('Claude SDK turn respond, interrupt, and teardown liveness', () => {
  test('positive control: live turn accepts respond, rejects unknown/ended id with TypeError, and live interrupt invokes query.interrupt once', () =>
    inScratch('sdk-liveness-positive', async (root) => {
      let interruptCalls = 0;
      const answers: PermissionResult[] = [];
      const query: ClaudeSdkQuery = ({ prompt, options }) => {
        async function* run(): AsyncGenerator<unknown> {
          for await (const message of prompt) {
            const answer = await options?.canUseTool?.(
              'Bash',
              { command: 'ls' },
              { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'r-1' },
            );
            if (answer !== undefined && answer !== null) answers.push(answer);
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 's',
              result: 'ok',
              uuid: message.uuid,
            };
          }
        }
        const records = run();
        return {
          [Symbol.asyncIterator]: () => records,
          interrupt: async () => {
            interruptCalls += 1;
          },
        };
      };
      const session = await createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query,
      }).open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn1 = await session.startTurn(textTurn('t-live-1'));
        const deltas1 = [];
        for await (const delta of turn1.deltas) {
          deltas1.push(delta);
          if (delta.type === 'request') {
            await expect(turn1.respond('unknown', { kind: 'approve' })).rejects.toThrow(
              TypeError,
            );
            await turn1.respond(delta.interactionId, { kind: 'approve' });
          }
        }
        expect(deltas1.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(answers[0]?.behavior).toBe('allow');
        await expect(turn1.respond('anything', { kind: 'approve' })).rejects.toThrow(
          TypeError,
        );
        // Settled turn1.interrupt() must be a no-op.
        await turn1.interrupt();
        expect(interruptCalls).toBe(0);

        const turn2 = await session.startTurn(textTurn('t-live-2'));
        for await (const delta of turn2.deltas) {
          if (delta.type === 'request') await turn2.interrupt();
        }
        expect(interruptCalls).toBe(1);
      } finally {
        await session.close();
      }
    }));

  test('close() rejects turn.respond() with closed error, suppresses interrupt, and stops buffered post-close records from reaching onEvent/limits', () =>
    inScratch('sdk-liveness-close', async (root) => {
      let interruptCalls = 0;
      const answers: PermissionResult[] = [];
      const events: ClaudeRuntimeEvent[] = [];
      const asked = Promise.withResolvers<void>();
      const releaseTail = Promise.withResolvers<void>();
      const query: ClaudeSdkQuery = ({ prompt, options }) => {
        async function* run(): AsyncGenerator<unknown> {
          for await (const _message of prompt) {
            const pending = options?.canUseTool?.(
              'Bash',
              { command: 'ls' },
              { signal: new AbortController().signal, toolUseID: 'tu-c', requestId: 'r-c' },
            );
            asked.resolve();
            const answer = await pending;
            if (answer !== undefined && answer !== null) answers.push(answer);
            await releaseTail.promise;
            yield {
              type: 'system',
              subtype: 'task_started',
              task_id: 'late-task',
              description: 'must not deliver after close',
            };
            yield {
              type: 'rate_limit_event',
              rate_limit_info: {
                status: 'allowed',
                resetsAt: Math.floor(Date.now() / 1000) + 3600,
                rateLimitType: 'five_hour',
                utilization: 0.99,
              },
            };
          }
        }
        const records = run();
        return {
          [Symbol.asyncIterator]: () => records,
          interrupt: async () => {
            interruptCalls += 1;
          },
        };
      };
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query,
        onEvent: (event) => events.push(event),
      });
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      const turn = await session.startTurn(textTurn('t-close'));
      await asked.promise;
      const iter = turn.deltas[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.value?.type).toBe('request');
      const interactionId = first.value?.type === 'request' ? first.value.interactionId : '';

      await session.close();
      releaseTail.resolve();
      await Bun.sleep(20);
      assertNotTypeError(
        await captureRejection(turn.respond(interactionId, { kind: 'approve' })),
        /closed/i,
      );
      await turn.interrupt();
      expect(interruptCalls).toBe(0);
      expect(answers.every((entry) => entry.behavior !== 'allow')).toBe(true);
      expect(events).toEqual([]);
      expect((await driver.status(sdkProfile(root))).planLimits).toBeUndefined();
    }));

  test('AbortSignal.abort(reason) blocks pre-open sync listener, post-abort respond, interrupt, controls, and closes query during startup microtask race', () =>
    inScratch('sdk-liveness-abort', async (root) => {
      let interruptCalls = 0;
      const answers: PermissionResult[] = [];
      const permMetas: ClaudeSdkPermissionRequestMeta[] = [];
      const controller = new AbortController();
      let activeTurn:
        | Awaited<
            ReturnType<
              Awaited<
                ReturnType<ReturnType<typeof createClaudeSdkDriver>['open']>
              >['startTurn']
            >
          >
        | undefined;
      let heldId = '';
      let syncErr: Promise<unknown> | undefined;
      let syncCanUseToolDecision: Promise<PermissionResult | null> | undefined;
      let capturedCanUseTool: CanUseTool | undefined;
      // Registered BEFORE open() so it fires before linkAbortSignals forwarder and shutdown().
      // At this point `current !== undefined` and `shutdown()` has not run yet.
      controller.signal.addEventListener(
        'abort',
        () => {
          if (activeTurn !== undefined && heldId.length > 0) {
            syncErr = captureRejection(activeTurn.respond(heldId, { kind: 'approve' }));
          }
          if (capturedCanUseTool !== undefined) {
            syncCanUseToolDecision = Promise.resolve(
              capturedCanUseTool(
                'Bash',
                { command: 'echo during-sync-abort' },
                {
                  signal: new AbortController().signal,
                  toolUseID: 'tu-sync-abort',
                  requestId: 'r-sync-abort',
                },
              ),
            );
          }
        },
        { once: true },
      );

      const query: ClaudeSdkQuery = ({ prompt, options }) => {
        capturedCanUseTool = options?.canUseTool;
        async function* run(): AsyncGenerator<unknown> {
          for await (const message of prompt) {
            const answer = await options?.canUseTool?.(
              'Write',
              { path: 'a.ts' },
              { signal: new AbortController().signal, toolUseID: 'tu-a', requestId: 'r-a' },
            );
            if (answer !== undefined && answer !== null) answers.push(answer);
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 's',
              result: 'done',
              uuid: message.uuid,
            };
          }
        }
        const records = run();
        return {
          [Symbol.asyncIterator]: () => records,
          interrupt: async () => {
            interruptCalls += 1;
          },
          setModel: async () => undefined,
        };
      };
      const session = await createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query,
        onPermissionRequest: (meta) => permMetas.push(meta),
      }).open({ profile: sdkProfile(root), cwd: root, signal: controller.signal });

      const turn = await session.startTurn(textTurn('t-abort'));
      activeTurn = turn;
      const iter = turn.deltas[Symbol.asyncIterator]();
      const first = await iter.next();
      expect(first.value?.type).toBe('request');
      heldId = first.value?.type === 'request' ? first.value.interactionId : '';
      expect(permMetas).toHaveLength(1);

      const reason = new Error('sdk-caller-aborted');
      controller.abort(reason);
      expect(await syncErr).toBe(reason);
      // Pre-open sync abort while current !== undefined proves `state.isClosed()` denies canUseTool immediately.
      expect((await syncCanUseToolDecision)?.behavior).toBe('deny');
      expect(permMetas).toHaveLength(1);
      expect(await captureRejection(turn.respond(heldId, { kind: 'approve' }))).toBe(reason);
      expect(await captureRejection(session.setModel('claude-opus'))).toBe(reason);
      await turn.interrupt();
      expect(interruptCalls).toBe(0);
      await Bun.sleep(10);
      expect(answers.every((entry) => entry.behavior !== 'allow')).toBe(true);
      await session.close();

      // 1. Sync abort inside onStartupPhase('spawning') prevents config.query() from spawning.
      let phaseSpawns = 0;
      const phaseAc = new AbortController();
      const phaseReason = new Error('abort-during-spawning-phase');
      const phaseSession = await createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query: () => {
          phaseSpawns += 1;
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<never>(() => undefined),
            }),
            interrupt: async () => undefined,
          };
        },
      }).open({
        profile: sdkProfile(root),
        cwd: root,
        signal: phaseAc.signal,
        onStartupPhase: (phase) => {
          if (phase === 'spawning') phaseAc.abort(phaseReason);
        },
      });
      expect(await captureRejection(phaseSession.startTurn(textTurn('t-phase')))).toBe(
        phaseReason,
      );
      expect(phaseSpawns).toBe(0);
      await phaseSession.close();

      // 2. Real microtask handoff race (`ensureQuery` `.then()` after `launchSingleSdkQuery` returns synchronously):
      // abort and close right after calling setModel() before the `.then()` microtask assigns `running`.
      for (const mode of ['abort', 'close'] as const) {
        let closedCount = 0;
        let setModelCalls = 0;
        const raceAc = new AbortController();
        const raceSession = await createClaudeSdkDriver({
          sdkVersion: '0.3.330',
          ambient: ambientIn(root),
          query: () => ({
            [Symbol.asyncIterator]: () => ({
              next: () => new Promise<never>(() => undefined),
            }),
            interrupt: async () => undefined,
            close: () => {
              closedCount += 1;
            },
            setModel: async () => {
              setModelCalls += 1;
            },
          }),
        }).open({ profile: sdkProfile(root), cwd: root, signal: raceAc.signal });
        // Launches query synchronously up to `return handle`; `.then()` handoff sits in microtask queue.
        const modelPromise = captureRejection(raceSession.setModel('claude-opus'));
        const handoffReason = new Error(`handoff-${mode}`);
        if (mode === 'abort') raceAc.abort(handoffReason);
        else void raceSession.close();
        const err = await modelPromise;
        if (mode === 'abort') expect(err).toBe(handoffReason);
        else assertNotTypeError(err, /closed/i);
        expect(closedCount).toBe(1);
        expect(setModelCalls).toBe(0);
        await raceSession.close();
      }

      // 3. Real replayClaudeSdkFlagSettings abort on query restart closes replacement query with exact reason.
      let replayQueryIndex = 0;
      let secondQueryClosed = 0;
      const crashFirst = Promise.withResolvers<void>();
      const replayStarted = Promise.withResolvers<void>();
      const replayGate = Promise.withResolvers<void>();
      const replayAc = new AbortController();
      const replaySession = await createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query: () => {
          replayQueryIndex += 1;
          const idx = replayQueryIndex;
          return {
            async *[Symbol.asyncIterator]() {
              if (idx === 1) {
                await crashFirst.promise;
                throw new Error('query-1-crashed');
              }
              yield { type: 'system', subtype: 'init', session_id: 's' };
              await new Promise<never>(() => undefined);
            },
            interrupt: async () => undefined,
            close: () => {
              if (idx === 2) secondQueryClosed += 1;
            },
            applyFlagSettings: () => {
              if (idx === 2) {
                replayStarted.resolve();
                return replayGate.promise;
              }
              return Promise.resolve();
            },
          };
        },
      }).open({ profile: sdkProfile(root), cwd: root, signal: replayAc.signal });
      await replaySession.applyFlagSettings({ effortLevel: 'high' });
      crashFirst.resolve();
      await Bun.sleep(10);
      const replayTurnErr = captureRejection(replaySession.startTurn(textTurn('t-replay')));
      await replayStarted.promise;
      const replayReason = new Error('abort-during-flag-replay');
      replayAc.abort(replayReason);
      expect(await replayTurnErr).toBe(replayReason);
      expect(secondQueryClosed).toBe(1);
      replayGate.resolve();
      await replaySession.close();
    }));

  test('unexpected query exit rejects failed turn.respond() with query error (not TypeError) even after a later resumed turn succeeds', () =>
    inScratch('sdk-liveness-query-exit', async (root) => {
      let queryIndex = 0;
      let interruptCalls = 0;
      const failNow = Promise.withResolvers<void>();
      const query: ClaudeSdkQuery = ({ prompt, options }) => {
        queryIndex += 1;
        const currentIndex = queryIndex;
        async function* run(): AsyncGenerator<unknown> {
          for await (const message of prompt) {
            if (currentIndex === 1) {
              void options?.canUseTool?.(
                'Bash',
                { command: 'sleep 1' },
                {
                  signal: new AbortController().signal,
                  toolUseID: 'tu-q1',
                  requestId: 'r-q1',
                },
              );
              await failNow.promise;
              throw new Error('Claude Code process exited with code 137');
            }
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 's',
              result: 'recovered',
              uuid: message.uuid,
            };
          }
        }
        const records = run();
        return {
          [Symbol.asyncIterator]: () => records,
          interrupt: async () => {
            interruptCalls += 1;
          },
        };
      };
      const session = await createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query,
      }).open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn1 = await session.startTurn(textTurn('t-q1'));
        const iter1 = turn1.deltas[Symbol.asyncIterator]();
        const first1 = await iter1.next();
        expect(first1.value?.type).toBe('request');
        const id1 = first1.value?.type === 'request' ? first1.value.interactionId : '';
        failNow.resolve();
        const err1 = await captureRejection(
          (async () => {
            for (;;) {
              const next = await iter1.next();
              if (next.done) break;
            }
          })(),
        );
        assertNotTypeError(err1, /code 137/);
        assertNotTypeError(
          await captureRejection(turn1.respond(id1, { kind: 'approve' })),
          /code 137/,
        );
        await turn1.interrupt();
        expect(interruptCalls).toBe(0);

        // Session resumes cleanly on a new query for turn2.
        const turn2 = await session.startTurn(textTurn('t-q2'));
        const deltas2 = await drain(turn2);
        expect(deltas2.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        await turn2.interrupt();
        expect(interruptCalls).toBe(0);
        // Failed turn1.respond() still throws its query-exit error (not TypeError).
        assertNotTypeError(
          await captureRejection(turn1.respond(id1, { kind: 'approve' })),
          /code 137/,
        );
      } finally {
        await session.close();
      }
    }));
});
