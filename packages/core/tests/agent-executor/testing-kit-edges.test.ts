/**
 * One rule per fact in the profile and the testing kit: a bad environment name is refused on every
 * path, a replay-gate label is one label however it is spaced, the Codex stub declares what the
 * driver declares, and a late failure of the fake app-server is handled, not thrown.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Server } from 'node:net';
import { join, resolve } from 'node:path';
import { createCodexHandlers } from '../../src/agent-executor/codex/handlers';
import { CodexLimitBook } from '../../src/agent-executor/codex/limits';
import { codexStoppedAnswer } from '../../src/agent-executor/codex/request-answers';
import {
  ExecutorProfileConfigSchema,
  engineEnvironment,
  helloProfile,
} from '../../src/agent-executor/profile';
import * as agentExecutor from '../../src/entrypoints/agent-executor';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { createClaudeCliDriver } from '../../src/entrypoints/agent-executor/claude';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import {
  createFakeCodexAppServer,
  createReplayGate,
  createStubCodexSharedServer,
} from '../../src/entrypoints/agent-executor/testing';
import { createFakeClaudeSdkQuery } from '../../src/entrypoints/agent-executor/testing/claude-sdk';
import { ambientIn, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_SHARED_CODEX = resolve(import.meta.dir, '../fixtures/fake-codex-shared-server.ts');

describe('a profile environment name outside the pattern', () => {
  const BAD_NAMES = ['BAD-KEY', 'lowercase', '1BAD', ''];

  test.each(BAD_NAMES)(
    '%p is refused by the schema, the environment builder and hello',
    (name) => {
      const profile = {
        profileId: 'p',
        engine: 'codex' as const,
        home: '/h',
        env: { [name]: 'v' },
      };
      expect(ExecutorProfileConfigSchema.safeParse(profile).success).toBe(false);
      expect(() => engineEnvironment(profile, {})).toThrow();
      expect(() =>
        helloProfile({
          profile,
          status: { login: { state: 'unknown' }, effectiveCredential: 'unknown' },
          ambient: {},
        }),
      ).toThrow();
    },
  );

  test('every driver refuses to open such a profile, and no export drops the name instead', async () => {
    const env = { 'BAD-KEY': 'v', GOOD_KEY: 'kept' };
    const input = { cwd: '/', env };
    // An executable that cannot run: a driver that reached the spawn would fail differently.
    const executable = '/nonexistent/engine';
    const refusals = await Promise.allSettled([
      createCodexDriver({ executable, ambient: {} }).open({
        ...input,
        profile: { profileId: 'p', engine: 'codex', home: '/h', env },
      }),
      createAcpDriver({ executable, ambient: {} }).open({
        ...input,
        profile: { profileId: 'p', engine: 'acp', home: '/h', env },
      }),
      createClaudeCliDriver({ executable, ambient: {} }).open({
        ...input,
        profile: { profileId: 'p', engine: 'claude-cli', home: '/h', env },
      }),
      createClaudeSdkDriver({
        sdkVersion: '0.3.332',
        ambient: {},
        query: createFakeClaudeSdkQuery().query,
      }).open({
        ...input,
        profile: { profileId: 'p', engine: 'claude-sdk', home: '/h', env },
      }),
    ]);
    for (const refusal of refusals) {
      expect(refusal.status).toBe('rejected');
      expect(String(refusal.status === 'rejected' ? refusal.reason : '')).toContain('env');
    }
    // The schema is the one path: nothing public filters a profile's variables silently.
    expect(Object.keys(agentExecutor)).not.toContain('sanitizeProfileEnv');
    expect(
      ExecutorProfileConfigSchema.parse({
        profileId: 'p',
        engine: 'codex',
        home: '/h',
        env: { GOOD_KEY: '' },
      }).env,
    ).toEqual({ GOOD_KEY: '' });
  });
});

describe('createReplayGate', () => {
  test("release(' a ') releases the label 'a', and every lookup reads a label the same way", async () => {
    const gate = createReplayGate([' a ', 'b']);
    const held = gate.beforeEmit('a ');
    let passed = false;
    void held.then(() => {
      passed = true;
    });
    expect(gate.hasReached(' a')).toBe(true);
    expect(await gate.waitForReached('  a  ')).toBe(true);
    await Promise.resolve();
    expect(passed).toBe(false);
    expect(gate.release(' a ')).toBe(true);
    await held;
    expect(passed).toBe(true);
    // Released once; an unknown label stays unknown, and a duplicate is one after trimming.
    expect(gate.release('a')).toBe(false);
    expect(gate.release(' c ')).toBe(false);
    expect(gate.hasReached('b ')).toBe(false);
    expect(() => createReplayGate(['a', ' a'])).toThrow(/Duplicate replay gate label "a"/);
  });
});

describe('createStubCodexSharedServer', () => {
  test('declares the capabilities the Codex driver declares on a real shared server', () =>
    inScratch('stub-capabilities', async (root) => {
      const home = join(root, 'home');
      trackPidFile(join(home, 'shared-pid.txt'));
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_SHARED_CODEX],
        ambient: ambientIn(root),
      });
      const server = await driver.openSharedServer({
        profile: { profileId: 'p', engine: 'codex', home },
        cwd: root,
      });
      try {
        const stub = createStubCodexSharedServer();
        expect(stub.capabilities).toEqual(server.capabilities);
        expect(stub.capabilities).toEqual({
          ...driver.capabilities,
          multiThreadPerProcess: true,
        });
        // The comparison can fail: a driver configured differently declares differently.
        const withImages = createCodexDriver({ resolveFile: async () => new Uint8Array() });
        expect(stub.capabilities.images).toBe(false);
        expect(withImages.capabilities.images).toBe(true);
      } finally {
        await server.close();
      }
    }));
});

describe('createFakeCodexAppServer', () => {
  test('a server error after startup is handled every time: clients are dropped, pending requests rejected, and later sends name it', () =>
    inScratch('fake-codex-late-error', async (root) => {
      const socketDirectory = join(root, 's');
      mkdirSync(socketDirectory, { mode: 0o700 });
      const socketPath = join(socketDirectory, 'codex.sock');
      // The fake keeps its `net.Server` to itself: the spy only records which server listened.
      const listen = spyOn(Server.prototype, 'listen');
      const fake = await createFakeCodexAppServer({ socketPath });
      const [netServer] = listen.mock.contexts;
      listen.mockRestore();
      if (!(netServer instanceof Server)) throw new Error('the fake server never listened');
      try {
        const disconnected = Promise.withResolvers<Error>();
        const connection = await createCodexDriver({
          transport: { kind: 'unix-connect', socketPath },
          ambient: ambientIn(root),
          onServerRequest: () => undefined,
          onDisconnect: (error) => disconnected.resolve(error),
        }).connectControl({
          profile: { profileId: 'p', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        try {
          const pending = fake.sendRequest('held', 'item/commandExecution/requestApproval', {
            threadId: 'th-1',
            turnId: 'turn-1',
            itemId: 'cmd-1',
            command: 'echo',
          });
          const pendingFailure = pending.then(
            () => undefined,
            (error: unknown) => error,
          );
          // An `error` event nobody listens to is thrown by `emit`; both are handled.
          expect(netServer.listenerCount('error')).toBe(1);
          expect(() =>
            netServer.emit('error', new Error('late-accept-failure')),
          ).not.toThrow();
          expect(() => netServer.emit('error', new Error('second-failure'))).not.toThrow();
          expect(netServer.listenerCount('error')).toBe(1);
          expect(await pendingFailure).toBeInstanceOf(Error);
          expect((await disconnected.promise).message.length).toBeGreaterThan(0);
          expect(() => fake.sendNotification('turn/started', {})).toThrow(
            /the server failed: late-accept-failure/,
          );
          await expect(fake.sendRequest('next', 'ping', {})).rejects.toThrow(
            /the server failed: late-accept-failure/,
          );
        } finally {
          await connection.close();
        }
      } finally {
        await fake.close();
      }
    }));
});

describe('a Codex server request reaching a connection that stopped serving', () => {
  const stopped = {
    ensureAlive: () => {
      throw new Error('The Codex session is closed');
    },
    isAlive: () => false,
  };
  const handlersFor = (state: { closingGracefully: boolean; shared: boolean }) =>
    createCodexHandlers({
      sharedWithOtherClients: state.shared,
      profileId: 'p',
      limits: new CodexLimitBook(),
      externalPending: new Map(),
      getTurn: () => undefined,
      clearTurn: () => undefined,
      liveness: stopped,
      closingGracefully: () => state.closingGracefully,
    });
  const settled = async (answer: Promise<unknown>) =>
    Promise.race([
      answer.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      Bun.sleep(30).then(() => 'unanswered' as const),
    ]);
  const APPROVAL = 'item/commandExecution/requestApproval';

  test('is answered as stopped while the owner closes a process only this driver talks to', async () => {
    const handlers = handlersFor({ closingGracefully: true, shared: false });
    expect(await settled(Promise.resolve(handlers.onRequest(APPROVAL, {}, 1)))).toEqual({
      value: codexStoppedAnswer(APPROVAL),
    });
    expect(
      await settled(Promise.resolve(handlers.onRequest('future/request', {}, 2))),
    ).toMatchObject({ error: { code: -32601 } });
  });

  test.each([
    ['after an abort or a lost connection', { closingGracefully: false, shared: false }],
    ['on a transport a TUI may answer on', { closingGracefully: true, shared: true }],
  ])('is left unanswered %s', async (_label, state) => {
    const handlers = handlersFor(state);
    expect(await settled(Promise.resolve(handlers.onRequest(APPROVAL, {}, 1)))).toBe(
      'unanswered',
    );
  });
});

describe('external requests a Codex connection still holds when its owner closes it', () => {
  const STDIO_PEER = resolve(import.meta.dir, '../fixtures/codex-stdio-abort-peer.ts');
  const APPROVAL = 'item/commandExecution/requestApproval';
  const untilFile = async (path: string, wanted: (text: string) => boolean) => {
    const deadline = Date.now() + 5_000;
    while (!(existsSync(path) && wanted(readFileSync(path, 'utf8')))) {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
      await Bun.sleep(10);
    }
  };

  test('are answered as stopped on a stdio app-server only this driver talks to', () =>
    inScratch('codex-close-held-stdio', async (root) => {
      trackPidFile(join(root, 'pid'));
      const held = Promise.withResolvers<string>();
      const session = await createCodexDriver({
        executable: process.execPath,
        // This mode keeps reading after SIGTERM until `release-exit`, so it records the answer.
        prefixArgs: [STDIO_PEER, root, 'abort-observer'],
        ambient: ambientIn(root),
        onServerRequest: (event) => held.resolve(event.interactionId),
      }).open({
        profile: { profileId: 'p', engine: 'codex', home: join(root, 'h') },
        cwd: root,
      });
      expect(await held.promise).toBe('ext-abort-1');
      const closing = session.close();
      try {
        await untilFile(join(root, 'responses.jsonl'), (text) => text.includes('ext-abort-1'));
        expect(
          readFileSync(join(root, 'responses.jsonl'), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line)),
        ).toEqual([{ id: 'ext-abort-1', result: codexStoppedAnswer(APPROVAL) }]);
      } finally {
        writeFileSync(join(root, 'release-exit'), '1');
        await closing;
      }
    }));

  test('are left for the TUI on a Unix-socket app-server: close() writes no answer', () =>
    inScratch('codex-close-held-unix', async (root) => {
      const socketDirectory = join(root, 's');
      mkdirSync(socketDirectory, { mode: 0o700 });
      const socketPath = join(socketDirectory, 'codex.sock');
      const fake = await createFakeCodexAppServer({ socketPath });
      try {
        const held = Promise.withResolvers<string>();
        const connection = await createCodexDriver({
          transport: { kind: 'unix-connect', socketPath },
          ambient: ambientIn(root),
          onServerRequest: (event) => held.resolve(event.interactionId),
        }).connectControl({
          profile: { profileId: 'p', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        const outcome = fake
          .sendRequest('held-1', APPROVAL, {
            threadId: 'th-1',
            turnId: 'turn-1',
            itemId: 'cmd-1',
            command: 'echo',
          })
          .then(
            (value) => ({ answered: value }),
            (error: unknown) => ({ disconnected: String(error) }),
          );
        expect(await held.promise).toBe('held-1');
        await connection.close();
        expect(await outcome).toEqual({
          disconnected: 'Error: Fake Codex app-server client disconnected',
        });
      } finally {
        await fake.close();
      }
    }));
});
