/**
 * Regressions for Codex Unix socket symlink resolution (including Darwin EOPNOTSUPP),
 * CodexControlClient.startThreadTurn, typed loose DTOs & open variants, parseCodexNotification,
 * bounded pagination (iterateCodexPages / findCodexTurnByClientId), and per-call CodexRpcCallOptions.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCodexNotification } from '../../src/agent-executor/codex/classify';
import {
  CODEX_OPTED_OUT_NOTIFICATIONS,
  CODEX_PARSED_QUIET_NOTIFICATIONS,
  CODEX_QUIET_NOTIFICATIONS,
} from '../../src/agent-executor/codex/notifications';
import {
  assertCodexUnixSocketClientTarget,
  validateCodexUnixSocketPath,
} from '../../src/agent-executor/codex/unix-socket-target';
import { JsonRpcError, type JsonRpcValue } from '../../src/entrypoints/agent-executor';
import {
  type CodexAccount,
  CodexAccountReadResponseSchema,
  CodexListedTurnSchema,
  CodexNotificationParams,
  CodexProtocolError,
  type CodexSandboxPolicy,
  CodexSandboxPolicySchema,
  CodexThreadSchema,
  type CodexThreadStatus,
  CodexThreadStatusSchema,
  CodexUnixSocketError,
  createCodexDriver,
  findCodexTurnByClientId,
  iterateCodexPages,
  parseCodexNotification,
} from '../../src/entrypoints/agent-executor/codex';
import {
  createFakeCodexAppServer,
  makeCodexNotificationEvent,
  makeCodexThreadFixture,
} from '../../src/entrypoints/agent-executor/testing';
import { MAX_TIMER_MS } from '../../src/internal/timers';
import {
  ambientIn,
  inScratch,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest, trackProcess } from '../support/process-reaper';

const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex-engine.ts', import.meta.url));

reapAfterEachTest();

function codexProfile(root: string, id = 'p-codex') {
  return { profileId: id, engine: 'codex' as const, home: join(root, id) };
}

describe('Codex Unix socket symlinks, startThreadTurn, typed DTOs, notifications, pagination, and per-call options', () => {
  test('Unix socket target inspection resolves single, chained, and relative symlinks, tolerates Darwin EOPNOTSUPP on socket realpath, and refuses unsafe/broken targets', () =>
    inScratch('cs', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const realSock = join(sockDir, 'live.sock');
      const server = await createFakeCodexAppServer({
        socketPath: realSock,
        handlers: {
          'config/read': () => ({ config: { model: 'gpt-5-codex' }, origins: {} }),
        },
      });
      try {
        // Single symlink, chained symlinks, and relative symlink all connect through createCodexDriver.
        const singleLink = join(sockDir, 'single.sock');
        const hop1 = join(sockDir, 'hop1.sock');
        const hop2 = join(sockDir, 'hop2.sock');
        const relLink = join(sockDir, 'rel.sock');
        symlinkSync(realSock, singleLink);
        symlinkSync(realSock, hop1);
        symlinkSync(hop1, hop2);
        symlinkSync('./live.sock', relLink);

        for (const target of [realSock, singleLink, hop2, relLink]) {
          expect(assertCodexUnixSocketClientTarget(target, 'test')).toBe('present');
          const driver = createCodexDriver({
            transport: { kind: 'unix-connect', socketPath: target },
            ambient: ambientIn(root),
          });
          const conn = await driver.connectControl({ profile: codexProfile(root), cwd: root });
          try {
            const cfg = await conn.readConfig();
            expect(cfg.config).toEqual({ model: 'gpt-5-codex' });
          } finally {
            await conn.close();
          }
        }

        // Negative control emulating Darwin APFS realpath(symlink -> socket) throwing EOPNOTSUPP:
        // direct call on realpath throws EOPNOTSUPP, while assertCodexUnixSocketClientTarget
        // only calls realpathSync on parent directories and succeeds.
        const realpathCalls: string[] = [];
        const darwinRealpath = ((path: Parameters<typeof realpathSync>[0]) => {
          const text = String(path);
          realpathCalls.push(text);
          const st = lstatSync(text, { throwIfNoEntry: false });
          if (st !== undefined && (st.isSocket() || st.isSymbolicLink())) {
            const err = Object.assign(new Error('operation not supported on socket'), {
              code: 'EOPNOTSUPP',
            });
            throw err;
          }
          return realpathSync(text);
        }) as typeof realpathSync;

        expect(() => darwinRealpath(singleLink)).toThrow(/operation not supported/);
        expect(() => darwinRealpath(realSock)).toThrow(/operation not supported/);
        realpathCalls.length = 0;

        expect(
          assertCodexUnixSocketClientTarget(hop2, 'darwin-test', undefined, {
            lstatSync,
            readlinkSync,
            realpathSync: darwinRealpath,
          }),
        ).toBe('present');
        expect(realpathCalls).not.toContain(singleLink);
        expect(realpathCalls).not.toContain(hop2);
        expect(realpathCalls).not.toContain(realSock);

        // Dangling symlink -> absent (endpoint-absent via connectControl).
        const dangling = join(sockDir, 'dangling.sock');
        symlinkSync(join(sockDir, 'missing.sock'), dangling);
        expect(assertCodexUnixSocketClientTarget(dangling, 'test')).toBe('absent');
        const disconnected = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: dangling },
          ambient: ambientIn(root),
        });
        await expect(
          disconnected.connectControl({ profile: codexProfile(root), cwd: root }),
        ).rejects.toMatchObject({ kind: 'endpoint-absent', socketPath: dangling });

        // Symlink loop -> target-refused.
        const loopA = join(sockDir, 'loop-a.sock');
        const loopB = join(sockDir, 'loop-b.sock');
        symlinkSync(loopB, loopA);
        symlinkSync(loopA, loopB);
        expect(() => assertCodexUnixSocketClientTarget(loopA, 'test')).toThrow(
          /exceeded 40 hops/,
        );

        // Symlink to a regular file -> target-refused.
        const regFile = join(sockDir, 'plain.txt');
        writeFileSync(regFile, 'hi');
        const toFile = join(sockDir, 'to-file.sock');
        symlinkSync(regFile, toFile);
        expect(() => assertCodexUnixSocketClientTarget(toFile, 'test')).toThrow(
          /is not a socket/,
        );

        // Symlink whose target has a trailing slash (directory-like) -> target-refused.
        const trailingSlash = join(sockDir, 'trailing.sock');
        symlinkSync(`${realSock}/`, trailingSlash);
        expect(() => assertCodexUnixSocketClientTarget(trailingSlash, 'test')).toThrow(
          /points to invalid target/,
        );

        // Non-directory parent and ENOTDIR under a regular file -> target-refused.
        expect(() =>
          assertCodexUnixSocketClientTarget(join(regFile, 'child.sock'), 'test'),
        ).toThrow(/is not a directory/);
        expect(() =>
          assertCodexUnixSocketClientTarget(join(regFile, 'nested', 'child.sock'), 'test'),
        ).toThrow(/failed to inspect/);

        // Trailing slash on socketPath itself -> refused eagerly & target-refused.
        expect(() => validateCodexUnixSocketPath(`${realSock}/`, 'test')).toThrow(TypeError);
        let trailingPathErr: unknown;
        try {
          assertCodexUnixSocketClientTarget(`${realSock}/`, 'test');
        } catch (err) {
          trailingPathErr = err;
        }
        expect(trailingPathErr).toBeInstanceOf(CodexUnixSocketError);
        expect((trailingPathErr as CodexUnixSocketError).kind).toBe('target-refused');

        // Symlink located inside a world-writable directory -> CodexUnixSocketError('target-refused').
        const wideDir = join(root, 'wide');
        mkdirSync(wideDir, { mode: 0o777 });
        chmodSync(wideDir, 0o777);
        const wideLink = join(wideDir, 'link.sock');
        symlinkSync(realSock, wideLink);
        let wideErr: unknown;
        try {
          assertCodexUnixSocketClientTarget(wideLink, 'test');
        } catch (err) {
          wideErr = err;
        }
        expect(wideErr).toBeInstanceOf(CodexUnixSocketError);
        expect((wideErr as CodexUnixSocketError).kind).toBe('target-refused');

        // Symlink from private 0o700 dir pointing into world-writable 0o777 dir (hop >= 1) -> target-refused.
        const wideFile = join(wideDir, 'inner.sock');
        writeFileSync(wideFile, 'x');
        const privToWide = join(sockDir, 'priv-to-wide.sock');
        symlinkSync(wideFile, privToWide);
        let hop1WideErr: unknown;
        try {
          assertCodexUnixSocketClientTarget(privToWide, 'test');
        } catch (err) {
          hop1WideErr = err;
        }
        expect(hop1WideErr).toBeInstanceOf(CodexUnixSocketError);
        expect((hop1WideErr as CodexUnixSocketError).kind).toBe('target-refused');

        // Symlinked ancestor directory where realDir !== dir (like macOS /tmp -> /private/tmp)
        // succeeds when the leaf parent dir is a real private 0700 directory, whereas a symlink
        // as the immediate parent dir itself is refused as target-refused.
        const realBase = join(root, 'real-base');
        mkdirSync(realBase, { mode: 0o700 });
        const realSub = join(realBase, 'priv-sub');
        mkdirSync(realSub, { mode: 0o700 });
        const aliasBase = join(root, 'alias-base');
        symlinkSync(realBase, aliasBase);
        const dirLink = join(root, 'sym-sub');
        symlinkSync(realSub, dirLink);
        const linkedSock = join(realSub, 'via-dir.sock');
        const subServer = await createFakeCodexAppServer({ socketPath: linkedSock });
        try {
          expect(
            assertCodexUnixSocketClientTarget(
              join(aliasBase, 'priv-sub', 'via-dir.sock'),
              'test',
            ),
          ).toBe('present');
          expect(() =>
            assertCodexUnixSocketClientTarget(join(dirLink, 'via-dir.sock'), 'test'),
          ).toThrow(/directory|symlink|private/i);
        } finally {
          await subServer.close();
        }

        // Wrong expectedOwnerUid -> target-refused; empty readlink -> target-refused; exact 40 vs 41 hops boundary.
        const currentUid = typeof process.getuid === 'function' ? process.getuid() : 0;
        expect(() =>
          assertCodexUnixSocketClientTarget(singleLink, 'test', currentUid + 99_999),
        ).toThrow(/owned by uid/);
        expect(() =>
          assertCodexUnixSocketClientTarget(singleLink, 'test', undefined, {
            lstatSync,
            readlinkSync: (() => '') as unknown as typeof readlinkSync,
            realpathSync,
          }),
        ).toThrow(/points to invalid target/);

        const hopDir = join(root, 'hops');
        mkdirSync(hopDir, { mode: 0o700 });
        let prev = realSock;
        for (let i = 1; i <= 41; i += 1) {
          const next = join(hopDir, `h${i}.sock`);
          symlinkSync(prev, next);
          prev = next;
        }
        expect(assertCodexUnixSocketClientTarget(join(hopDir, 'h40.sock'), 'test')).toBe(
          'present',
        );
        expect(() =>
          assertCodexUnixSocketClientTarget(join(hopDir, 'h41.sock'), 'test'),
        ).toThrow(/exceeded 40 hops/);
      } finally {
        await server.close();
      }
    }));

  test('CodexControlClient.startThreadTurn starts turns over threadless control without policy overwrite and validates eagerly before resolveFile', () =>
    inScratch('codex-control-start-turn', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'srv.sock');
      const thread = makeCodexThreadFixture({ id: 'th-ctrl-1', cwd: root });
      let resolveCalls = 0;

      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/read': () => ({ thread }),
          'thread/resume': () => ({
            thread,
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            cwd: root,
            approvalPolicy: 'on-request',
            sandbox: { type: 'workspaceWrite' },
          }),
          'turn/start': () => ({
            turn: { id: 'turn-ctrl-42', status: 'inProgress', items: [] },
          }),
        },
      });
      try {
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          resolveFile: async () => {
            resolveCalls += 1;
            return new Uint8Array([1, 2, 3]);
          },
        });
        const conn = await driver.connectControl({ profile: codexProfile(root), cwd: root });
        try {
          // Read-only thread/read -> resumeThread(excludeTurns default true) -> startThreadTurn with skill, localImage, and overrides.
          const read = await conn.readThread({ threadId: 'th-ctrl-1' });
          expect(read.thread.id).toBe('th-ctrl-1');

          const resumed = await conn.resumeThread({ threadId: 'th-ctrl-1' });
          expect(resumed.thread.id).toBe('th-ctrl-1');
          const resumeReq = server.requests.find((r) => r.method === 'thread/resume');
          expect(resumeReq?.params).toEqual({ threadId: 'th-ctrl-1', excludeTurns: true });

          const started = await conn.startThreadTurn({
            threadId: 'th-ctrl-1',
            clientId: 'cid-ctrl-1',
            input: [
              { type: 'text', text: 'run check' },
              { type: 'localImage', path: join(root, 'shot.png') },
              { type: 'skill', name: 'lint', path: join(root, 'SKILL.md') },
            ],
            cwd: root,
            model: 'gpt-5-codex',
            reasoningEffort: 'medium',
            collaborationMode: { mode: 'plan', settings: { model: 'gpt-5-codex' } },
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'readOnly' },
            runtimeWorkspaceRoots: [root],
          });
          expect(started).toEqual({ turnId: 'turn-ctrl-42' });

          const startReq = server.requests.find((r) => r.method === 'turn/start');
          expect(startReq?.params).toMatchObject({
            threadId: 'th-ctrl-1',
            clientUserMessageId: 'cid-ctrl-1',
            cwd: root,
            model: 'gpt-5-codex',
            effort: 'medium',
            approvalPolicy: 'never',
            sandboxPolicy: { type: 'readOnly' },
            runtimeWorkspaceRoots: [root],
            input: [
              { type: 'text', text: 'run check' },
              { type: 'localImage', path: join(root, 'shot.png') },
              { type: 'skill', name: 'lint', path: join(root, 'SKILL.md') },
            ],
          });

          // Eager validation errors reject BEFORE resolveFile runs.
          const filePart = { type: 'file' as const, reference: 'f1', mediaType: 'image/png' };
          const preAborted = new AbortController();
          preAborted.abort(new Error('abort-before-resolve'));
          await expect(
            conn.startThreadTurn({ threadId: ' ', clientId: 'c1', input: [filePart] }),
          ).rejects.toThrow(TypeError);
          await expect(
            conn.startThreadTurn({ threadId: 'th-ctrl-1', clientId: '', input: [filePart] }),
          ).rejects.toThrow(TypeError);
          await expect(
            conn.startThreadTurn(
              { threadId: 'th-ctrl-1', clientId: 'c1', input: [filePart] },
              { timeoutMs: 0 },
            ),
          ).rejects.toThrow(RangeError);
          await expect(
            conn.startThreadTurn(
              { threadId: 'th-ctrl-1', clientId: 'c1', input: [filePart] },
              { timeoutMs: MAX_TIMER_MS + 1 },
            ),
          ).rejects.toThrow(RangeError);
          await expect(
            conn.startThreadTurn(
              { threadId: 'th-ctrl-1', clientId: 'c1', input: [filePart] },
              { signal: preAborted.signal },
            ),
          ).rejects.toThrow(/abort-before-resolve/);
          expect(resolveCalls).toBe(0);
        } finally {
          await conn.close();
        }

        // CodexSession.startThreadTurn also starts turns on any thread without occupying local turn slot.
        const session = await driver.open({
          profile: codexProfile(root, 'p-sess-ctrl'),
          cwd: root,
          nativeThreadId: 'th-ctrl-1',
        });
        try {
          const startedFromSession = await session.startThreadTurn({
            threadId: 'th-other-2',
            clientId: 'cid-sess-ctrl',
            input: [{ type: 'text', text: 'side turn' }],
          });
          expect(startedFromSession).toEqual({ turnId: 'turn-ctrl-42' });
        } finally {
          await session.close();
        }
      } finally {
        await server.close();
      }

      // CodexSharedServer.startThreadTurn works on stdio multiplexed server too.
      const scenarioPath = await writeScenario(root, []);
      const sharedDriver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: ambientIn(root),
      });
      const shared = await sharedDriver.openSharedServer({
        profile: {
          profileId: 'p-shared-ctrl',
          engine: 'codex',
          home: join(root, 'shared-h'),
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'shared-ctrl'),
          },
        },
        cwd: root,
      });
      trackProcess(shared.providerPid);
      try {
        const startedFromShared = await shared.startThreadTurn({
          threadId: 'fake-thread',
          clientId: 'cid-shared-1',
          input: [{ type: 'text', text: 'shared ctrl turn' }],
        });
        expect(startedFromShared.turnId).toBeString();
      } finally {
        await shared.close();
      }
    }));

  test('Codex typed DTOs preserve unknown future variants while rejecting malformed known variants and bad RPC payloads with CodexProtocolError', () =>
    inScratch('codex-typed-dtos', async (root) => {
      // Discriminated-union narrowing works cleanly across ALL known variants without casts!
      const statusActive: CodexThreadStatus = CodexThreadStatusSchema.parse({
        type: 'active',
        activeFlags: ['futureFlag'],
      });
      if (statusActive.type === 'active') {
        expect(statusActive.activeFlags).toEqual(['futureFlag']);
      } else {
        throw new Error('Expected active status');
      }
      const policyWrite: CodexSandboxPolicy = CodexSandboxPolicySchema.parse({
        type: 'workspaceWrite',
        writableRoots: ['/w'],
        networkAccess: true,
      });
      if (policyWrite.type === 'workspaceWrite') {
        expect(policyWrite.writableRoots).toEqual(['/w']);
        expect(policyWrite.networkAccess).toBe(true);
      }
      const policyRead: CodexSandboxPolicy = CodexSandboxPolicySchema.parse({
        type: 'readOnly',
        networkAccess: false,
      });
      if (policyRead.type === 'readOnly') {
        expect(policyRead.networkAccess).toBe(false);
      }
      const policyExt: CodexSandboxPolicy = CodexSandboxPolicySchema.parse({
        type: 'externalSandbox',
        networkAccess: 'restricted',
      });
      if (policyExt.type === 'externalSandbox') {
        expect(policyExt.networkAccess).toBe('restricted');
      }
      const acctChatgpt: CodexAccount | null | undefined =
        CodexAccountReadResponseSchema.parse({
          account: { type: 'chatgpt', email: 'a@b.c', planType: 'pro', workspaceName: 'W' },
          requiresOpenaiAuth: false,
        }).account;
      if (acctChatgpt?.type === 'chatgpt') {
        expect(acctChatgpt.email).toBe('a@b.c');
        expect(acctChatgpt.planType).toBe('pro');
        expect(acctChatgpt.workspaceName).toBe('W');
      }
      const acctBedrock: CodexAccount | null | undefined =
        CodexAccountReadResponseSchema.parse({
          account: { type: 'amazonBedrock', usesCodexManagedCredentials: true },
          requiresOpenaiAuth: false,
        }).account;
      if (acctBedrock?.type === 'amazonBedrock') {
        expect(acctBedrock.usesCodexManagedCredentials).toBe(true);
      }

      // Open variants accept unknown future discriminants + unknown extra fields.
      expect(
        CodexThreadStatusSchema.parse({ type: 'futurePaused', reason: 'quota' }).type,
      ).toBe('futurePaused');
      expect(CodexSandboxPolicySchema.parse({ type: 'futureSandbox', level: 3 }).type).toBe(
        'futureSandbox',
      );
      expect(
        CodexAccountReadResponseSchema.parse({
          account: { type: 'enterpriseOAuth', tenant: 'acme' },
          requiresOpenaiAuth: false,
        }).account?.type,
      ).toBe('enterpriseOAuth');

      // Known variants still validate strictly.
      expect(() =>
        CodexThreadStatusSchema.parse({ type: 'active', activeFlags: 'not-an-array' }),
      ).toThrow();
      expect(() =>
        CodexSandboxPolicySchema.parse({ type: 'workspaceWrite', writableRoots: 123 }),
      ).toThrow();

      // CodexListedTurnSchema parses itemsView + timing fields + extra keys.
      const listed = CodexListedTurnSchema.parse({
        id: 't-1',
        status: 'completed',
        items: [],
        itemsView: 'summary',
        startedAt: 1732670000,
        completedAt: 1732670010,
        durationMs: 10_000,
        rootTurnId: 't-0',
        extraField: true,
      });
      expect(listed.itemsView).toBe('summary');
      expect(listed.startedAt).toBe(1732670000);
      expect(CodexThreadSchema.parse(makeCodexThreadFixture({ id: 'th-1' })).id).toBe('th-1');

      // Live RPC response parsing returns typed DTOs and throws CodexProtocolError on malformed reply.
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'dto.sock');
      let corruptModels = false;
      let corruptEmpty: unknown = {};
      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'config/read': () => ({
            config: { model: 'gpt-5-codex', sandbox_mode: 'future-sandbox-mode' },
            origins: {},
          }),
          'thread/resume': () => ({
            thread: makeCodexThreadFixture({ id: 'th-1' }),
            collaborationMode: {
              mode: 'future-mode',
              settings: { model: 'gpt-5-codex' },
            },
          }),
          'thread/items/list': (params) => ({
            data: [],
            nextCursor: null,
            echoedCursor:
              params && typeof params === 'object' ? Reflect.get(params, 'cursor') : null,
          }),
          'model/list': () =>
            corruptModels
              ? { data: 'not-an-array' }
              : {
                  data: [
                    {
                      id: 'gpt-5-codex',
                      model: 'gpt-5-codex',
                      displayName: 'GPT-5 Codex',
                      isDefault: true,
                      futureFlag: 'kept',
                    },
                  ],
                  nextCursor: null,
                },
          'thread/unsubscribe': () => ({ status: 'unsubscribed' }),
          'thread/archive': () => corruptEmpty as Record<string, unknown>,
          'thread/name/set': () => corruptEmpty as Record<string, unknown>,
          'thread/inject_items': () => corruptEmpty as Record<string, unknown>,
        },
      });
      try {
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
        });
        const conn = await driver.connectControl({ profile: codexProfile(root), cwd: root });
        try {
          // Inbound forward-compat on unknown sandbox_mode and unknown collaborationMode.
          const cfg = await conn.readConfig();
          expect(cfg.config.sandbox_mode).toBe('future-sandbox-mode');
          const resumed = await conn.resumeThread({ threadId: 'th-1' });
          expect(resumed.collaborationMode?.mode).toBe('future-mode');

          // Empty-string opaque cursor is accepted by listItems (parity with listTurns/iterateCodexPages).
          const itemsPage = await conn.listItems({ threadId: 'th-1', cursor: '' });
          expect(itemsPage.data).toEqual([]);
          expect(
            server.requests.find((r) => r.method === 'thread/items/list')?.params,
          ).toEqual({
            threadId: 'th-1',
            cursor: '',
          });

          const models = await conn.listModels();
          expect(models.data[0]?.id).toBe('gpt-5-codex');
          expect(await conn.unsubscribeThread({ threadId: 'th-1' })).toEqual({
            status: 'unsubscribed',
          });
          expect(await conn.archiveThread({ threadId: 'th-1' })).toBeUndefined();
          expect(
            await conn.setThreadName({ threadId: 'th-1', name: 'Renamed' }),
          ).toBeUndefined();
          expect(
            await conn.injectItems({ threadId: 'th-1', items: [{ type: 'message' }] }),
          ).toBeUndefined();

          // CodexEmptyResponseSchema negative controls: non-object replies fail with CodexProtocolError.
          corruptEmpty = null;
          await expect(conn.archiveThread({ threadId: 'th-1' })).rejects.toThrow(
            CodexProtocolError,
          );
          corruptEmpty = 'bad';
          await expect(conn.setThreadName({ threadId: 'th-1', name: 'X' })).rejects.toThrow(
            CodexProtocolError,
          );
          await expect(
            conn.injectItems({ threadId: 'th-1', items: [{ type: 'message' }] }),
          ).rejects.toThrow(CodexProtocolError);

          corruptModels = true;
          await expect(conn.listModels()).rejects.toThrow(CodexProtocolError);
        } finally {
          await conn.close();
        }
      } finally {
        await server.close();
      }
    }));

  test('parseCodexNotification parses all 14 notifications including the 5 quiet ones while classifyCodexNotification keeps them ignored', () => {
    expect(CODEX_PARSED_QUIET_NOTIFICATIONS).toEqual([
      'thread/status/changed',
      'turn/started',
      'item/plan/delta',
      'thread/settings/updated',
      'model/rerouted',
    ]);
    expect(CODEX_OPTED_OUT_NOTIFICATIONS).toContain('app/list/updated');
    for (const method of CODEX_PARSED_QUIET_NOTIFICATIONS) {
      expect(CODEX_QUIET_NOTIFICATIONS).toContain(method);
    }

    const samplePayloads: ReadonlyArray<
      [keyof typeof CodexNotificationParams, Record<string, JsonRpcValue>]
    > = [
      [
        'item/agentMessage/delta',
        { threadId: 'th-1', turnId: 't-1', itemId: 'm-1', delta: 'hi' },
      ],
      [
        'item/reasoning/textDelta',
        { threadId: 'th-1', turnId: 't-1', itemId: 'r-1', delta: 'think' },
      ],
      [
        'item/reasoning/summaryTextDelta',
        { threadId: 'th-1', turnId: 't-1', itemId: 'r-1', delta: 'sum', summaryIndex: 0 },
      ],
      [
        'item/plan/delta',
        { threadId: 'th-1', turnId: 't-1', itemId: 'plan-1', delta: 'Step 1' },
      ],
      [
        'item/started',
        { threadId: 'th-1', turnId: 't-1', item: { id: 'i-1', type: 'agentMessage' } },
      ],
      [
        'item/completed',
        { threadId: 'th-1', turnId: 't-1', item: { id: 'i-1', type: 'agentMessage' } },
      ],
      [
        'turn/started',
        { threadId: 'th-1', turn: { id: 't-1', status: 'inProgress', items: [] } },
      ],
      [
        'turn/completed',
        { threadId: 'th-1', turn: { id: 't-1', status: 'completed', items: [] } },
      ],
      [
        'thread/status/changed',
        { threadId: 'th-1', status: { type: 'active', activeFlags: [] } },
      ],
      [
        'thread/settings/updated',
        { threadId: 'th-1', threadSettings: { approvalPolicy: 'never' } },
      ],
      [
        'model/rerouted',
        {
          threadId: 'th-1',
          turnId: 't-1',
          fromModel: 'gpt-5',
          toModel: 'gpt-5-mini',
          reason: 'highRiskCyberActivity',
        },
      ],
      [
        'thread/tokenUsage/updated',
        {
          threadId: 'th-1',
          turnId: 't-1',
          tokenUsage: {
            last: { inputTokens: 10, outputTokens: 5 },
            modelContextWindow: 200_000,
          },
        },
      ],
      ['serverRequest/resolved', { threadId: 'th-1', requestId: 'req-1' }],
      ['account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 10 } } }],
    ];
    expect(samplePayloads.map(([m]): string => m).sort()).toEqual(
      Object.keys(CodexNotificationParams).sort(),
    );
    expect(samplePayloads).toHaveLength(14);
    for (const [method, params] of samplePayloads) {
      const parsed = parseCodexNotification(makeCodexNotificationEvent(method, params));
      expect(parsed?.method).toBe(method);
      expect(parsed?.params).toMatchObject(params);
    }

    // All 5 quiet notifications stay ignored by classifyCodexNotification.
    const turnState = { turnId: 't-1', interruptRequested: false };
    const quietPayloadMap = new Map(samplePayloads);
    for (const quietMethod of CODEX_PARSED_QUIET_NOTIFICATIONS) {
      expect(
        classifyCodexNotification(quietMethod, quietPayloadMap.get(quietMethod), turnState),
      ).toEqual({ kind: 'ignore', reason: quietMethod });
    }

    // Unknown method returns null (forward-compatible); malformed known method throws CodexProtocolError
    // with accurate notification wording.
    expect(
      parseCodexNotification(makeCodexNotificationEvent('future/event', { x: 1 })),
    ).toBeNull();
    expect(() =>
      parseCodexNotification(makeCodexNotificationEvent('turn/started', { turn: 'bad' })),
    ).toThrow(CodexProtocolError);
    expect(() =>
      parseCodexNotification(makeCodexNotificationEvent('turn/started', { turn: 'bad' })),
    ).toThrow(/notification did not match schema/);
  });

  test('iterateCodexPages, findCodexTurnByClientId, and per-call CodexRpcCallOptions enforce bounds, fail-closed itemsView, and per-call timeout/signal', () =>
    inScratch('codex-pagination-and-options', async (root) => {
      // 1. iterateCodexPages: exact final page -> truncated: false; empty-string opaque cursor works.
      const seenCursors: Array<string | undefined> = [];
      const exact = await iterateCodexPages(
        async (cursor) => {
          seenCursors.push(cursor);
          if (cursor === undefined) return { items: [1], nextCursor: '' };
          return { items: [2], nextCursor: null };
        },
        { maxPages: 2 },
      );
      expect(seenCursors).toEqual([undefined, '']);
      expect(exact.truncated).toBe(false);
      expect(exact.pages).toHaveLength(2);

      // Truncation when maxPages exhausted with remaining cursor, AbortSignal cancellation, and eager option validation.
      let pageN = 0;
      const trunc = await iterateCodexPages(async () => ({ nextCursor: `c${++pageN}` }), {
        maxPages: 2,
      });
      expect(trunc.truncated).toBe(true);
      expect(trunc.pages).toHaveLength(2);

      const pageAbort = new AbortController();
      pageAbort.abort(new Error('page-aborted'));
      await expect(
        iterateCodexPages(async () => ({ nextCursor: null }), {
          maxPages: 2,
          signal: pageAbort.signal,
        }),
      ).rejects.toThrow(/page-aborted/);

      for (const badMax of [0, -1, 1.5, undefined as unknown as number]) {
        await expect(
          iterateCodexPages(async () => ({ nextCursor: null }), { maxPages: badMax }),
        ).rejects.toThrow(TypeError);
      }
      await expect(
        iterateCodexPages(async () => ({ nextCursor: null }), {
          maxPages: 1,
          onRepeatedCursor: 'invalid' as 'throw',
        }),
      ).rejects.toThrow(TypeError);

      // Repeated cursor throws by default, stops cleanly with truncated: true when configured.
      await expect(
        iterateCodexPages(async () => ({ nextCursor: 'same' }), { maxPages: 5 }),
      ).rejects.toThrow(/repeated cursor/);
      const stopped = await iterateCodexPages(async () => ({ nextCursor: 'same' }), {
        maxPages: 5,
        onRepeatedCursor: 'stop',
      });
      expect(stopped.truncated).toBe(true);
      expect(stopped.pages).toHaveLength(2);

      // 2. findCodexTurnByClientId + per-call CodexRpcCallOptions over real FakeCodexAppServer.
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'pages.sock');
      let summaryMode = false;
      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        handlers: {
          'thread/turns/list': (params) => {
            const p = params as Record<string, unknown>;
            if (summaryMode) {
              return {
                data: [
                  { id: 'turn-sum', status: 'completed', items: [], itemsView: 'summary' },
                ],
                nextCursor: null,
              };
            }
            if (p.cursor === undefined) {
              return {
                data: [
                  {
                    id: 'turn-1',
                    status: 'completed',
                    items: [{ type: 'userMessage', id: 'u1', clientId: 'cid-other' }],
                    itemsView: 'full',
                  },
                ],
                nextCursor: 'page-2',
              };
            }
            return {
              data: [
                {
                  id: 'turn-2',
                  status: 'completed',
                  items: [{ type: 'userMessage', id: 'u2', clientId: 'cid-target' }],
                  itemsView: 'full',
                  startedAt: 1732670100,
                },
              ],
              nextCursor: 'page-3-unfetched',
            };
          },
          'model/list': () => 'hang',
          'config/read': () => ({ config: { ok: true }, origins: {} }),
        },
      });
      try {
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
        });
        const conn = await driver.connectControl({ profile: codexProfile(root), cwd: root });
        try {
          // Stops early on page 2 without requesting page 3.
          const found = await findCodexTurnByClientId(conn, {
            threadId: 'th-1',
            clientId: 'cid-target',
            maxPages: 10,
            pageSize: 1,
          });
          expect(found?.id).toBe('turn-2');
          expect(found?.startedAt).toBe(1732670100);
          expect(server.requests.filter((r) => r.method === 'thread/turns/list')).toHaveLength(
            2,
          );

          // Missing match across bounded pages throws when truncated past maxPages.
          await expect(
            findCodexTurnByClientId(conn, {
              threadId: 'th-1',
              clientId: 'cid-missing',
              maxPages: 1,
            }),
          ).rejects.toThrow(/exceeded 1 pages/);

          // Fail-closed when server returns itemsView: 'summary'.
          summaryMode = true;
          await expect(
            findCodexTurnByClientId(conn, {
              threadId: 'th-1',
              clientId: 'cid-target',
            }),
          ).rejects.toThrow(/incomplete itemsView "summary"/);

          // Per-call timeoutMs past MAX_TIMER_MS refuses eagerly on both RPC calls and findCodexTurnByClientId.
          await expect(
            conn.readConfig(undefined, { timeoutMs: MAX_TIMER_MS + 1 }),
          ).rejects.toThrow(RangeError);
          await expect(
            findCodexTurnByClientId(conn, {
              threadId: 'th-1',
              clientId: 'cid-target',
              timeoutMs: MAX_TIMER_MS + 1,
            }),
          ).rejects.toThrow(RangeError);

          // Per-call timeoutMs overrides peer 5_000ms and keeps connection alive.
          await expect(conn.listModels(undefined, { timeoutMs: 25 })).rejects.toThrow(
            JsonRpcError,
          );

          // Per-call AbortSignal cancels only that call and leaves connection usable.
          const abortController = new AbortController();
          const hung = conn.listModels(undefined, { signal: abortController.signal });
          setTimeout(() => abortController.abort(new Error('per-call-cancel')), 15);
          await expect(hung).rejects.toThrow(/per-call-cancel/);

          expect((await conn.readConfig()).config).toEqual({ ok: true });
        } finally {
          await conn.close();
        }
      } finally {
        await server.close();
      }
    }));
});
