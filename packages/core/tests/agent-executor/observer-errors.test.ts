/**
 * A host callback that throws or rejects is contained, so the driver keeps reading its engine —
 * and told: `onObserverError` receives the error and the name of the option that failed. Without
 * the option the failure is dropped, never rethrown into the reader.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { JsonRpcError } from '../../src/agent-executor/json-rpc-peer';
import { emitStartupPhase, invokeObserver } from '../../src/agent-executor/session-primitives';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { createClaudeCliDriver } from '../../src/entrypoints/agent-executor/claude';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import {
  createFakeCodexAppServer,
  createReplayExecutorDriver,
} from '../../src/entrypoints/agent-executor/testing';
import { createFakeClaudeSdkQuery } from '../../src/entrypoints/agent-executor/testing/claude-sdk';
import {
  ambientIn,
  drain,
  FAKE_CLAUDE,
  inScratch,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const ACP_PEER = resolve(import.meta.dir, '../fixtures/acp-close-liveness-peer.ts');

interface Reported {
  readonly hook: string;
  readonly message: string;
}

function collector() {
  const reported: Reported[] = [];
  return {
    reported,
    onObserverError(error: unknown, hook: string) {
      reported.push({ hook, message: error instanceof Error ? error.message : String(error) });
    },
    hooks: () => reported.map((entry) => entry.hook),
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(5);
  }
}

/** Fail the test on any rejection nobody handled while `body` ran. */
async function withoutUnhandledRejections(body: () => Promise<void>): Promise<void> {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await body();
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

describe('a contained callback failure reaches onObserverError', () => {
  test('a synchronous throw and an asynchronous rejection are both reported with the hook, and a failing reporter is contained', () =>
    withoutUnhandledRejections(async () => {
      const seen = collector();
      invokeObserver(seen.onObserverError, 'onNotification', () => {
        throw new Error('sync-boom');
      });
      invokeObserver(seen.onObserverError, 'onDisconnect', async () => {
        throw new Error('async-boom');
      });
      emitStartupPhase(
        () => {
          throw new Error('phase-boom');
        },
        'spawning',
        seen.onObserverError,
      );
      // Nothing to report to, and a reporter that fails both ways: contained, never rethrown.
      expect(() =>
        invokeObserver(undefined, 'onUpdate', () => {
          throw new Error('nobody-listens');
        }),
      ).not.toThrow();
      expect(() =>
        invokeObserver(
          () => {
            throw new Error('reporter-threw');
          },
          'onUpdate',
          () => {
            throw new Error('first');
          },
        ),
      ).not.toThrow();
      invokeObserver(
        async () => {
          throw new Error('reporter-rejected');
        },
        'onUpdate',
        async () => {
          throw new Error('second');
        },
      );
      await until(() => seen.reported.length === 3, 'three reports');
      expect(seen.reported).toEqual([
        { hook: 'onNotification', message: 'sync-boom' },
        { hook: 'onStartupPhase', message: 'phase-boom' },
        { hook: 'onDisconnect', message: 'async-boom' },
      ]);
    }));

  test('Codex: onStartupPhase, onNotification, onServerRequest and onDisconnect failures are reported and the connection keeps working', () =>
    withoutUnhandledRejections(() =>
      inScratch('observer-errors-codex', async (root) => {
        const socketDirectory = join(root, 's');
        mkdirSync(socketDirectory, { mode: 0o700 });
        const socketPath = join(socketDirectory, 'codex.sock');
        const server = await createFakeCodexAppServer({
          socketPath,
          handlers: { 'config/read': () => ({ config: { model: 'm' }, origins: {} }) },
        });
        const seen = collector();
        try {
          const connection = await createCodexDriver({
            transport: { kind: 'unix-connect', socketPath },
            ambient: ambientIn(root),
            onNotification: (event) => {
              throw new Error(`notification-boom:${event.method}`);
            },
            onServerRequest: async (event) => {
              // A `JsonRpcError` is this observer's refusal; anything else is its failure.
              if (event.interactionId === 'refused') throw new JsonRpcError(-32001, 'refused');
              throw new Error('request-boom');
            },
            onDisconnect: () => {
              throw new Error('disconnect-boom');
            },
            onObserverError: seen.onObserverError,
          }).connectControl({
            profile: { profileId: 'p', engine: 'codex', home: join(root, 'h') },
            cwd: root,
            onStartupPhase: (phase) => {
              throw new Error(`phase-boom:${phase}`);
            },
          });
          try {
            expect(seen.reported).toEqual([
              { hook: 'onStartupPhase', message: 'phase-boom:initializing' },
            ]);
            server.sendNotification('thread/status/changed', {
              threadId: 'th-1',
              status: { type: 'idle' },
            });
            await until(() => seen.hooks().includes('onNotification'), 'the notification');
            const request = {
              threadId: 'th-1',
              turnId: 'turn-1',
              itemId: 'cmd-1',
              command: 'echo',
            };
            await expect(
              server.sendRequest('refused', 'item/commandExecution/requestApproval', request),
            ).rejects.toMatchObject({ code: -32001, message: 'refused' });
            // On a transport a TUI may share, a failed observer leaves the request for it.
            void server
              .sendRequest('failed', 'item/commandExecution/requestApproval', request)
              .catch(() => undefined);
            await until(() => seen.hooks().includes('onServerRequest'), 'the request');
            // The reader survived all of it: a control call still answers.
            expect((await connection.readConfig()).config).toEqual({ model: 'm' });
            server.disconnect();
            await until(() => seen.hooks().includes('onDisconnect'), 'the disconnect');
            expect(seen.reported).toEqual([
              { hook: 'onStartupPhase', message: 'phase-boom:initializing' },
              { hook: 'onNotification', message: 'notification-boom:thread/status/changed' },
              { hook: 'onServerRequest', message: 'request-boom' },
              { hook: 'onDisconnect', message: 'disconnect-boom' },
            ]);
          } finally {
            await connection.close();
          }
        } finally {
          await server.close();
        }
      }),
    ));

  test('ACP: onStartupPhase, onProviderPid, onUpdate and onPermissionRequest failures are reported and the turn still completes', () =>
    withoutUnhandledRejections(() =>
      inScratch('observer-errors-acp', async (root) => {
        trackPidFile(join(root, 'pid'));
        const seen = collector();
        const session = await createAcpDriver({
          executable: process.execPath,
          args: [ACP_PEER, root, 'live-positive'],
          ambient: ambientIn(root),
          permissionRequestDelivery: 'all',
          onProviderPid: () => {
            throw new Error('pid-boom');
          },
          onUpdate: () => {
            throw new Error('update-boom');
          },
          onPermissionRequest: async (event) => {
            if (event.duringActiveTurn) await event.respond({ kind: 'approve' });
            throw new Error(`permission-boom:${event.interactionId}`);
          },
          onObserverError: seen.onObserverError,
        }).open({
          profile: { engine: 'acp', profileId: 'p', home: root },
          cwd: root,
          onStartupPhase: (phase) => {
            throw new Error(`phase-boom:${phase}`);
          },
        });
        try {
          const turn = await session.startTurn({
            turnId: 't-1',
            clientId: 'c-1',
            input: [{ type: 'text', text: 'go' }],
          });
          expect((await drain(turn)).at(-1)).toMatchObject({
            type: 'turn-end',
            outcome: 'completed',
          });
          await until(
            () => seen.reported.some((entry) => entry.message === 'permission-boom:ext-1'),
            'the request outside the turn',
          );
          expect(new Set(seen.hooks())).toEqual(
            new Set(['onStartupPhase', 'onProviderPid', 'onUpdate', 'onPermissionRequest']),
          );
          expect(seen.reported).toContainEqual({
            hook: 'onStartupPhase',
            message: 'phase-boom:spawning',
          });
          expect(seen.reported).toContainEqual({ hook: 'onProviderPid', message: 'pid-boom' });
          expect(seen.reported).toContainEqual({ hook: 'onUpdate', message: 'update-boom' });
          expect(seen.reported).toContainEqual({
            hook: 'onPermissionRequest',
            message: 'permission-boom:act-1',
          });
        } finally {
          await session.close();
        }
      }),
    ));

  test('Claude SDK: onStartupPhase, onPermissionRequest, onTurnUsage and onQueryExit failures are reported and the turn still completes', () =>
    withoutUnhandledRejections(() =>
      inScratch('observer-errors-claude-sdk', async (root) => {
        const seen = collector();
        const fake = createFakeClaudeSdkQuery({
          turns: [
            async (message, run) => {
              await run.askPermission('Bash', { command: 'echo ok' }, { toolUseID: 'tu-1' });
              run.emit({
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: 'ok',
                parent_tool_use_id: null,
                uuid: message.uuid,
              });
              run.end();
            },
          ],
        });
        const session = await createClaudeSdkDriver({
          sdkVersion: '0.3.332',
          ambient: ambientIn(root),
          query: fake.query,
          onPermissionRequest: () => {
            throw new Error('permission-boom');
          },
          onTurnUsage: async () => {
            throw new Error('usage-boom');
          },
          onQueryExit: () => {
            throw new Error('exit-boom');
          },
          onObserverError: seen.onObserverError,
        }).open({
          profile: { profileId: 'p', engine: 'claude-sdk', home: join(root, 'h') },
          cwd: root,
          onStartupPhase: (phase) => {
            throw new Error(`phase-boom:${phase}`);
          },
        });
        try {
          const turn = await session.startTurn({
            turnId: 't-1',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          });
          const deltas = [];
          for await (const delta of turn.deltas) {
            deltas.push(delta);
            if (delta.type === 'request') {
              await turn.respond(delta.interactionId, { kind: 'approve' });
            }
          }
          expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
          await until(() => seen.hooks().includes('onQueryExit'), 'the query exit');
          expect(seen.reported).toEqual([
            { hook: 'onStartupPhase', message: 'phase-boom:spawning' },
            { hook: 'onPermissionRequest', message: 'permission-boom' },
            { hook: 'onTurnUsage', message: 'usage-boom' },
            { hook: 'onQueryExit', message: 'exit-boom' },
          ]);
        } finally {
          await session.close();
        }
      }),
    ));

  test('Claude CLI: an onStartupPhase failure is reported and open() still succeeds', () =>
    withoutUnhandledRejections(() =>
      inScratch('observer-errors-claude-cli', async (root) => {
        const seen = collector();
        const session = await createClaudeCliDriver({
          executable: process.execPath,
          prefixArgs: [FAKE_CLAUDE],
          ambient: ambientIn(root),
          onObserverError: seen.onObserverError,
        }).open({
          profile: {
            profileId: 'p',
            engine: 'claude-cli',
            home: join(root, 'home'),
            env: {
              FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'observer-cli'),
              FAKE_ENGINE_SCENARIO: await writeScenario(root, []),
            },
          },
          cwd: root,
          onStartupPhase: (phase) => {
            throw new Error(`phase-boom:${phase}`);
          },
        });
        try {
          expect(seen.reported).toEqual([
            { hook: 'onStartupPhase', message: 'phase-boom:spawning' },
          ]);
        } finally {
          await session.close();
        }
      }),
    ));

  test('Replay driver: an onStartupPhase failure is reported and open() still succeeds', () =>
    withoutUnhandledRejections(async () => {
      const seen = collector();
      const session = await createReplayExecutorDriver({
        turns: [],
        onObserverError: seen.onObserverError,
      }).open({
        profile: { profileId: 'p', engine: 'acp', home: '/h' },
        cwd: '/',
        onStartupPhase: (phase) => {
          throw new Error(`phase-boom:${phase}`);
        },
      });
      try {
        expect(seen.reported).toEqual([
          { hook: 'onStartupPhase', message: 'phase-boom:initializing' },
        ]);
      } finally {
        await session.close();
      }
    }));
});
