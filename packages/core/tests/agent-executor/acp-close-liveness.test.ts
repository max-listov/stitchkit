import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createAcpHandlers } from '../../src/agent-executor/acp/v1-handlers';
import type { PendingExternalAcpRequest } from '../../src/agent-executor/acp/v1-permission';
import { newAcpTurn, runAcpPrompt } from '../../src/agent-executor/acp/v1-turn';
import { createJsonRpcPeer, JsonRpcError } from '../../src/agent-executor/json-rpc-peer';
import { sessionLiveness } from '../../src/agent-executor/session-primitives';
import {
  type AcpPermissionRequestEvent,
  type AcpUpdateEvent,
  createAcpDriver,
} from '../../src/entrypoints/agent-executor/acp';
import { probeLiveness } from '../../src/internal/process-identity';
import { ambientIn, drain, inScratch, promiseJobsRan } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const PEER = resolve(import.meta.dir, '../fixtures/acp-close-liveness-peer.ts');

const TURN_INPUT = {
  turnId: 't-1',
  clientId: 'client-1',
  input: [{ type: 'text' as const, text: 'go' }],
};

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

async function waitForResponse(path: string, id: string): Promise<unknown[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const entries = readJsonLines(path);
    if (entries.some((entry) => Reflect.get(Object(entry), 'id') === id)) return entries;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for response ${id} in ${path}`);
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

describe('ACP close, disconnect, and abort liveness', () => {
  test('positive control: live session delivers onUpdate/onPermissionRequest and accepts event.respond and session.respond', () =>
    inScratch('acp-liveness-positive', async (root) => {
      trackPidFile(join(root, 'pid'));
      const updates: AcpUpdateEvent[] = [];
      const extReady = Promise.withResolvers<AcpPermissionRequestEvent>();
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [PEER, root, 'live-positive'],
        ambient: ambientIn(root),
        permissionRequestDelivery: 'all',
        onUpdate: (event) => updates.push(event),
        onPermissionRequest: (event) => {
          if (event.duringActiveTurn) void event.respond({ kind: 'approve' });
          else extReady.resolve(event);
        },
      });
      const session = await driver.open({
        profile: { engine: 'acp', profileId: 'pos', home: root },
        cwd: root,
      });
      try {
        expect(session.providerPid).toBeGreaterThan(0);
        const turn = await session.startTurn(TURN_INPUT);
        const deltas = await drain(turn);
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        const ext = await extReady.promise;
        await session.respond(ext.interactionId, { kind: 'approve' });
        const responses = await waitForResponse(join(root, 'responses.jsonl'), 'ext-1');
        expect(responses).toEqual([
          {
            jsonrpc: '2.0',
            id: 'act-1',
            result: { outcome: { outcome: 'selected', optionId: 'allow-1' } },
          },
          {
            jsonrpc: '2.0',
            id: 'ext-1',
            result: { outcome: { outcome: 'selected', optionId: 'allow-1' } },
          },
        ]);
        expect(updates.some((u) => u.duringActiveTurn)).toBe(true);
        expect(updates.some((u) => !u.duringActiveTurn)).toBe(true);
      } finally {
        await session.close();
      }
    }));

  test.each(['close-active', 'close-external'] as const)(
    'session/close window (%s) rejects respond(), fails active turn immediately, deduplicates close(), refuses late requests, and drops late observers',
    (mode) =>
      inScratch(`acp-liveness-${mode}`, async (root) => {
        trackPidFile(join(root, 'pid'));
        const updates: AcpUpdateEvent[] = [];
        const perms: AcpPermissionRequestEvent[] = [];
        const heldReady = Promise.withResolvers<AcpPermissionRequestEvent>();
        const driver = createAcpDriver({
          executable: process.execPath,
          args: [PEER, root, mode],
          ambient: ambientIn(root),
          permissionRequestDelivery: 'all',
          onUpdate: (event) => updates.push(event),
          onPermissionRequest: (event) => {
            perms.push(event);
            if (event.interactionId === 'act-1' || event.interactionId === 'ext-1') {
              heldReady.resolve(event);
            }
          },
        });
        const session = await driver.open({
          profile: { engine: 'acp', profileId: mode, home: root },
          cwd: root,
        });
        const turn = await session.startTurn(TURN_INPUT);
        const turnOutcome =
          mode === 'close-external' ? await drain(turn) : captureRejection(drain(turn));
        if (mode === 'close-external') {
          expect(Array.isArray(turnOutcome) ? turnOutcome.at(-1) : undefined).toMatchObject({
            type: 'turn-end',
            outcome: 'completed',
          });
        }
        const heldEvent = await heldReady.promise;
        expect(session.title).toBe('initial');
        expect(session.commands).toEqual(['init-cmd']);

        const closingA = session.close();
        const closingB = session.close();
        await waitForFile(join(root, 'close-received'));

        expect(session.providerPid).toBeUndefined();
        if (mode === 'close-active') {
          // Verify close() fails the active turn BEFORE the peer sends a late session/prompt reply.
          assertNotTypeError(await turnOutcome, /closing/i);
          const preReleaseReplies = await waitForResponse(
            join(root, 'responses.jsonl'),
            'act-1',
          );
          expect(preReleaseReplies).toContainEqual({
            jsonrpc: '2.0',
            id: 'act-1',
            result: { outcome: { outcome: 'cancelled' } },
          });
          await turn.interrupt();
          assertNotTypeError(
            await captureRejection(turn.respond('act-1', { kind: 'approve' })),
            /closing/i,
          );
        }
        assertNotTypeError(
          await captureRejection(heldEvent.respond({ kind: 'approve' })),
          /closing/i,
        );
        assertNotTypeError(
          await captureRejection(
            session.respond(heldEvent.interactionId, { kind: 'approve' }),
          ),
          /closing/i,
        );

        writeFileSync(join(root, 'release-close'), '1');
        await Promise.all([closingA, closingB]);

        // Post-close respond() calls still fail with closing error, never TypeError: Unknown interaction.
        assertNotTypeError(
          await captureRejection(heldEvent.respond({ kind: 'approve' })),
          /closing/i,
        );
        if (mode === 'close-active') {
          assertNotTypeError(
            await captureRejection(turn.respond('act-1', { kind: 'approve' })),
            /closing/i,
          );
        }

        // close() resolved, so the reader it waits for has read every late update, request and
        // prompt reply the agent wrote: what was dropped is dropped for good.
        expect(updates).toEqual([]);
        expect(perms.map((p) => p.interactionId)).toEqual([heldEvent.interactionId]);
        expect(session.title).toBe('initial');
        expect(session.commands).toEqual(['init-cmd']);

        const calls = readJsonLines(join(root, 'calls.jsonl'));
        expect(
          calls.filter((entry) => Array.isArray(entry) && entry[0] === 'session/close'),
        ).toHaveLength(1);
        expect(
          calls.some((entry) => Array.isArray(entry) && entry[0] === 'session/cancel'),
        ).toBe(false);
        // The agent is still read while close() waits for `session/close`: what it asks then is
        // refused, so it never waits on an answer nobody will give.
        const responses = readJsonLines(join(root, 'responses.jsonl'));
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'late-perm-during-close',
          result: { outcome: { outcome: 'cancelled' } },
        });
        expect(responses).toContainEqual({
          jsonrpc: '2.0',
          id: 'late-read-during-close',
          error: {
            code: -32601,
            message: 'fs/read_text_file is not handled by this executor',
          },
        });
        expect(JSON.stringify(responses)).not.toContain('"selected"');
      }),
  );

  test.each(['disconnect-active', 'disconnect-external'] as const)(
    'unexpected disconnect (%s) rejects event.respond, turn.respond, and session.respond with disconnect error',
    (mode) =>
      inScratch(`acp-liveness-${mode}`, async (root) => {
        trackPidFile(join(root, 'pid'));
        const disconnected = Promise.withResolvers<Error>();
        const heldReady = Promise.withResolvers<AcpPermissionRequestEvent>();
        const driver = createAcpDriver({
          executable: process.execPath,
          args: [PEER, root, mode],
          ambient: ambientIn(root),
          permissionRequestDelivery: 'all',
          onDisconnect: (error) => disconnected.resolve(error),
          onPermissionRequest: (event) => heldReady.resolve(event),
        });
        const session = await driver.open({
          profile: { engine: 'acp', profileId: mode, home: root },
          cwd: root,
        });
        try {
          const turn = await session.startTurn(TURN_INPUT);
          const turnFailure =
            mode === 'disconnect-active' ? captureRejection(drain(turn)) : undefined;
          if (mode === 'disconnect-external') {
            expect((await drain(turn)).at(-1)).toMatchObject({
              type: 'turn-end',
              outcome: 'completed',
            });
          }
          const heldEvent = await heldReady.promise;
          writeFileSync(join(root, 'trigger-exit'), '1');
          const disconnectError = await disconnected.promise;
          expect(disconnectError.message).toMatch(/exited/i);
          if (turnFailure !== undefined) assertNotTypeError(await turnFailure, /exited/i);
          assertNotTypeError(
            await captureRejection(heldEvent.respond({ kind: 'approve' })),
            /exited/i,
          );
          assertNotTypeError(
            await captureRejection(
              session.respond(heldEvent.interactionId, { kind: 'approve' }),
            ),
            /exited/i,
          );
          if (mode === 'disconnect-active') {
            assertNotTypeError(
              await captureRejection(turn.respond('act-1', { kind: 'approve' })),
              /exited/i,
            );
          }
        } finally {
          await session.close();
        }
      }),
  );

  test.each(['abort-active', 'abort-external'] as const)(
    'caller AbortSignal (%s) preserves abort reason immediately and after exit, skips session/close, and drops late frames',
    (mode) =>
      inScratch(`acp-liveness-${mode}`, async (root) => {
        trackPidFile(join(root, 'pid'));
        const updates: AcpUpdateEvent[] = [];
        const perms: AcpPermissionRequestEvent[] = [];
        const heldReady = Promise.withResolvers<AcpPermissionRequestEvent>();
        const controller = new AbortController();
        const reason = new Error(`caller-aborted-${mode}`);
        let liveSession:
          | Awaited<ReturnType<ReturnType<typeof createAcpDriver>['open']>>
          | undefined;
        let liveEvent: AcpPermissionRequestEvent | undefined;
        let syncPidDuringAbort: number | undefined = -1;
        let syncRespondErr: Promise<unknown> | undefined;
        // Registered BEFORE open() so it fires before linkAbortSignals forwarder.
        controller.signal.addEventListener(
          'abort',
          () => {
            if (liveSession !== undefined && liveEvent !== undefined) {
              syncPidDuringAbort = liveSession.providerPid;
              syncRespondErr = captureRejection(liveEvent.respond({ kind: 'approve' }));
            }
          },
          { once: true },
        );
        const driver = createAcpDriver({
          executable: process.execPath,
          args: [PEER, root, mode],
          ambient: ambientIn(root),
          permissionRequestDelivery: 'all',
          onUpdate: (event) => updates.push(event),
          onPermissionRequest: (event) => {
            perms.push(event);
            if (event.interactionId === 'act-1' || event.interactionId === 'ext-1') {
              heldReady.resolve(event);
            }
          },
        });
        const session = await driver.open({
          profile: { engine: 'acp', profileId: mode, home: root },
          cwd: root,
          signal: controller.signal,
        });
        liveSession = session;
        const turn = await session.startTurn(TURN_INPUT);
        const turnFailure =
          mode === 'abort-active' ? captureRejection(drain(turn)) : undefined;
        if (mode === 'abort-external') {
          expect((await drain(turn)).at(-1)).toMatchObject({
            type: 'turn-end',
            outcome: 'completed',
          });
        }
        const heldEvent = await heldReady.promise;
        liveEvent = heldEvent;
        const pid = session.providerPid;
        expect(pid).toBeGreaterThan(0);

        // Abort synchronously while child traps SIGTERM and peer is still open.
        controller.abort(reason);
        expect(syncPidDuringAbort).toBeUndefined();
        expect(await syncRespondErr).toBe(reason);
        expect(session.providerPid).toBeUndefined();
        expect(await captureRejection(heldEvent.respond({ kind: 'approve' }))).toBe(reason);
        expect(
          await captureRejection(
            session.respond(heldEvent.interactionId, { kind: 'approve' }),
          ),
        ).toBe(reason);
        if (mode === 'abort-active') {
          await turn.interrupt();
          expect(await captureRejection(turn.respond('act-1', { kind: 'approve' }))).toBe(
            reason,
          );
        }

        // Wait deterministically for the child to emit late post-SIGTERM frames and exit, then verify post-exit reason.
        await waitForFile(join(root, 'sigterm-received'));
        if (pid !== undefined) await waitForProcessGone(pid);
        if (mode === 'abort-active') expect(await turnFailure).toBe(reason);
        expect(await captureRejection(heldEvent.respond({ kind: 'approve' }))).toBe(reason);
        if (mode === 'abort-active') {
          expect(await captureRejection(turn.respond('act-1', { kind: 'approve' }))).toBe(
            reason,
          );
        }

        // close() after abort must not emit session/close, session/cancel, or cancelled/selected replies.
        await session.close();
        expect(updates).toEqual([]);
        expect(perms.map((p) => p.interactionId)).toEqual([heldEvent.interactionId]);
        const calls = readJsonLines(join(root, 'calls.jsonl'));
        expect(
          calls.some((entry) => Array.isArray(entry) && entry[0] === 'session/close'),
        ).toBe(false);
        expect(
          calls.some((entry) => Array.isArray(entry) && entry[0] === 'session/cancel'),
        ).toBe(false);
        expect(readJsonLines(join(root, 'responses.jsonl'))).toEqual([]);
      }),
  );

  test('close() called immediately after abort() before exit fails turn with abort reason and writes zero wire traffic', () =>
    inScratch('acp-liveness-abort-then-close', async (root) => {
      trackPidFile(join(root, 'pid'));
      const heldReady = Promise.withResolvers<AcpPermissionRequestEvent>();
      const controller = new AbortController();
      const reason = new Error('immediate-abort-before-close');
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [PEER, root, 'abort-active'],
        ambient: ambientIn(root),
        permissionRequestDelivery: 'all',
        onPermissionRequest: (event) => heldReady.resolve(event),
      });
      const session = await driver.open({
        profile: { engine: 'acp', profileId: 'abort-close', home: root },
        cwd: root,
        signal: controller.signal,
      });
      const turn = await session.startTurn(TURN_INPUT);
      const turnFailure = captureRejection(drain(turn));
      await heldReady.promise;

      controller.abort(reason);
      await session.close();
      expect(await turnFailure).toBe(reason);
      const calls = readJsonLines(join(root, 'calls.jsonl'));
      expect(calls.some((entry) => Array.isArray(entry) && entry[0] === 'session/close')).toBe(
        false,
      );
      expect(readJsonLines(join(root, 'responses.jsonl'))).toEqual([]);
    }));

  test('watchPromptOutcome aborting inside checkOutcome fails turn with abort reason instead of completed', () =>
    inScratch('acp-liveness-watch-abort', async (root) => {
      trackPidFile(join(root, 'pid'));
      const controller = new AbortController();
      const reason = new Error('aborted-in-watch-outcome');
      const driver = createAcpDriver({
        executable: process.execPath,
        args: [PEER, root, 'abort-watch-outcome'],
        ambient: ambientIn(root),
        watchPromptOutcome: () => () => {
          controller.abort(reason);
          return undefined;
        },
      });
      const session = await driver.open({
        profile: { engine: 'acp', profileId: 'watch-abort', home: root },
        cwd: root,
        signal: controller.signal,
      });
      try {
        const turn = await session.startTurn(TURN_INPUT);
        expect(await captureRejection(drain(turn))).toBe(reason);
      } finally {
        await session.close();
      }
    }));
});

describe('ACP handlers and runAcpPrompt deterministic liveness guards', () => {
  test('createAcpHandlers drops closed requests silently and stops reentrant updates/observer errors after abort', async () => {
    const sent: string[] = [];
    const seenUpdates: string[] = [];
    const seenMeta: string[] = [];
    const externalPending = new Map<string, PendingExternalAcpRequest>();
    let alive = true;
    let transformCalls = 0;
    const reason = new Error('unit-aborted');
    const liveness = {
      ensureAlive: () => {
        if (!alive) throw reason;
      },
      isAlive: () => alive,
    };

    const handlers = createAcpHandlers({
      externalPending,
      liveness,
      isOpened: () => true,
      getTurn: () => undefined,
      onSessionMeta: (meta) => {
        if (meta.title !== undefined) seenMeta.push(meta.title);
      },
      transformUpdate: (update) => {
        transformCalls += 1;
        if (update.sessionUpdate === 'agent_message_chunk') {
          return [
            { sessionUpdate: 'session_info_update', title: 'first' },
            { sessionUpdate: 'session_info_update', title: 'second' },
          ];
        }
        return update;
      },
      onUpdate: (event) => {
        seenUpdates.push(event.update.sessionUpdate);
        alive = false;
      },
      onPermissionRequest: (event) => {
        if (event.interactionId === 'obs-sync-clean') {
          alive = false;
          return;
        }
        if (event.interactionId === 'obs-sync-throw') {
          alive = false;
          throw new JsonRpcError(-32001, 'sync-throw-after-abort');
        }
        return (async () => {
          if (event.interactionId === 'obs-async-clean-after-await') {
            await Promise.resolve();
            alive = false;
            return;
          }
          if (event.interactionId === 'obs-async-after-await') {
            await Promise.resolve();
            alive = false;
            throw new JsonRpcError(-32001, 'async-throw-after-abort');
          }
          alive = false;
          if (event.interactionId === 'obs-rpc-throw') {
            throw new JsonRpcError(-32001, 'must-not-leak-after-abort');
          }
          if (event.interactionId === 'obs-respond-throw') {
            await event.respond({ kind: 'approve' });
          }
        })();
      },
      onEnd: () => undefined,
    });

    const peer = createJsonRpcPeer({
      header: 'jsonrpc-2.0',
      requestTimeoutMs: 5_000,
      send: (line) => sent.push(line),
      onNotification: handlers.onNotification,
      onRequest: handlers.onRequest,
    });

    // 1. Reentrant abort in onUpdate stops iteration #2, and subsequent notifications skip transformUpdate.
    peer.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's-u',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'x' },
          },
        },
      }),
    );
    expect(seenMeta).toEqual(['first']);
    expect(seenUpdates).toEqual(['session_info_update']);
    expect(transformCalls).toBe(1);
    peer.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 's-u',
          update: { sessionUpdate: 'session_info_update', title: 'never-transformed' },
        },
      }),
    );
    expect(transformCalls).toBe(1);

    // 2. Closed peer drops both permission and unknown requests silently (sent === [], no -32601/-32603).
    peer.receive(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'closed-perm',
        method: 'session/request_permission',
        params: {
          sessionId: 's-u',
          toolCall: { toolCallId: 'tc-1', title: 'Closed' },
          options: [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }],
        },
      }),
    );
    peer.receive(
      JSON.stringify({ jsonrpc: '2.0', id: 'closed-unknown', method: 'unknown/foo' }),
    );
    await promiseJobsRan();
    expect(sent).toEqual([]);
    expect(externalPending.size).toBe(0);

    // 3. Reentrant abort inside sync/async onPermissionRequest (sync clean/throw, immediate async reject/return,
    // post-await clean/reject, event.respond throw) writes zero replies and empties externalPending.
    for (const id of [
      'obs-sync-clean',
      'obs-sync-throw',
      'obs-rpc-throw',
      'obs-async-clean-after-await',
      'obs-async-after-await',
      'obs-respond-throw',
      'obs-clean',
    ]) {
      alive = true;
      peer.receive(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'session/request_permission',
          params: {
            sessionId: 's-u',
            toolCall: { toolCallId: `tc-${id}`, title: id },
            options: [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }],
          },
        }),
      );
      await promiseJobsRan();
      expect(sent).toEqual([]);
      expect(externalPending.size).toBe(0);
    }

    // 4. Reentrant abort + throw inside transformUpdate and unknown notifications when !alive emit no unhandled deltas.
    alive = true;
    const activeTurn = newAcpTurn('t-xform');
    const throwHandlers = createAcpHandlers({
      externalPending: new Map(),
      liveness,
      isOpened: () => true,
      getTurn: () => activeTurn,
      onSessionMeta: () => undefined,
      transformUpdate: () => {
        alive = false;
        throw new Error('transform-boom');
      },
      onEnd: () => undefined,
    });
    throwHandlers.onNotification('session/update', {
      sessionId: 's-u',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
    });
    throwHandlers.onNotification('unknown/after-abort', { sessionId: 's-u' });
    expect(activeTurn.channel.getSnapshot().offered).toBe(0);
  });

  test('runAcpPrompt fails with liveness error without calling checkOutcome or emitting turn-end on abort', async () => {
    const abortErr = new Error('prompt-aborted');
    const abortedSession = sessionLiveness({
      closedMessage: 'The ACP session is closing',
      caller: undefined,
      linked: new AbortController().signal,
    });
    abortedSession.markLost(abortErr);

    // Case A: session/prompt resolves after abort -> checkOutcome is never called, pending requests are not replied to.
    {
      const sent: string[] = [];
      let checkCalled = false;
      let doneCalled = false;
      const peer = createJsonRpcPeer({
        header: 'jsonrpc-2.0',
        requestTimeoutMs: 5_000,
        send: (line) => sent.push(line),
      });
      const turn = newAcpTurn('t-resolve-after-abort');
      let resolvedPending = false;
      turn.pending.set('p-1', {
        detail: { options: [{ optionId: 'a', kind: 'allow_once', name: 'Allow' }] },
        answeredBy: { source: 'acp', type: 'session/request_permission' },
        resolve: () => {
          resolvedPending = true;
        },
      });
      runAcpPrompt({
        peer,
        sessionId: 's-1',
        prompt: [{ type: 'text', text: 'hi' }],
        turn,
        generation: 1,
        liveness: abortedSession,
        checkOutcome: () => {
          checkCalled = true;
          return undefined;
        },
        done: () => {
          doneCalled = true;
        },
      });
      const req = JSON.parse(sent[0] ?? '{}');
      peer.receive(
        JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn' } }),
      );
      expect(await captureRejection(drain({ deltas: turn.channel }))).toBe(abortErr);
      expect(checkCalled).toBe(false);
      expect(doneCalled).toBe(true);
      expect(resolvedPending).toBe(false);
      expect(turn.pending.size).toBe(0);
    }

    // Case B: session/prompt rejects with JsonRpcError (-32000) after abort -> fails with abortErr, NOT turn-end: failed.
    {
      const sent: string[] = [];
      const peer = createJsonRpcPeer({
        header: 'jsonrpc-2.0',
        requestTimeoutMs: 5_000,
        send: (line) => sent.push(line),
      });
      const turn = newAcpTurn('t-reject-after-abort');
      runAcpPrompt({
        peer,
        sessionId: 's-1',
        prompt: [{ type: 'text', text: 'hi' }],
        turn,
        generation: 1,
        liveness: abortedSession,
        done: () => undefined,
      });
      const req = JSON.parse(sent[0] ?? '{}');
      peer.receive(
        JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32000, message: 'auth required' },
        }),
      );
      expect(await captureRejection(drain({ deltas: turn.channel }))).toBe(abortErr);
    }
  });
});
