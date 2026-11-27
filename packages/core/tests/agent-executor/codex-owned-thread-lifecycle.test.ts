/**
 * A thread this driver opened leaves the server only through its session's `close()`: a raw
 * `thread/unsubscribe` of it is refused, and the server's `thread/closed` for it ends its slot and turn.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import {
  createFakeCodexAppServer,
  makeCodexThreadFixture,
} from '../../src/entrypoints/agent-executor/testing';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');

function startInput(id: string, text: string) {
  return { turnId: id, clientId: `c-${id}`, input: [{ type: 'text' as const, text }] };
}

function unsubscribed(home: string): unknown[] {
  const path = join(home, 'unsubscribed.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function openShared(root: string) {
  const home = join(root, 'home');
  trackPidFile(join(home, 'shared-pid.txt'));
  const server = await createCodexDriver({
    executable: process.execPath,
    prefixArgs: [FAKE_SHARED_CODEX],
    ambient: { PATH: process.env.PATH, HOME: root },
  }).openSharedServer({
    profile: { profileId: 'p-owned', engine: 'codex', home },
    cwd: root,
    maxThreads: 2,
  });
  return { server, home };
}

async function drain(deltas: AsyncIterable<unknown>): Promise<unknown> {
  try {
    for await (const _ of deltas) {
      // Read to the end: the turn's own failure is the outcome under test.
    }
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('Codex threads the driver owns', () => {
  test('unsubscribing an open shared thread is refused on every client and leaves its slot and turn intact', () =>
    inScratch('codex-owned-unsubscribe', async (root) => {
      const { server, home } = await openShared(root);
      try {
        const a = await server.openThread({ cwd: root });
        const b = await server.openThread({ cwd: root });
        const turn = await a.startTurn(startInput('a-1', 'NEEDS_APPROVAL'));
        const first = await turn.deltas[Symbol.asyncIterator]().next();
        expect(first.value?.type).toBe('request');

        await expect(a.unsubscribeThread()).rejects.toBeInstanceOf(TypeError);
        await expect(
          b.unsubscribeThread({ threadId: a.nativeThreadId }),
        ).rejects.toBeInstanceOf(TypeError);
        await expect(
          server.unsubscribeThread({ threadId: a.nativeThreadId }),
        ).rejects.toBeInstanceOf(TypeError);
        expect(unsubscribed(home)).toEqual([]);
        expect(server.activeThreadCount).toBe(2);

        // A thread this driver does not own is still one raw RPC.
        await server.unsubscribeThread({ threadId: 'foreign-thread' });
        expect(unsubscribed(home)).toEqual([{ threadId: 'foreign-thread' }]);

        await a.close();
        expect(server.activeThreadCount).toBe(1);
        expect(unsubscribed(home)).toContainEqual({ threadId: a.nativeThreadId });
      } finally {
        await server.close();
      }
    }));

  test('thread/closed for an owned shared thread fails its turn and frees its slot', () =>
    inScratch('codex-owned-thread-closed', async (root) => {
      const { server } = await openShared(root);
      try {
        const a = await server.openThread({ cwd: root });
        const turn = await a.startTurn(startInput('a-1', 'CLOSE_THREAD_MIDTURN'));
        const failure = await drain(turn.deltas);
        expect(failure).toBeInstanceOf(Error);
        expect(failure instanceof Error ? failure.message : '').toContain(
          `Codex closed thread ${a.nativeThreadId}`,
        );
        expect(server.activeThreadCount).toBe(0);
        // Two fresh threads fit the limit of two: the closed one no longer counts.
        await server.openThread({ cwd: root });
        await server.openThread({ cwd: root });
        await expect(a.startTurn(startInput('a-2', 'still-there'))).rejects.toThrow(
          /Codex closed thread/,
        );
      } finally {
        await server.close();
      }
    }));

  test('a single session refuses to unsubscribe its own thread and dies on thread/closed for it', () =>
    inScratch('codex-single-owned-thread', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'codex.sock');
      const unsubscribes: unknown[] = [];
      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/start': () => ({
            thread: makeCodexThreadFixture({ id: 'thread-own', cwd: root }),
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          }),
          'thread/unsubscribe': (params) => {
            unsubscribes.push(params);
            return { status: 'unsubscribed' };
          },
          'turn/start': () => {
            // After the reply is written: the turn exists, then the server unloads its thread.
            setTimeout(() => {
              server.sendNotification('item/agentMessage/delta', {
                threadId: 'thread-own',
                turnId: 'turn-own',
                itemId: 'm',
                delta: 'working',
              });
              server.sendNotification('thread/closed', { threadId: 'thread-own' });
            }, 0);
            return { turn: { id: 'turn-own', status: 'inProgress', items: [] } };
          },
        },
      });
      try {
        const session = await createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
        }).open({
          profile: { profileId: 'p-single', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        await expect(session.unsubscribeThread()).rejects.toBeInstanceOf(TypeError);
        expect(unsubscribes).toEqual([]);
        await session.unsubscribeThread({ threadId: 'someone-else' });
        expect(unsubscribes).toEqual([{ threadId: 'someone-else' }]);

        const turn = await session.startTurn(startInput('t-1', 'go'));
        const failure = await drain(turn.deltas);
        expect(failure instanceof Error ? failure.message : '').toContain(
          'Codex closed thread thread-own',
        );
        await expect(session.startTurn(startInput('t-2', 'again'))).rejects.toThrow(
          /Codex closed thread/,
        );
        await session.close();
      } finally {
        await server.close();
      }
    }));
});
