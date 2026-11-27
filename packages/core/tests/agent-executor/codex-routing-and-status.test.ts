/**
 * Regressions for Codex thread/turn event and server-request routing across standalone sessions
 * and shared multi-thread servers, including fork-on-same-connection, stale previous-turn
 * completions, and notifications/requests arriving before `turn/start` responds.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type ExecutorDelta,
  projectExecutorDeltas,
} from '../../src/entrypoints/agent-executor';
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

async function collectTurn(
  turn: { deltas: AsyncIterable<ExecutorDelta> },
  onDelta?: (delta: ExecutorDelta) => Promise<void>,
): Promise<ExecutorDelta[]> {
  const out: ExecutorDelta[] = [];
  for await (const delta of turn.deltas) {
    out.push(delta);
    await onDelta?.(delta);
  }
  return out;
}

describe('Codex thread and turn event routing', () => {
  test('foreign forked thread completion on the same connection does not close active thread A or steal its text', () =>
    inScratch('codex-route-fork', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'codex.sock');
      const notifications: CodexNotificationEvent[] = [];

      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/start': () => ({
            thread: makeCodexThreadFixture({ id: 'thread-A', cwd: root }),
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          }),
          'thread/fork': () => ({
            thread: makeCodexThreadFixture({ id: 'thread-B', cwd: root }),
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          }),
          'turn/start': (params) => {
            const threadId =
              typeof params === 'object' && params !== null
                ? Reflect.get(params, 'threadId')
                : undefined;
            const turnId = threadId === 'thread-B' ? 'turn-B-1' : 'turn-A-1';
            return { turn: { id: turnId, status: 'inProgress', items: [] } };
          },
        },
      });
      try {
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          onNotification: (event) => notifications.push(event),
        });
        const sessionA = await driver.open({
          profile: { profileId: 'p-fork', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        try {
          const forkB = await sessionA.forkThread();
          expect(forkB.nativeThreadId).toBe('thread-B');

          const turnA = await sessionA.startTurn({
            turnId: 'local-A-1',
            clientId: 'client-A-1',
            input: [{ type: 'text', text: 'hello A' }],
          });
          expect(turnA.nativeTurnId).toBe('turn-A-1');

          const drainingA = collectTurn(turnA);

          // Fork B emits text and completes BEFORE A finishes.
          server.sendNotification('item/agentMessage/delta', {
            threadId: 'thread-B',
            turnId: 'turn-B-1',
            itemId: 'msg-B',
            delta: 'reply from B',
          });
          server.sendNotification('turn/completed', {
            threadId: 'thread-B',
            turn: { id: 'turn-B-1', status: 'completed', items: [] },
          });

          // Now A emits its own text and completes.
          server.sendNotification('item/agentMessage/delta', {
            threadId: 'thread-A',
            turnId: 'turn-A-1',
            itemId: 'msg-A',
            delta: 'reply from A',
          });
          server.sendNotification('turn/completed', {
            threadId: 'thread-A',
            turn: { id: 'turn-A-1', status: 'completed', items: [] },
          });

          const deltasA = await drainingA;
          expect(projectExecutorDeltas(deltasA)).toEqual([
            { type: 'text', text: 'reply from A' },
          ]);
          expect(deltasA.filter((d) => d.type === 'turn-end')).toHaveLength(1);
          expect(deltasA.at(-1)).toMatchObject({
            type: 'turn-end',
            turnId: 'local-A-1',
            outcome: 'completed',
          });

          // Observer received B's text and turn-end as external (duringActiveTurn: false).
          const bNotes = notifications.filter(
            (n) =>
              typeof n.params === 'object' &&
              n.params !== null &&
              Reflect.get(n.params, 'threadId') === 'thread-B',
          );
          expect(bNotes.map((n) => n.method)).toEqual([
            'item/agentMessage/delta',
            'turn/completed',
          ]);
          expect(bNotes.every((n) => n.duringActiveTurn === false)).toBe(true);
          expect(bNotes[0]?.deltas).toEqual([
            expect.objectContaining({
              type: 'text',
              text: 'reply from B',
              turnId: 'turn-B-1',
            }),
          ]);
          expect(bNotes[1]?.deltas).toEqual([
            expect.objectContaining({
              type: 'turn-end',
              outcome: 'completed',
              turnId: 'turn-B-1',
            }),
          ]);

          // Observer saw A's own text and turn-end with duringActiveTurn: true.
          const aNotes = notifications.filter(
            (n) =>
              typeof n.params === 'object' &&
              n.params !== null &&
              Reflect.get(n.params, 'threadId') === 'thread-A',
          );
          expect(aNotes.every((n) => n.duringActiveTurn === true)).toBe(true);
        } finally {
          await sessionA.close();
        }
      } finally {
        await server.close();
      }
    }));

  test('late previous-turn completion, cross-thread/cross-turn requests, pre-turn-start notifications, and single-turn positive control route accurately', () =>
    inScratch('codex-route-turns-and-requests', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'codex.sock');
      const notifications: CodexNotificationEvent[] = [];
      const externalRequests: CodexServerRequestEvent[] = [];
      let turnCounter = 0;
      let earlyAnswer: Promise<unknown> | undefined;

      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/start': () => ({
            thread: makeCodexThreadFixture({ id: 'thread-A', cwd: root }),
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          }),
          'turn/start': async () => {
            turnCounter += 1;
            const id = `turn-A-${turnCounter}`;
            if (turnCounter === 4) {
              earlyAnswer = server.sendRequest(
                'early-request',
                'item/commandExecution/requestApproval',
                { threadId: 'thread-A', turnId: id, itemId: 'early-command' },
              );
              server.sendNotification('serverRequest/resolved', {
                threadId: 'thread-B',
                turnId: 'another-turn',
                requestId: 'early-request',
              });
            }
            if (turnCounter === 3) {
              // Emit BOTH a late turn-A-1 completion AND early turn-A-3 delta+completion BEFORE turn/start replies!
              server.sendNotification('turn/completed', {
                threadId: 'thread-A',
                turn: { id: 'turn-A-1', status: 'completed', items: [] },
              });
              server.sendNotification('turn/started', {
                threadId: 'thread-A',
                turn: { id: 'turn-A-3', status: 'inProgress', items: [] },
              });
              server.sendNotification('item/agentMessage/delta', {
                threadId: 'thread-A',
                turnId: 'turn-A-3',
                itemId: 'msg-early-3',
                delta: 'early-before-reply',
              });
              server.sendNotification('turn/completed', {
                threadId: 'thread-A',
                turn: { id: 'turn-A-3', status: 'completed', items: [] },
              });
              await Bun.sleep(15);
            }
            return { turn: { id, status: 'inProgress', items: [] } };
          },
        },
      });
      try {
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          onNotification: (event) => notifications.push(event),
          onServerRequest: async (event) => {
            externalRequests.push(event);
            if (event.interactionId === 'resolved-externally') return;
            await event.respond({ kind: 'approve' });
          },
        });
        const session = await driver.open({
          profile: { profileId: 'p-turns', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        try {
          // 1. Positive control: normal single turn completes cleanly.
          const turn1 = await session.startTurn({
            turnId: 'local-1',
            clientId: 'c-1',
            input: [{ type: 'text', text: 'turn 1' }],
          });
          const drain1 = collectTurn(turn1);
          server.sendNotification('item/agentMessage/delta', {
            threadId: 'thread-A',
            turnId: 'turn-A-1',
            itemId: 'm1',
            delta: 'first',
          });
          server.sendNotification('turn/completed', {
            threadId: 'thread-A',
            turn: { id: 'turn-A-1', status: 'completed', items: [] },
          });
          expect(projectExecutorDeltas(await drain1)).toEqual([
            { type: 'text', text: 'first' },
          ]);

          // 2. Turn 2 active: late turn-A-1 completion + foreign-thread & old-turn server requests
          //    must NOT close or enter Turn 2; Turn 2's own request goes to Turn 2.
          const turn2 = await session.startTurn({
            turnId: 'local-2',
            clientId: 'c-2',
            input: [{ type: 'text', text: 'turn 2' }],
          });
          const ownRequests: string[] = [];
          const drain2 = collectTurn(turn2, async (delta) => {
            if (delta.type === 'request') {
              ownRequests.push(delta.interactionId);
              await turn2.respond(delta.interactionId, { kind: 'deny', message: 'own-deny' });
            }
          });

          // Late turn-A-1 completion on the SAME thread must NOT close turn-A-2.
          server.sendNotification('turn/completed', {
            threadId: 'thread-A',
            turn: { id: 'turn-A-1', status: 'completed', items: [] },
          });

          // Foreign thread B request & stale turn-A-1 request route to onServerRequest (duringActiveTurn: false).
          const foreignReqB = server.sendRequest(
            'req-foreign-B',
            'item/commandExecution/requestApproval',
            {
              threadId: 'thread-B',
              turnId: 'turn-B-9',
              itemId: 'cmd-B',
              command: 'echo B',
            },
          );
          const staleReq1 = server.sendRequest(
            'req-stale-1',
            'item/commandExecution/requestApproval',
            {
              threadId: 'thread-A',
              turnId: 'turn-A-1',
              itemId: 'cmd-old',
              command: 'echo old',
            },
          );
          // Turn 2's own request routes to Turn 2's deltas and turn2.respond().
          const ownReq2 = server.sendRequest(
            'req-own-2',
            'item/commandExecution/requestApproval',
            {
              threadId: 'thread-A',
              turnId: 'turn-A-2',
              itemId: 'cmd-own',
              command: 'echo own',
            },
          );

          expect(await foreignReqB).toEqual({ decision: 'accept' });
          expect(await staleReq1).toEqual({ decision: 'accept' });
          expect(await ownReq2).toEqual({ decision: 'decline' });
          expect(ownRequests).toEqual(['req-own-2']);
          expect(externalRequests.map((r) => [r.interactionId, r.duringActiveTurn])).toEqual([
            ['req-foreign-B', false],
            ['req-stale-1', false],
          ]);

          // The wire names only the thread and request ID when another client answers.
          void server
            .sendRequest('resolved-externally', 'item/commandExecution/requestApproval', {
              threadId: 'thread-A',
              turnId: 'turn-A-1',
              itemId: 'previous-command',
            })
            .catch(() => undefined); // The server cancels this request without a client reply.
          server.sendNotification('serverRequest/resolved', {
            threadId: 'thread-A',
            requestId: 'resolved-externally',
          });
          server.sendNotification('item/agentMessage/delta', {
            threadId: 'thread-A',
            turnId: 'turn-A-2',
            itemId: 'm2',
            delta: 'second',
          });
          server.sendNotification('turn/completed', {
            threadId: 'thread-A',
            turn: { id: 'turn-A-2', status: 'completed', items: [] },
          });
          expect(projectExecutorDeltas(await drain2)).toEqual([
            expect.objectContaining({ type: 'tool-approval-request', callId: 'cmd-own' }),
            { type: 'text', text: 'second' },
          ]);

          expect(
            notifications.find((event) =>
              event.deltas.some(
                (delta) =>
                  delta.type === 'request-resolved' &&
                  delta.interactionId === 'resolved-externally',
              ),
            ),
          ).toMatchObject({ duringActiveTurn: false, deltas: [{ turnId: 'turn-A-1' }] });

          // 3. Turn 3: notifications arriving BEFORE turn/start replies are buffered and matched
          //    once turn/start resolves (while late turn-A-1 does not hijack turn-A-3).
          const turn3 = await session.startTurn({
            turnId: 'local-3',
            clientId: 'c-3',
            input: [{ type: 'text', text: 'turn 3' }],
          });
          expect(turn3.nativeTurnId).toBe('turn-A-3');
          const deltas3 = await collectTurn(turn3);
          expect(projectExecutorDeltas(deltas3)).toEqual([
            { type: 'text', text: 'early-before-reply' },
          ]);
          expect(deltas3.filter((d) => d.type === 'turn-end')).toHaveLength(1);
          const turn4 = await session.startTurn({
            turnId: 'local-4',
            clientId: 'c-4',
            input: [{ type: 'text', text: 'early request' }],
          });
          const drain4 = collectTurn(turn4, async (delta) => {
            if (delta.type === 'request')
              await turn4.respond(delta.interactionId, { kind: 'approve' });
          });
          expect(await earlyAnswer).toEqual({ decision: 'accept' });
          server.sendNotification('turn/completed', {
            threadId: 'thread-A',
            turn: { id: turn4.nativeTurnId, status: 'completed' },
          });
          expect((await drain4).map((delta) => delta.type)).toEqual([
            'request',
            'request-resolved',
            'turn-end',
          ]);
        } finally {
          await session.close();
        }
      } finally {
        await server.close();
      }
    }));

  test('shared server isolates late previous-turn completions on the same thread from a newly started turn', () =>
    inScratch('codex-shared-stale-turn', async (root) => {
      const home = join(root, 'home');
      trackPidFile(join(home, 'shared-pid.txt'));
      const externalNotes: CodexNotificationEvent[] = [];
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_SHARED_CODEX],
        ambient: { PATH: process.env.PATH, HOME: root },
        onNotification: (ev) => {
          if (!ev.duringActiveTurn) externalNotes.push(ev);
        },
      });
      const server = await driver.openSharedServer({
        profile: { profileId: 'p-shared-route', engine: 'codex', home },
        cwd: root,
      });
      try {
        const threadA = await server.openThread({ cwd: root });
        try {
          const turn1 = await threadA.startTurn({
            turnId: 'st-1',
            clientId: 'sc-1',
            input: [{ type: 'text', text: 'first' }],
          });
          expect(projectExecutorDeltas(await collectTurn(turn1))).toEqual([
            { type: 'text', text: `${threadA.nativeThreadId}:first` },
          ]);
          // Trigger STALE_PREV_TURN_COMPLETED on turn 2: fake server emits turn/completed for turn-1
          // before emitting turn-2's delta and completion.
          const turn2 = await threadA.startTurn({
            turnId: 'st-2',
            clientId: 'sc-2',
            input: [{ type: 'text', text: 'STALE_PREV_TURN_COMPLETED second' }],
          });
          const deltas2 = await collectTurn(turn2);
          expect(projectExecutorDeltas(deltas2)).toEqual([
            {
              type: 'text',
              text: `${threadA.nativeThreadId}:STALE_PREV_TURN_COMPLETED second`,
            },
          ]);
          expect(deltas2.filter((d) => d.type === 'turn-end')).toHaveLength(1);
          expect(
            externalNotes.some(
              (n) =>
                n.method === 'turn/completed' &&
                typeof n.params === 'object' &&
                n.params !== null &&
                Reflect.get(Object(Reflect.get(n.params, 'turn')), 'id') ===
                  turn1.nativeTurnId,
            ),
          ).toBe(true);
        } finally {
          await threadA.close();
        }
      } finally {
        await server.close();
      }
    }));
});
