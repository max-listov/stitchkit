/**
 * Regressions for discarding Codex pre-`turn/start` buffers on disconnect, close, and abort,
 * and refusing `event.respond()` / `turn.respond()` once a Codex connection or thread is closed.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexStartingTurn } from '../../src/agent-executor/codex/event-routing';
import { createCodexHandlers } from '../../src/agent-executor/codex/handlers';
import { createJsonRpcPeer, JsonRpcError } from '../../src/agent-executor/json-rpc-peer';
import { TURN_QUEUE } from '../../src/agent-executor/session-primitives';
import { projectExecutorDeltas } from '../../src/entrypoints/agent-executor';
import {
  type CodexNotificationEvent,
  type CodexServerRequestEvent,
  createCodexDriver,
} from '../../src/entrypoints/agent-executor/codex';
import {
  createFakeCodexAppServer,
  makeCodexThreadFixture,
} from '../../src/entrypoints/agent-executor/testing';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');

type ReplyRecord =
  | { outcome: 'resolved'; value: unknown }
  | { outcome: 'rejected'; error: unknown };

function threadStartReply(id: string, cwd: string) {
  return {
    thread: makeCodexThreadFixture({ id, cwd }),
    model: 'gpt-5-codex',
    modelProvider: 'openai',
    cwd,
    approvalPolicy: 'on-request',
    sandbox: { type: 'workspaceWrite' },
  };
}

function approvalParams(threadId: string, turnId: string, itemId: string, command: string) {
  return { threadId, turnId, itemId, command };
}

function startInput(id: string, text: string) {
  return { turnId: id, clientId: `c-${id}`, input: [{ type: 'text' as const, text }] };
}

function profileFor(root: string, id: string) {
  return { profileId: id, engine: 'codex' as const, home: join(root, `h-${id}`) };
}

function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function expectNoRpcReplies(replies: readonly ReplyRecord[]): void {
  expect(replies.filter((r) => r.outcome === 'resolved')).toEqual([]);
  expect(
    replies.filter((r) => r.outcome === 'rejected' && r.error instanceof JsonRpcError),
  ).toEqual([]);
}

describe('Codex pre-turn-start teardown and dead-connection respond guards', () => {
  test('disconnect, session.close(), and AbortSignal during turn/start discard deferred frames without observer delivery or -32603 replies', () =>
    inScratch('codex-starting-teardown', async (root) => {
      for (const mode of ['disconnect', 'close', 'abort'] as const) {
        const sockDir = join(root, `s-${mode}`);
        mkdirSync(sockDir, { mode: 0o700 });
        const sockPath = join(sockDir, 'codex.sock');
        const events: string[] = [];
        const serverReplies: ReplyRecord[] = [];
        const started = Promise.withResolvers<void>();

        const server = await createFakeCodexAppServer({
          socketPath: sockPath,
          handlers: {
            'thread/start': () => threadStartReply(`thread-${mode}`, root),
            'turn/start': () => {
              server.sendNotification('item/agentMessage/delta', {
                threadId: `thread-${mode}`,
                turnId: `turn-${mode}`,
                itemId: 'early-msg',
                delta: 'must-not-deliver',
              });
              void server
                .sendRequest(
                  `req-${mode}`,
                  'item/commandExecution/requestApproval',
                  approvalParams(`thread-${mode}`, `turn-${mode}`, 'early-cmd', 'echo early'),
                )
                .then(
                  (value) => serverReplies.push({ outcome: 'resolved', value }),
                  (error: unknown) => serverReplies.push({ outcome: 'rejected', error }),
                );
              started.resolve();
              return 'hang';
            },
          },
        });
        try {
          const controller = new AbortController();
          const driver = createCodexDriver({
            transport: { kind: 'unix-connect', socketPath: sockPath },
            ambient: ambientIn(root),
            onNotification: (event) => events.push(`note:${event.method}`),
            onServerRequest: (event) => events.push(`req:${event.interactionId}`),
            onDisconnect: () => events.push('disconnect'),
          });
          const session = await driver.open({
            profile: profileFor(root, mode),
            cwd: root,
            ...(mode === 'abort' && { signal: controller.signal }),
          });
          const startErrorPromise = captureError(
            session.startTurn(startInput(`local-${mode}`, 'start')),
          );
          await started.promise;
          await Bun.sleep(40);
          if (mode === 'disconnect') await server.close();
          else if (mode === 'close') await session.close();
          else controller.abort(new Error('caller-aborted-session'));

          const startError = await startErrorPromise;
          expect(startError).toBeInstanceOf(Error);
          if (mode === 'abort') {
            expect(startError instanceof Error ? startError.message : '').toMatch(/aborted/i);
          }
          await Bun.sleep(40);
          await session.close();
          expect(events.filter((entry) => entry !== 'disconnect')).toEqual([]);
          if (mode === 'disconnect') expect(events).toEqual(['disconnect']);
          expectNoRpcReplies(serverReplies);
        } finally {
          await server.close();
        }
      }
    }));

  test('RPC failure on a live session flushes external events, stops reentrantly on close(), and rejects event.respond() on closed connections', () =>
    inScratch('codex-live-flush-and-respond', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'codex.sock');
      const liveNotes: CodexNotificationEvent[] = [];
      const seenExternal: CodexServerRequestEvent[] = [];
      const seenActive: CodexServerRequestEvent[] = [];
      const reentReplies: ReplyRecord[] = [];
      let closeOnFirstNote = false;
      let sessionToClose: { close(): Promise<void> } | undefined;

      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/start': () => threadStartReply('thread-live', root),
          'turn/start': async (params) => {
            const items =
              typeof params === 'object' && params !== null
                ? Reflect.get(params, 'input')
                : [];
            const text = Array.isArray(items)
              ? String(Reflect.get(Object(items[0]), 'text') ?? '')
              : '';
            if (text === 'fail-twice' || text === 'fail-with-req') {
              server.sendNotification('item/agentMessage/delta', {
                threadId: 'thread-live',
                turnId: 'ext-1',
                itemId: 'm1',
                delta: 'first-external',
              });
              if (text === 'fail-with-req') {
                void server
                  .sendRequest(
                    'req-reent-1',
                    'item/commandExecution/requestApproval',
                    approvalParams('thread-live', 'ext-1', 'cmd-r', 'echo reent'),
                  )
                  .then(
                    (value) => reentReplies.push({ outcome: 'resolved', value }),
                    (error: unknown) => reentReplies.push({ outcome: 'rejected', error }),
                  );
              }
              server.sendNotification('item/agentMessage/delta', {
                threadId: 'thread-live',
                turnId: 'ext-1',
                itemId: 'm2',
                delta: 'second-external',
              });
              await Bun.sleep(20);
              return { error: { code: -32000, message: 'turn busy' } };
            }
            return { turn: { id: 'turn-active', status: 'inProgress', items: [] } };
          },
        },
      });
      try {
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          serverRequestDelivery: 'all',
          onNotification: (event) => {
            liveNotes.push(event);
            if (closeOnFirstNote) void sessionToClose?.close();
          },
          onServerRequest: (event) => {
            if (event.duringActiveTurn) seenActive.push(event);
            else seenExternal.push(event);
          },
        });

        // 1. Live RPC error flushes deferred external events; active/external respond() rejects after close().
        const session = await driver.open({ profile: profileFor(root, 'live'), cwd: root });
        await expect(session.startTurn(startInput('t-fail', 'fail-twice'))).rejects.toThrow(
          /turn busy/,
        );
        expect(liveNotes.map((n) => [n.method, n.duringActiveTurn])).toEqual([
          ['item/agentMessage/delta', false],
          ['item/agentMessage/delta', false],
        ]);

        const turn = await session.startTurn(startInput('t-active', 'run'));
        void server
          .sendRequest(
            'req-active-1',
            'item/commandExecution/requestApproval',
            approvalParams('thread-live', 'turn-active', 'cmd-a', 'echo a'),
          )
          .catch(() => undefined);
        void server
          .sendRequest(
            'req-ext-1',
            'item/commandExecution/requestApproval',
            approvalParams('thread-other', 'turn-other', 'cmd-e', 'echo e'),
          )
          .catch(() => undefined);
        await waitUntil(
          () => seenActive.length > 0 && seenExternal.length > 0,
          'session requests',
        );
        await session.close();
        await expect(seenActive[0]?.respond({ kind: 'approve' })).rejects.toThrow(/closed/i);
        await expect(seenExternal[0]?.respond({ kind: 'approve' })).rejects.toThrow(/closed/i);
        await expect(turn.respond('req-active-1', { kind: 'approve' })).rejects.toThrow(
          /closed/i,
        );

        // 2. Control connection event.respond() rejects after close().
        const controlEvents: CodexServerRequestEvent[] = [];
        const control = await createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          onServerRequest: (event) => controlEvents.push(event),
        }).connectControl({ profile: profileFor(root, 'ctl'), cwd: root });
        void server
          .sendRequest(
            'req-ctl-1',
            'item/commandExecution/requestApproval',
            approvalParams('thread-other', 'turn-other', 'cmd-c', 'echo c'),
          )
          .catch(() => undefined);
        await waitUntil(() => controlEvents.length > 0, 'control request');
        await control.close();
        await expect(controlEvents[0]?.respond({ kind: 'approve' })).rejects.toThrow(
          /closed/i,
        );

        // 3. Reentrant close() inside first flushed note stops deferred request & second note without -32603.
        liveNotes.length = 0;
        seenExternal.length = 0;
        closeOnFirstNote = true;
        const reentrantSession = await driver.open({
          profile: profileFor(root, 'reent'),
          cwd: root,
        });
        sessionToClose = reentrantSession;
        await expect(
          reentrantSession.startTurn(startInput('t-reent', 'fail-with-req')),
        ).rejects.toThrow(/turn busy/);
        await reentrantSession.close();
        await Bun.sleep(30);
        expect(liveNotes).toHaveLength(1);
        expect(seenExternal).toEqual([]);
        expectNoRpcReplies(reentReplies);
      } finally {
        await server.close();
      }
    }));

  test('shared server thread.close(), thread signal abort, and server.close() discard pre-start buffers without breaking sibling threads', () =>
    inScratch('codex-shared-starting-teardown', async (root) => {
      const home = join(root, 'home');
      trackPidFile(join(home, 'shared-pid.txt'));
      const seenNotes: CodexNotificationEvent[] = [];
      const seenReqs: CodexServerRequestEvent[] = [];
      const server = await createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_SHARED_CODEX],
        ambient: { PATH: process.env.PATH, HOME: root },
        onNotification: (event) => seenNotes.push(event),
        onServerRequest: (event) => seenReqs.push(event),
      }).openSharedServer({
        profile: { profileId: 'p-shared-teardown', engine: 'codex', home },
        cwd: root,
      });
      try {
        // 1. threadA.close() during held turn/start (with late server success) drops frames; threadB works.
        const threadA = await server.openThread({ cwd: root });
        const threadB = await server.openThread({ cwd: root });
        const startAError = captureError(
          threadA.startTurn(startInput('a-held', 'HOLD_START_EARLY LATE_SUCCESS')),
        );
        await waitUntil(
          () => existsSync(join(home, `hold-started-${threadA.nativeThreadId}.txt`)),
          'hold-started A',
        );
        await Bun.sleep(30);
        const t0 = Date.now();
        await threadA.close();
        expect(await startAError).toBeInstanceOf(Error);
        expect(Date.now() - t0).toBeLessThan(2_000);
        await Bun.sleep(180);
        expect(
          seenNotes.filter(
            (n) =>
              typeof n.params === 'object' &&
              n.params !== null &&
              Reflect.get(n.params, 'threadId') === threadA.nativeThreadId,
          ),
        ).toEqual([]);
        expect(seenReqs).toEqual([]);
        expect(existsSync(join(home, 'responses.jsonl'))).toBe(false);

        const turnB = await threadB.startTurn(startInput('b-ok', 'still-alive'));
        const deltasB = [];
        for await (const delta of turnB.deltas) deltasB.push(delta);
        expect(projectExecutorDeltas(deltasB)).toEqual([
          { type: 'text', text: `${threadB.nativeThreadId}:still-alive` },
        ]);

        // 2. openThread({ signal }) abort and sharedServer.close() during held turn/start discard frames.
        for (const teardown of ['thread-abort', 'server-close'] as const) {
          seenNotes.length = 0;
          const threadAc = new AbortController();
          const target =
            teardown === 'thread-abort'
              ? await server.openThread({ cwd: root, signal: threadAc.signal })
              : threadB;
          const errPromise = captureError(
            target.startTurn(startInput(`${teardown}-held`, 'HOLD_START_EARLY')),
          );
          await waitUntil(
            () => existsSync(join(home, `hold-started-${target.nativeThreadId}.txt`)),
            `hold-started ${teardown}`,
          );
          await Bun.sleep(30);
          if (teardown === 'thread-abort') threadAc.abort(new Error('thread-signal-aborted'));
          else await server.close();
          expect(await errPromise).toBeInstanceOf(Error);
          await Bun.sleep(40);
          expect(seenNotes).toEqual([]);
          expect(seenReqs).toEqual([]);
          expect(existsSync(join(home, 'responses.jsonl'))).toBe(false);
        }
      } finally {
        await server.close();
      }
    }));

  test('disconnect rejects event.respond()/turn.respond(), closed onRequest stays silent, and discard stops flush failure', () =>
    inScratch('codex-disconnect-and-drop-guards', async (root) => {
      // 1. Disconnect rejects active/external event.respond() and turn.respond() via ensureAlive (not TypeError).
      const sockDir = join(root, 'sd');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'codex.sock');
      const activeReqs: CodexServerRequestEvent[] = [];
      const extReqs: CodexServerRequestEvent[] = [];
      const disconnected = Promise.withResolvers<void>();
      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/start': () => threadStartReply('thread-disc', root),
          'turn/start': () => ({ turn: { id: 'turn-disc', status: 'inProgress', items: [] } }),
        },
      });
      try {
        const session = await createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          serverRequestDelivery: 'all',
          onDisconnect: () => disconnected.resolve(),
          onServerRequest: (event) => {
            if (event.duringActiveTurn) activeReqs.push(event);
            else extReqs.push(event);
          },
        }).open({ profile: profileFor(root, 'disc'), cwd: root });
        const turn = await session.startTurn(startInput('td', 'hi'));
        void server
          .sendRequest(
            'req-da',
            'item/commandExecution/requestApproval',
            approvalParams('thread-disc', 'turn-disc', 'ca', 'echo da'),
          )
          .catch(() => undefined);
        void server
          .sendRequest(
            'req-de',
            'item/commandExecution/requestApproval',
            approvalParams('thread-other', 'turn-other', 'ce', 'echo de'),
          )
          .catch(() => undefined);
        await waitUntil(
          () => activeReqs.length > 0 && extReqs.length > 0,
          'disconnect requests',
        );
        await server.close();
        await disconnected.promise;
        for (const call of [
          activeReqs[0]?.respond({ kind: 'approve' }),
          extReqs[0]?.respond({ kind: 'approve' }),
          turn.respond('req-da', { kind: 'approve' }),
        ]) {
          const err = await captureError(call ?? Promise.resolve());
          expect(err).toBeInstanceOf(Error);
          expect(err).not.toBeInstanceOf(TypeError);
        }
        await session.close();
      } finally {
        await server.close();
      }

      // 2. Closed handler drops incoming JSON-RPC requests silently (no -32603 reply on the wire).
      const sent: string[] = [];
      const seenUnitReqs: CodexServerRequestEvent[] = [];
      const handlers = createCodexHandlers({
        profileId: 'p-unit',
        limits: new Map(),
        externalPending: new Map(),
        getTurn: () => undefined,
        clearTurn: () => undefined,
        ensureAlive: () => {
          throw new Error('The Codex session is closed');
        },
        onServerRequest: (event) => seenUnitReqs.push(event),
      });
      const peer = createJsonRpcPeer({
        header: 'omitted',
        requestTimeoutMs: 5_000,
        send: (line) => sent.push(line),
        onNotification: handlers.onNotification,
        onRequest: handlers.onRequest,
      });
      peer.receive(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 77,
          method: 'item/commandExecution/requestApproval',
          params: approvalParams('t', 'u', 'i', 'echo x'),
        }),
      );
      await Bun.sleep(20);
      expect(seenUnitReqs).toEqual([]);
      expect(sent).toEqual([]);
      peer.close(new Error('done'));

      // 3. CodexStartingTurn.discard() inside flush() stops remaining frames and suppresses queue overflow failure.
      const starting = new CodexStartingTurn();
      const order: string[] = [];
      starting.defer({ a: 1 }, () => {
        order.push('first');
        starting.discard();
      });
      starting.defer({ a: 2 }, () => order.push('second'));
      expect(() =>
        starting.defer({ huge: 'x'.repeat(TURN_QUEUE.maxBytes + 1) }, () => undefined),
      ).toThrow(/turn queue limit/);
      expect(() => starting.flush()).not.toThrow();
      expect(order).toEqual(['first']);
    }));
});
