/**
 * Regressions for discarding Codex pre-`turn/start` buffers on disconnect, close, and abort,
 * and refusing `event.respond()` / `turn.respond()` once a Codex connection or thread is closed.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexStartingTurn } from '../../src/agent-executor/codex/event-routing';
import { createCodexHandlers } from '../../src/agent-executor/codex/handlers';
import { CodexLimitBook } from '../../src/agent-executor/codex/limits';
import type { PendingExternalCodexRequest } from '../../src/agent-executor/codex/request-answers';
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
import { probeLiveness } from '../../src/internal/process-identity';
import { ambientIn, inScratch, promiseJobsRan } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');
const STDIO_ABORT_PEER = resolve(import.meta.dir, '../fixtures/codex-stdio-abort-peer.ts');

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

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function responsesFor(home: string, id: number): unknown[] {
  return readJsonl(join(home, 'responses.jsonl')).filter(
    (response) => Reflect.get(Object(response), 'id') === id,
  );
}

function interruptsFor(home: string, threadId: string): unknown[] {
  return readJsonl(join(home, 'turn-interrupt.jsonl')).filter(
    (call) => Reflect.get(Object(call), 'threadId') === threadId,
  );
}

function openShared(root: string, home: string) {
  return createCodexDriver({
    executable: process.execPath,
    prefixArgs: [FAKE_SHARED_CODEX],
    ambient: { PATH: process.env.PATH, HOME: root },
  }).openSharedServer({
    profile: { profileId: 'p-shared-abandoned', engine: 'codex', home },
    cwd: root,
  });
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
              // Frames on one socket arrive in order: once the driver tells this note of another
              // thread, which it does not hold back, it has received the two frames before it.
              server.sendNotification('item/agentMessage/delta', {
                threadId: `other-${mode}`,
                turnId: 'other-turn',
                itemId: 'received-marker',
                delta: 'received',
              });
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
          await waitUntil(
            () => events.length === 1,
            'the frames sent before the turn/start reply',
          );
          expect(events).toEqual(['note:item/agentMessage/delta']);
          if (mode === 'disconnect') await server.close();
          else if (mode === 'close') await session.close();
          else controller.abort(new Error('caller-aborted-session'));

          const startError = await startErrorPromise;
          expect(startError).toBeInstanceOf(Error);
          if (mode === 'abort') {
            expect(startError instanceof Error ? startError.message : '').toMatch(/aborted/i);
          }
          // The server's request settles when the server sees the connection end: with an answer
          // the driver wrote before that, or with the end itself. close() waits for the driver's
          // reader, so nothing it received is still on its way to an observer.
          await waitUntil(() => serverReplies.length === 1, 'the server request to settle');
          await session.close();
          expect(events.filter((entry) => entry !== 'disconnect')).toEqual([
            'note:item/agentMessage/delta',
          ]);
          if (mode === 'disconnect')
            expect(events).toEqual(['note:item/agentMessage/delta', 'disconnect']);
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
        // close() waited for the driver's reader; the server's request settles once the server
        // sees the connection end, with whatever answer was written before it.
        await waitUntil(() => reentReplies.length === 1, 'the server request to settle');
        expect(liveNotes).toHaveLength(1);
        expect(seenExternal).toEqual([]);
        expectNoRpcReplies(reentReplies);
      } finally {
        await server.close();
      }
    }));

  test('shared server thread.close() and thread signal abort answer held requests and interrupt the turn once, server.close() leaves them to the process exit, sibling threads keep working', () =>
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
        // 1. threadA.close() during a held turn/start: the shared server keeps running for B, so A's
        //    early approval gets exactly one stopped answer and A's server turn exactly one interrupt.
        const threadA = await server.openThread({ cwd: root });
        const threadB = await server.openThread({ cwd: root });
        const startAError = captureError(
          threadA.startTurn(startInput('a-held', 'HOLD_START_EARLY LATE_SUCCESS')),
        );
        const heldA = join(home, `hold-started-${threadA.nativeThreadId}.txt`);
        await waitUntil(() => existsSync(heldA), 'hold-started A');
        const t0 = Date.now();
        await threadA.close();
        expect(await startAError).toBeInstanceOf(Error);
        expect(Date.now() - t0).toBeLessThan(2_000);
        const earlyA = Number(readFileSync(heldA, 'utf8'));
        expect(responsesFor(home, earlyA)).toEqual([
          { id: earlyA, result: { decision: 'cancel' } },
        ]);
        expect(interruptsFor(home, threadA.nativeThreadId)).toHaveLength(1);
        // The late turn/start reply and the interrupt's turn/completed precede B's turn on the one
        // server pipe: once B's turn ends, nothing of A's is still in flight.
        await waitUntil(
          () => existsSync(join(home, `late-reply-sent-${threadA.nativeThreadId}.txt`)),
          'late reply A',
        );
        const turnB = await threadB.startTurn(startInput('b-ok', 'still-alive'));
        const deltasB = [];
        for await (const delta of turnB.deltas) deltasB.push(delta);
        expect(projectExecutorDeltas(deltasB)).toEqual([
          { type: 'text', text: `${threadB.nativeThreadId}:still-alive` },
        ]);
        expect(
          seenNotes.filter(
            (n) =>
              typeof n.params === 'object' &&
              n.params !== null &&
              Reflect.get(n.params, 'threadId') === threadA.nativeThreadId,
          ),
        ).toEqual([]);
        expect(seenReqs).toEqual([]);

        // 2. openThread({ signal }) abort retires the thread like close(); sharedServer.close()
        //    stops the whole process, so its held request is left to the process exit.
        for (const teardown of ['thread-abort', 'server-close'] as const) {
          seenNotes.length = 0;
          const threadAc = new AbortController();
          const target =
            teardown === 'thread-abort'
              ? await server.openThread({ cwd: root, signal: threadAc.signal })
              : threadB;
          const errPromise = captureError(
            target.startTurn(startInput(`${teardown}-held`, 'HOLD_START_EARLY LATE_SUCCESS')),
          );
          const held = join(home, `hold-started-${target.nativeThreadId}.txt`);
          await waitUntil(() => existsSync(held), `hold-started ${teardown}`);
          if (teardown === 'thread-abort') threadAc.abort(new Error('thread-signal-aborted'));
          else await server.close();
          expect(await errPromise).toBeInstanceOf(Error);
          const early = Number(readFileSync(held, 'utf8'));
          if (teardown === 'thread-abort') {
            await waitUntil(() => responsesFor(home, early).length > 0, 'stopped answer');
            await waitUntil(
              () => interruptsFor(home, target.nativeThreadId).length > 0,
              'abandoned turn interrupt',
            );
            expect(responsesFor(home, early)).toEqual([
              { id: early, result: { decision: 'cancel' } },
            ]);
            expect(interruptsFor(home, target.nativeThreadId)).toHaveLength(1);
          } else {
            // The process is gone once close() resolves: nothing more can reach the wire.
            expect(responsesFor(home, early)).toEqual([]);
          }
          expect(seenNotes).toEqual([]);
          expect(seenReqs).toEqual([]);
        }
      } finally {
        await server.close();
      }
    }));

  async function withSharedServer(
    label: string,
    run: (
      server: Awaited<ReturnType<typeof openShared>>,
      home: string,
      root: string,
    ) => Promise<void>,
  ): Promise<void> {
    await inScratch(label, async (root) => {
      const home = join(root, 'home');
      trackPidFile(join(home, 'shared-pid.txt'));
      const server = await openShared(root, home);
      try {
        await run(server, home, root);
      } finally {
        await server.close();
      }
    });
  }

  test('shared server: closing a thread with a streaming turn interrupts that turn once', () =>
    withSharedServer('codex-shared-streaming-close', async (server, home, root) => {
      // A streaming turn holds no request: before the fix, close() only unsubscribed it.
      const streaming = await server.openThread({ cwd: root });
      const turn = await streaming.startTurn(startInput('s-1', 'HOLD_STREAMING'));
      const first = await turn.deltas[Symbol.asyncIterator]().next();
      expect(first.value?.type).toBe('text');
      await streaming.close();
      const turnId = readFileSync(
        join(home, `streaming-${streaming.nativeThreadId}.txt`),
        'utf8',
      );
      expect(interruptsFor(home, streaming.nativeThreadId)).toEqual([
        { threadId: streaming.nativeThreadId, turnId },
      ]);
      expect(server.activeThreadCount).toBe(0);
    }));

  test('a turn/start reply the driver cannot read interrupts the turn a prior event named, once', () =>
    withSharedServer('codex-shared-malformed-start', async (server, home, root) => {
      const malformed = await server.openThread({ cwd: root });
      await expect(
        malformed.startTurn(startInput('m-1', 'MALFORMED_START')),
      ).rejects.toThrow();
      const turnId = readFileSync(
        join(home, `streaming-${malformed.nativeThreadId}.txt`),
        'utf8',
      );
      await waitUntil(
        () => interruptsFor(home, malformed.nativeThreadId).length > 0,
        'malformed-start interrupt',
      );
      expect(interruptsFor(home, malformed.nativeThreadId)).toEqual([
        { threadId: malformed.nativeThreadId, turnId },
      ]);
      // Closing the thread afterwards does not interrupt the same turn twice.
      await malformed.close();
      expect(interruptsFor(home, malformed.nativeThreadId)).toHaveLength(1);
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
        sharedWithOtherClients: true,
        profileId: 'p-unit',
        limits: new CodexLimitBook(),
        externalPending: new Map(),
        getTurn: () => undefined,
        clearTurn: () => undefined,
        liveness: {
          ensureAlive: () => {
            throw new Error('The Codex session is closed');
          },
          isAlive: () => false,
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
      await promiseJobsRan();
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

  test('unit: onObserverError and post-observer cleanup suppress post-abort JsonRpcError replies and unhandled rejections', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const sent: string[] = [];
      let alive = true;
      const externalPending = new Map<string, PendingExternalCodexRequest>();
      const releaseAsyncReject = Promise.withResolvers<void>();
      const releaseAsyncClean = Promise.withResolvers<void>();
      const handlers = createCodexHandlers({
        sharedWithOtherClients: true,
        profileId: 'p-obs',
        limits: new CodexLimitBook(),
        externalPending,
        getTurn: () => undefined,
        clearTurn: () => undefined,
        liveness: {
          ensureAlive: () => {
            if (!alive) throw new Error('aborted');
          },
          isAlive: () => alive,
        },
        onServerRequest: (event) => {
          if (event.interactionId === 'live-rpc-err') {
            return (async () => {
              throw new JsonRpcError(-32001, 'live-denied');
            })();
          }
          if (event.interactionId === 'async-after-abort-err') {
            return (async () => {
              await releaseAsyncReject.promise;
              throw new JsonRpcError(-32002, 'must-not-send');
            })();
          }
          if (event.interactionId === 'async-sync-abort-err') {
            return (async () => {
              alive = false;
              throw new JsonRpcError(-32003, 'sync-abort-async-err');
            })();
          }
          if (event.interactionId === 'sync-abort-err') {
            alive = false;
            throw new JsonRpcError(-32004, 'sync-abort-err');
          }
          if (event.interactionId === 'sync-abort-clean') {
            alive = false;
            return;
          }
          if (event.interactionId === 'async-after-abort-clean') {
            return (async () => {
              await releaseAsyncClean.promise;
            })();
          }
        },
      });
      const peer = createJsonRpcPeer({
        header: 'omitted',
        requestTimeoutMs: 5_000,
        send: (line) => sent.push(line),
        onNotification: handlers.onNotification,
        onRequest: handlers.onRequest,
      });
      const sendReq = (id: string) =>
        peer.receive(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'item/commandExecution/requestApproval',
            params: approvalParams('t', 'u', `item-${id}`, 'echo x'),
          }),
        );

      // 1. Positive control: live JsonRpcError IS forwarded to peer.
      sendReq('live-rpc-err');
      await promiseJobsRan();
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
        id: 'live-rpc-err',
        error: { code: -32001, message: 'live-denied' },
      });
      expect(externalPending.size).toBe(0);
      sent.length = 0;

      // 2. Async observer awaits -> abort happens before onDisconnect -> observer throws JsonRpcError.
      sendReq('async-after-abort-err');
      expect(externalPending.has('async-after-abort-err')).toBe(true);
      alive = false;
      releaseAsyncReject.resolve();
      await promiseJobsRan();
      expect(sent).toEqual([]);
      expect(externalPending.size).toBe(0);

      // 3. Async observer synchronously sets alive=false and throws JsonRpcError (no unhandled rejection).
      alive = true;
      sendReq('async-sync-abort-err');
      await promiseJobsRan();
      expect(sent).toEqual([]);
      expect(externalPending.size).toBe(0);

      // 4. Sync observer sets alive=false and throws JsonRpcError.
      alive = true;
      sendReq('sync-abort-err');
      await promiseJobsRan();
      expect(sent).toEqual([]);
      expect(externalPending.size).toBe(0);

      // 5. Sync observer sets alive=false and returns cleanly.
      alive = true;
      sendReq('sync-abort-clean');
      await promiseJobsRan();
      expect(sent).toEqual([]);
      expect(externalPending.size).toBe(0);

      // 6. Async observer awaits -> external abort -> resolves cleanly.
      alive = true;
      sendReq('async-after-abort-clean');
      expect(externalPending.has('async-after-abort-clean')).toBe(true);
      alive = false;
      releaseAsyncClean.resolve();
      await promiseJobsRan();
      expect(sent).toEqual([]);
      expect(externalPending.size).toBe(0);

      peer.close(new Error('done'));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('stdio session: pre-open sync abort listener and post-exit event.respond() preserve exact caller reason without unhandled rejections', () =>
    inScratch('codex-stdio-abort-observer', async (root) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        // 1. Positive control on real stdio peer: live JsonRpcError reaches responses.jsonl.
        const liveRoot = join(root, 'live');
        mkdirSync(liveRoot, { recursive: true });
        trackPidFile(join(liveRoot, 'pid'));
        const liveSession = await createCodexDriver({
          executable: process.execPath,
          prefixArgs: [STDIO_ABORT_PEER, liveRoot, 'live-positive'],
          ambient: ambientIn(liveRoot),
          onServerRequest: async () => {
            throw new JsonRpcError(-32005, 'live-wire-error');
          },
        }).open({ profile: profileFor(liveRoot, 'stdio-live'), cwd: liveRoot });
        await waitUntil(() => existsSync(join(liveRoot, 'responses.jsonl')), 'live response');
        const liveLines = readFileSync(join(liveRoot, 'responses.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(liveLines).toContainEqual(
          expect.objectContaining({
            id: 'ext-abort-1',
            error: expect.objectContaining({ code: -32005, message: 'live-wire-error' }),
          }),
        );
        await liveSession.close();

        // 2. Abort window on real stdio peer: child stays alive on SIGTERM until release-exit.
        const abortRoot = join(root, 'abort');
        mkdirSync(abortRoot, { recursive: true });
        trackPidFile(join(abortRoot, 'pid'));
        const controller = new AbortController();
        const reqArrived = Promise.withResolvers<CodexServerRequestEvent>();
        const releaseObserver = Promise.withResolvers<void>();
        let heldEvent: CodexServerRequestEvent | undefined;
        let syncAbortRespondErr: Promise<unknown> | undefined;
        // Registered BEFORE open() so it fires before linkAbortSignals forwarder.
        controller.signal.addEventListener(
          'abort',
          () => {
            if (heldEvent !== undefined) {
              syncAbortRespondErr = captureError(heldEvent.respond({ kind: 'approve' }));
            }
          },
          { once: true },
        );

        const session = await createCodexDriver({
          executable: process.execPath,
          prefixArgs: [STDIO_ABORT_PEER, abortRoot, 'abort-observer'],
          ambient: ambientIn(abortRoot),
          onServerRequest: async (event) => {
            heldEvent = event;
            reqArrived.resolve(event);
            await releaseObserver.promise;
            throw new JsonRpcError(-32006, 'post-abort-must-not-reach-wire');
          },
        }).open({
          profile: profileFor(abortRoot, 'stdio-abort'),
          cwd: abortRoot,
          signal: controller.signal,
        });
        const pid = Number(readFileSync(join(abortRoot, 'pid'), 'utf8').trim());
        const event = await reqArrived.promise;

        const reason = new Error('codex-stdio-caller-aborted');
        controller.abort(reason);
        // Pre-open sync listener rejected with exact caller reason.
        expect(await syncAbortRespondErr).toBe(reason);
        // Child received SIGTERM and is STILL ALIVE (before onDisconnect).
        await waitUntil(() => existsSync(join(abortRoot, 'sigterm-received')), 'sigterm');
        releaseObserver.resolve();
        // The observer's late JsonRpcError has gone through the driver by the next macrotask.
        // That it is not written is proven without a process in the handler test above (`sent`
        // stays empty); here the child is released only after the driver had its chance to write.
        await promiseJobsRan();
        writeFileSync(join(abortRoot, 'release-exit'), '1');
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && (await probeLiveness(pid)) !== 'gone') {
          await Bun.sleep(10);
        }
        expect(await probeLiveness(pid)).toBe('gone');
        // The child is gone: what it recorded is final.
        expect(existsSync(join(abortRoot, 'responses.jsonl'))).toBe(false);
        // Post-exit event.respond() preserves exact caller abort reason (not generic exit error).
        expect(await captureError(event.respond({ kind: 'approve' }))).toBe(reason);
        expect(unhandled).toEqual([]);
        await session.close();
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    }));

  test('shared server and control connection: live stdio pipe suppresses post-abort onServerRequest JsonRpcError and CodexTurn.interrupt(), and preserves thread/server/control abort reasons', () =>
    inScratch('codex-shared-and-control-abort', async (root) => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        // 1. Shared server over live stdio: aborting Thread A leaves the server pipe OPEN, so
        //    only codex/handlers.ts:306 prevents async onServerRequest JsonRpcError from hitting wire,
        //    and only codex/thread-open.ts prevents CodexTurn.interrupt() from sending turn/interrupt.
        const sharedRoot = join(root, 'shared');
        mkdirSync(sharedRoot, { recursive: true });
        trackPidFile(join(sharedRoot, 'pid'));
        const serverAc = new AbortController();
        const threadAc = new AbortController();
        const extReqArrived = Promise.withResolvers<CodexServerRequestEvent>();
        const releaseExtObserver = Promise.withResolvers<void>();
        let extEvent: CodexServerRequestEvent | undefined;
        let syncThreadRespondErr: Promise<unknown> | undefined;
        // Registered BEFORE openThread() to verify pre-open FIFO listener ordering.
        threadAc.signal.addEventListener(
          'abort',
          () => {
            if (extEvent !== undefined) {
              syncThreadRespondErr = captureError(extEvent.respond({ kind: 'approve' }));
            }
          },
          { once: true },
        );

        const server = await createCodexDriver({
          executable: process.execPath,
          prefixArgs: [STDIO_ABORT_PEER, sharedRoot, 'shared-thread-abort'],
          ambient: ambientIn(sharedRoot),
          onServerRequest: async (event) => {
            if (event.interactionId === 'shared-ext-1') {
              extEvent = event;
              extReqArrived.resolve(event);
              await releaseExtObserver.promise;
              throw new JsonRpcError(-32007, 'shared-thread-post-abort-must-not-send');
            }
          },
        }).openSharedServer({
          profile: profileFor(sharedRoot, 'shared-abort'),
          cwd: sharedRoot,
          signal: serverAc.signal,
        });
        const threadA = await server.openThread({ cwd: sharedRoot, signal: threadAc.signal });
        const threadB = await server.openThread({ cwd: sharedRoot });
        const arrivedExt = await extReqArrived.promise;

        // Start active turn on Thread A holding an active approval request (`shared-act-1`).
        const turnA = await threadA.startTurn(startInput('t-shared-a', 'go'));
        const iterA = turnA.deltas[Symbol.asyncIterator]();
        const firstA = await iterA.next();
        expect(firstA.value?.type).toBe('request');
        const turnAFailure = captureError(
          (async () => {
            for (;;) {
              const next = await iterA.next();
              if (next.done) break;
            }
          })(),
        );

        const threadReason = new Error('shared-thread-A-aborted');
        threadAc.abort(threadReason);
        // Pre-open sync listener AND post-abort respond() all preserve exact `threadReason` (not generic closed).
        expect(await syncThreadRespondErr).toBe(threadReason);
        expect(await turnAFailure).toBe(threadReason);
        expect(await captureError(arrivedExt.respond({ kind: 'approve' }))).toBe(threadReason);
        expect(await captureError(turnA.respond('shared-act-1', { kind: 'approve' }))).toBe(
          threadReason,
        );
        expect(await captureError(threadA.respond('shared-ext-1', { kind: 'approve' }))).toBe(
          threadReason,
        );
        // Release async observer while server stdio pipe is STILL LIVE -> its JsonRpcError is not written:
        // the abort already answered shared-ext-1 as stopped.
        releaseExtObserver.resolve();
        // Calling turnA.interrupt() after thread abort must be a no-op: the abort sent the one interrupt.
        await turnA.interrupt();

        // Sibling Thread B proves the shared server stdio pipe is genuinely still open and functional.
        const turnB = await threadB.startTurn(startInput('t-shared-b', 'still-alive'));
        const deltasB = [];
        for await (const delta of turnB.deltas) deltasB.push(delta);
        expect(projectExecutorDeltas(deltasB)).toEqual([{ type: 'text', text: 'sibling-ok' }]);
        // Calling interrupt() on a settled turnB must be a no-op (zero turn/interrupt sent).
        await turnB.interrupt();

        // Check live wire logs, written before B's turn on the one pipe: shared-ext-1 got exactly the
        // stopped answer (never the observer's error), and the aborted turn exactly one interrupt.
        const responses = readJsonl(join(sharedRoot, 'responses.jsonl'));
        expect(
          responses.filter((r) => Reflect.get(Object(r), 'id') === 'shared-ext-1'),
        ).toEqual([{ id: 'shared-ext-1', result: { decision: 'cancel' } }]);
        const calls = readJsonl(join(sharedRoot, 'calls.jsonl'));
        expect(
          calls.filter((c) => Array.isArray(c) && c[0] === 'turn/interrupt'),
        ).toHaveLength(1);

        // Now abort the shared server itself -> Thread B preserves exact `serverReason` (not generic AbortError/closed).
        const serverReason = new Error('shared-server-aborted');
        serverAc.abort(serverReason);
        expect(await captureError(threadB.respond('any', { kind: 'approve' }))).toBe(
          serverReason,
        );
        expect(await captureError(threadB.startTurn(startInput('t-after-srv', 'no')))).toBe(
          serverReason,
        );
        await server.close();

        // 2. connectControl({ signal }): pre-open sync listener + post-abort preserve exact `controlReason`.
        const ctlRoot = join(root, 'ctl');
        mkdirSync(ctlRoot, { recursive: true });
        trackPidFile(join(ctlRoot, 'pid'));
        const ctlAc = new AbortController();
        const ctlEventReady = Promise.withResolvers<CodexServerRequestEvent>();
        let ctlEvent: CodexServerRequestEvent | undefined;
        let syncCtlErr: Promise<unknown> | undefined;
        ctlAc.signal.addEventListener(
          'abort',
          () => {
            if (ctlEvent !== undefined) {
              syncCtlErr = captureError(ctlEvent.respond({ kind: 'approve' }));
            }
          },
          { once: true },
        );
        const control = await createCodexDriver({
          executable: process.execPath,
          prefixArgs: [STDIO_ABORT_PEER, ctlRoot, 'control-abort'],
          ambient: ambientIn(ctlRoot),
          onServerRequest: (event) => {
            ctlEvent = event;
            ctlEventReady.resolve(event);
          },
        }).connectControl({
          profile: profileFor(ctlRoot, 'ctl-abort'),
          cwd: ctlRoot,
          signal: ctlAc.signal,
        });
        const readyCtlEvent = await ctlEventReady.promise;
        const controlReason = new Error('codex-control-aborted');
        ctlAc.abort(controlReason);
        expect(await syncCtlErr).toBe(controlReason);
        expect(await captureError(readyCtlEvent.respond({ kind: 'approve' }))).toBe(
          controlReason,
        );
        expect(await captureError(control.respond('ctl-abort-1', { kind: 'approve' }))).toBe(
          controlReason,
        );
        await control.close();

        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    }));
});
