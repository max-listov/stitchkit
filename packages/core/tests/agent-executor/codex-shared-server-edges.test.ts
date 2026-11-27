/**
 * Edges of a Codex app-server connection that outlives one caller's mistake: an overflowing
 * pre-start buffer, concurrent close(), a request resolved after its thread registered, a failed
 * observer, and a byte limit counted in UTF-8.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CodexStartingTurn } from '../../src/agent-executor/codex/event-routing';
import { createCodexHandlers } from '../../src/agent-executor/codex/handlers';
import { CodexLimitBook } from '../../src/agent-executor/codex/limits';
import { JsonRpcError } from '../../src/agent-executor/json-rpc-peer';
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
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');
const OVERFLOW = /exceeded the turn queue limit/;

function startInput(id: string, text: string) {
  return { turnId: id, clientId: `c-${id}`, input: [{ type: 'text' as const, text }] };
}

function openShared(
  root: string,
  observers: {
    onNotification?: (event: CodexNotificationEvent) => void;
    onServerRequest?: (event: CodexServerRequestEvent) => void;
  } = {},
) {
  const home = join(root, 'home');
  trackPidFile(join(home, 'shared-pid.txt'));
  return createCodexDriver({
    executable: process.execPath,
    prefixArgs: [FAKE_SHARED_CODEX],
    ambient: { PATH: process.env.PATH, HOME: root },
    ...observers,
  })
    .openSharedServer({ profile: { profileId: 'p-edges', engine: 'codex', home }, cwd: root })
    .then((server) => ({ server, home }));
}

async function drainText(deltas: AsyncIterable<{ type: string }>): Promise<string[]> {
  const types: string[] = [];
  for await (const delta of deltas) types.push(delta.type);
  return types;
}

describe('Codex connection edges', () => {
  test('an overflowing pre-start buffer fails the turn and keeps a single session alive', () =>
    inScratch('codex-overflow-single', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      let turns = 0;
      const server = await createFakeCodexAppServer({
        socketPath: join(sockDir, 'codex.sock'),
        handlers: {
          'thread/start': () => ({
            thread: makeCodexThreadFixture({ id: 'thread-flood', cwd: root }),
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          }),
          'turn/start': () => {
            turns += 1;
            const turnId = `turn-${turns}`;
            if (turns === 1)
              for (let index = 0; index <= 65_536; index += 1)
                server.sendNotification('item/agentMessage/delta', {
                  threadId: 'thread-flood',
                  turnId,
                  itemId: 'flood',
                  delta: '.',
                });
            else
              setTimeout(
                () =>
                  server.sendNotification('turn/completed', {
                    threadId: 'thread-flood',
                    turn: { id: turnId, status: 'completed', items: [] },
                  }),
                0,
              );
            return { turn: { id: turnId, status: 'inProgress', items: [] } };
          },
        },
      });
      try {
        const session = await createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: server.socketPath },
          ambient: ambientIn(root),
        }).open({
          profile: { profileId: 'p-flood', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        await expect(session.startTurn(startInput('t-1', 'flood'))).rejects.toThrow(OVERFLOW);
        // Before the fix the overflow was thrown into the reader and ended the session.
        const next = await session.startTurn(startInput('t-2', 'again'));
        expect(await drainText(next.deltas)).toEqual(['turn-end']);
        await session.close();
      } finally {
        await server.close();
      }
    }));

  test('an overflowing pre-start buffer fails the turn the same way on a shared server', () =>
    inScratch('codex-overflow-shared', async (root) => {
      const { server } = await openShared(root);
      try {
        const thread = await server.openThread({ cwd: root });
        await expect(
          thread.startTurn(startInput('t-1', 'FLOOD_BEFORE_REPLY')),
        ).rejects.toThrow(OVERFLOW);
      } finally {
        await server.close();
      }
    }));

  test('every concurrent close() waits for the shared process to stop', () =>
    inScratch('codex-concurrent-close', async (root) => {
      const { server, home } = await openShared(root);
      const pid = Number(readFileSync(join(home, 'shared-pid.txt'), 'utf8'));
      const first = server.close();
      await server.close();
      expect(await probeLiveness(pid)).toBe('gone');
      await first;
    }));

  test('a request held before its thread registered is released by its resolution', () =>
    inScratch('codex-early-request', async (root) => {
      const held = Promise.withResolvers<CodexServerRequestEvent>();
      const resolved = Promise.withResolvers<CodexNotificationEvent>();
      const { server } = await openShared(root, {
        onServerRequest: (event) => held.resolve(event),
        onNotification: (event) => {
          if (event.method === 'serverRequest/resolved') resolved.resolve(event);
        },
      });
      try {
        const thread = await server.openThread({
          cwd: root,
          nativeThreadId: 'thread-EARLY_REQUEST',
        });
        const request = await held.promise;
        // The resolution arrives while the thread's slot is registered.
        const turn = await thread.startTurn(startInput('t-1', 'after-resolution'));
        await drainText(turn.deltas);
        const resolution = await resolved.promise;
        expect(resolution.deltas).toEqual([
          expect.objectContaining({
            type: 'request-resolved',
            interactionId: request.interactionId,
          }),
        ]);
        // The entry is gone: a late answer is refused instead of reaching the server.
        await expect(request.respond({ kind: 'approve' })).rejects.toBeInstanceOf(TypeError);
      } finally {
        await server.close();
      }
    }));

  test('a failed observer is refused on a driver-owned process and left open where a TUI may answer', async () => {
    for (const sharedWithOtherClients of [false, true]) {
      const handlers = createCodexHandlers({
        profileId: 'p',
        limits: new CodexLimitBook(),
        externalPending: new Map(),
        liveness: { ensureAlive: () => undefined, isAlive: () => true },
        getTurn: () => undefined,
        clearTurn: () => undefined,
        sharedWithOtherClients,
        onServerRequest: () => {
          throw new Error('host bug with /private/path');
        },
      });
      const answer = handlers.onRequest(
        'item/commandExecution/requestApproval',
        { threadId: 'th', turnId: 'tu', itemId: 'i', command: 'ls' },
        7,
      );
      const outcome = await Promise.race([
        answer.then(
          () => 'resolved',
          (error: unknown) => error,
        ),
        // The observer throws synchronously: a refusal is already queued before these two turns.
        (async () => {
          await null;
          await null;
          return 'pending';
        })(),
      ]);
      if (sharedWithOtherClients) expect(outcome).toBe('pending');
      else {
        expect(outcome).toBeInstanceOf(JsonRpcError);
        expect(outcome instanceof Error ? outcome.message : '').not.toContain('/private/path');
      }
    }
  });

  test('the pre-start byte limit counts UTF-8 bytes', () => {
    const params = { t: 'éééé' };
    const text = JSON.stringify(params);
    expect(text.length).toBe(12);
    // 12 UTF-16 units fit 14; 16 UTF-8 bytes do not.
    const starting = new CodexStartingTurn({ maxItems: 10, maxBytes: 14 });
    expect(starting.defer(params, () => undefined)).toBeInstanceOf(Error);
    const ascii = new CodexStartingTurn({ maxItems: 10, maxBytes: 14 });
    expect(ascii.defer({ t: 'eeee' }, () => undefined)).toBeUndefined();
  });
});
