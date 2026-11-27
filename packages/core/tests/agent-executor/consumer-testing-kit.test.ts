/**
 * Consumer testing kit regressions: FakeCodexAppServer, consumer stubs, FakeClaudeSdkQuery,
 * schema-validated fixtures, and exactOptionalPropertyTypes: true compatibility across
 * all agent-executor entrypoints alongside real @anthropic-ai/claude-agent-sdk.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import {
  createWsFrameDecoder,
  encodeUnmaskedWsFrame,
} from '../../src/agent-executor/codex/ws-frame';
import { ExecutorDeltaSchema, JsonRpcError } from '../../src/entrypoints/agent-executor';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import {
  CodexThreadSchema,
  createCodexDriver,
  parseCodexNotification,
} from '../../src/entrypoints/agent-executor/codex';
import {
  createFakeCodexAppServer,
  createStubAcpSession,
  createStubAgentEngineTurn,
  createStubCodexControlClient,
  createStubCodexControlConnection,
  createStubCodexSession,
  createStubCodexSharedServer,
  createStubCodexTurn,
  makeCodexNotificationEvent,
  makeCodexThreadFixture,
  makeExecutorDelta,
} from '../../src/entrypoints/agent-executor/testing';
import {
  createFakeClaudeSdkQuery,
  createStubClaudeSdkSession,
} from '../../src/entrypoints/agent-executor/testing/claude-sdk';
import { ambientIn, drain, inScratch } from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const CORE_ROOT = join(import.meta.dir, '../..');

describe('agent-executor consumer testing kit', () => {
  test('createFakeCodexAppServer speaks WebSocket-over-Unix-socket JSON-RPC with real createCodexDriver', () =>
    inScratch('fake-codex-server', async (root) => {
      const sockDir = join(root, 's');
      mkdirSync(sockDir, { mode: 0o700 });
      const sockPath = join(sockDir, 'codex.sock');
      const thread = makeCodexThreadFixture({ id: 'th-fake-1', cwd: root });

      const server = await createFakeCodexAppServer({
        socketPath: sockPath,
        userAgent: 'codex-fake/1.0',
        maxFrameBytes: 4096,
        handlers: {
          'config/read': () => ({ config: { model: 'gpt-5-codex' }, origins: {} }),
          'thread/read': () => ({ thread }),
          'model/list': () => ({ error: { code: -32042, message: 'custom-rpc-err' } }),
          'skills/list': () => {
            throw new JsonRpcError(-32055, 'thrown-rpc-err');
          },
          'thread/archive': () => {
            throw new Error('plain-handler-boom');
          },
          'account/read': () => 'hang',
        },
      });

      try {
        // Fail-loud when no client is connected (sendRequest returns a rejected Promise).
        expect(() => server.sendNotification('turn/started', {})).toThrow(
          /no client is connected/,
        );
        expect(() => server.sendRaw('not-json')).toThrow(/no client is connected/);
        await expect(server.sendRequest('srv-0', 'ping', {})).rejects.toThrow(
          /no client is connected/,
        );

        const notes: string[] = [];
        const disconnected = Promise.withResolvers<Error>();
        const driver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          onNotification: (event) => {
            notes.push(event.method);
          },
          onServerRequest: async (event) => {
            await event.respond({ kind: 'approve' });
          },
          onDisconnect: (err) => {
            disconnected.resolve(err);
          },
        });

        const conn = await driver.connectControl({
          profile: { profileId: 'p1', engine: 'codex', home: join(root, 'h') },
          cwd: root,
        });
        try {
          expect(conn.userAgent).toBe('codex-fake/1.0');
          expect((await conn.readConfig()).config).toEqual({ model: 'gpt-5-codex' });
          expect((await conn.readThread({ threadId: 'th-fake-1' })).thread.id).toBe(
            'th-fake-1',
          );
          await expect(conn.listModels()).rejects.toMatchObject({
            code: -32042,
            message: 'custom-rpc-err',
          });
          await expect(conn.listSkills()).rejects.toMatchObject({
            code: -32055,
            message: 'thrown-rpc-err',
          });
          // Plain Error from handler maps to JSON-RPC -32603 internal error.
          await expect(conn.archiveThread({ threadId: 'th-fake-1' })).rejects.toMatchObject({
            code: -32603,
            message: 'plain-handler-boom',
          });
          // Unregistered method returns -32601.
          await expect(conn.listCollaborationModes()).rejects.toMatchObject({ code: -32601 });
          // 'hang' handler triggers per-call timeoutMs cleanly.
          await expect(conn.readAccount(undefined, { timeoutMs: 25 })).rejects.toThrow(
            JsonRpcError,
          );

          // Server -> client notification and request/reply round-trip.
          server.sendNotification('thread/status/changed', {
            threadId: 'th-fake-1',
            status: { type: 'idle' },
          });
          const approvalReply = await server.sendRequest(
            'srv-req-1',
            'item/commandExecution/requestApproval',
            { itemId: 'cmd-1', command: 'echo ok' },
          );
          expect(approvalReply).toEqual({ decision: 'accept' });
          expect(notes).toContain('thread/status/changed');

          // Recorded requests include initialize + our RPCs in arrival order.
          expect(server.requests.map((r) => r.method)).toEqual([
            'initialize',
            'config/read',
            'thread/read',
            'model/list',
            'skills/list',
            'thread/archive',
            'collaborationMode/list',
            'account/read',
          ]);

          // disconnect() drops client without closing listening server -> fires onDisconnect.
          server.disconnect();
          const discErr = await disconnected.promise;
          expect(discErr).toBeInstanceOf(Error);
        } finally {
          await conn.close();
        }

        // Duplicate pending serverRequest id refuses; disconnect() rejects pending serverRequest cleanly.
        const slowDisconnectDriver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          onServerRequest: () => new Promise<void>(() => undefined),
        });
        const connSlow = await slowDisconnectDriver.connectControl({
          profile: { profileId: 'p-slow', engine: 'codex', home: join(root, 'h-slow') },
          cwd: root,
        });
        try {
          const pendingReq = server.sendRequest(
            'dup-id',
            'item/commandExecution/requestApproval',
            { itemId: 'c1', command: 'echo hold' },
          );
          await expect(
            server.sendRequest('dup-id', 'item/commandExecution/requestApproval', {
              itemId: 'c2',
              command: 'echo dup',
            }),
          ).rejects.toThrow(/duplicate pending request id/);
          server.disconnect();
          await expect(pendingReq).rejects.toThrow(/disconnected/);
        } finally {
          await connSlow.close();
        }

        // maxFrameBytes genuinely rejects an oversized incoming client frame (4096 limit).
        const oversizeConn = await driver.connectControl({
          profile: { profileId: 'p-big', engine: 'codex', home: join(root, 'h-big') },
          cwd: root,
        });
        try {
          await expect(
            oversizeConn.setThreadName({ threadId: 'th-fake-1', name: 'x'.repeat(5000) }),
          ).rejects.toThrow();
        } finally {
          await oversizeConn.close();
        }

        // sendRaw can inject an oversize frame that triggers client maxFrameBytes disconnect.
        const rawDisconnected = Promise.withResolvers<Error>();
        const tightClientDriver = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: sockPath },
          ambient: ambientIn(root),
          maxFrameBytes: 512,
          onDisconnect: (err) => rawDisconnected.resolve(err),
        });
        const conn2 = await tightClientDriver.connectControl({
          profile: { profileId: 'p2', engine: 'codex', home: join(root, 'h2') },
          cwd: root,
        });
        try {
          server.sendRaw('y'.repeat(1024));
          const rawErr = await rawDisconnected.promise;
          expect(rawErr.message).toMatch(/exceeds|frame|closed/i);
        } finally {
          await conn2.close();
        }
      } finally {
        // Concurrent + idempotent close removes the socket cleanly.
        await Promise.all([server.close(), server.close()]);
      }
      expect(existsSync(sockPath)).toBe(false);

      // Direct mkdtempSync(join(tmpdir(), ...)) works (checks parent dir, not /tmp grandparent!),
      // while 0o777 parent dir, symlink parent dir, and invalid maxFrameBytes fail loudly.
      const directTmpDir = mkdtempSync(join(tmpdir(), 'fk-codex-'));
      try {
        const directServer = await createFakeCodexAppServer({
          socketPath: join(directTmpDir, 'direct.sock'),
          handlers: {
            initialize: () => ({ userAgent: 'custom-init/2.0' }),
          },
        });
        try {
          const dDirect = createCodexDriver({
            transport: { kind: 'unix-connect', socketPath: directServer.socketPath },
            ambient: ambientIn(root),
          });
          const cDirect = await dDirect.connectControl({
            profile: { profileId: 'p-dir', engine: 'codex', home: join(root, 'h-dir') },
            cwd: root,
          });
          expect(cDirect.userAgent).toBe('custom-init/2.0');
          await cDirect.close();
        } finally {
          await directServer.close();
        }
      } finally {
        rmSync(directTmpDir, { recursive: true, force: true });
      }

      const openDir = join(root, 'open-777');
      mkdirSync(openDir, { mode: 0o777 });
      chmodSync(openDir, 0o777);
      await expect(
        createFakeCodexAppServer({ socketPath: join(openDir, 'bad.sock') }),
      ).rejects.toThrow();

      const linkDir = join(root, 'link-dir');
      symlinkSync(sockDir, linkDir);
      await expect(
        createFakeCodexAppServer({ socketPath: join(linkDir, 'bad.sock') }),
      ).rejects.toThrow();

      await expect(
        createFakeCodexAppServer({ socketPath: join(sockDir, 'zero.sock'), maxFrameBytes: 0 }),
      ).rejects.toThrow(TypeError);

      // Server-side WS decoder with expectMasked: true refuses unmasked client frames.
      const protocolErrors: string[] = [];
      const maskedDecoder = createWsFrameDecoder({
        maxFrameBytes: 1024,
        expectMasked: true,
        onMessage: () => undefined,
        onPing: () => undefined,
        onClose: () => undefined,
        onProtocolError: (msg) => protocolErrors.push(msg),
      });
      maskedDecoder.push(encodeUnmaskedWsFrame(0x1, Buffer.from('unmasked', 'utf8')));
      expect(protocolErrors).toHaveLength(1);
      expect(protocolErrors[0]).toMatch(/masked/i);

      // Explicit { userAgent: undefined } omits userAgent from initialize reply.
      const omitSock = join(sockDir, 'omit-ua.sock');
      const omitServer = await createFakeCodexAppServer({
        socketPath: omitSock,
        userAgent: undefined,
      });
      try {
        const d2 = createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: omitSock },
          ambient: ambientIn(root),
        });
        const c2 = await d2.connectControl({
          profile: { profileId: 'p3', engine: 'codex', home: join(root, 'h3') },
          cwd: root,
        });
        expect(c2.userAgent).toBeUndefined();
        await c2.close();
      } finally {
        await omitServer.close();
      }
    }));

  test('consumer stub factories fail loud by default, keep close() no-op, and honor explicit undefined overrides', async () => {
    const client = createStubCodexControlClient();
    await expect(Promise.resolve().then(() => client.readConfig())).rejects.toThrow(
      /CodexControlClient\.readConfig/,
    );

    const conn = createStubCodexControlConnection({
      userAgent: undefined,
      providerPid: undefined,
    });
    expect(conn.userAgent).toBeUndefined();
    expect(conn.providerPid).toBeUndefined();
    await expect(conn.close()).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => conn.readAccount())).rejects.toThrow(
      /CodexControlConnection\.readAccount/,
    );

    const codexSess = createStubCodexSession({ nativeThreadId: 'th-custom', userAgent: 'ua' });
    expect(codexSess.nativeThreadId).toBe('th-custom');
    expect(codexSess.userAgent).toBe('ua');
    await expect(codexSess.close()).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => codexSess.listModels())).rejects.toThrow(
      /CodexSession\.listModels/,
    );

    const shared = createStubCodexSharedServer({ providerPid: 1234 });
    expect(shared.providerPid).toBe(1234);
    await expect(shared.close()).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => shared.listThreads())).rejects.toThrow(
      /CodexSharedServer\.listThreads/,
    );

    const codexTurn = createStubCodexTurn({
      deltas: [
        makeExecutorDelta({ type: 'text', text: 'hello' }),
        makeExecutorDelta({ type: 'turn-end', outcome: 'completed' }),
      ],
    });
    expect(codexTurn.nativeTurnId).toBe('stub-turn-1');
    expect(await drain(codexTurn)).toHaveLength(2);
    // Array-backed stub turns are replayable across repeated iterations.
    expect(await drain(codexTurn)).toHaveLength(2);
    await expect(Promise.resolve().then(() => codexTurn.interrupt())).rejects.toThrow(
      /CodexTurn\.interrupt/,
    );

    const engineTurn = createStubAgentEngineTurn({
      deltas: [makeExecutorDelta({ type: 'text', text: 'et' })],
    });
    expect(await drain(engineTurn)).toEqual([makeExecutorDelta({ type: 'text', text: 'et' })]);
    await expect(
      Promise.resolve().then(() => engineTurn.respond('i1', { kind: 'approve' })),
    ).rejects.toThrow(/AgentEngineTurn\.respond/);

    // AsyncIterable-backed stub turn streams lazily in a single pass.
    async function* lazyDeltas() {
      yield makeExecutorDelta({ type: 'text', text: 'lazy' });
      yield makeExecutorDelta({ type: 'turn-end', outcome: 'completed' });
    }
    const asyncTurn = createStubCodexTurn({ deltas: lazyDeltas() });
    expect((await drain(asyncTurn)).map((d) => d.type)).toEqual(['text', 'turn-end']);

    const claudeSess = createStubClaudeSdkSession({ providerPid: undefined });
    expect(claudeSess.providerPid).toBeUndefined();
    await expect(claudeSess.close()).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => claudeSess.supportedModels())).rejects.toThrow(
      /ClaudeSdkSession\.supportedModels/,
    );

    const acpSess = createStubAcpSession({ providerPid: undefined, title: undefined });
    expect(acpSess.providerPid).toBeUndefined();
    expect(acpSess.title).toBeUndefined();
    await expect(acpSess.close()).resolves.toBeUndefined();
    await expect(
      Promise.resolve().then(() => acpSess.setConfigOption('model', 'm')),
    ).rejects.toThrow(/AcpSession\.setConfigOption/);
  });

  test('createFakeClaudeSdkQuery drives multi-turn createClaudeSdkDriver flows, canUseTool, live controls, optional usage, and probeCapabilities', () =>
    inScratch('fake-claude-sdk', async (root) => {
      const seenPermissions: string[] = [];
      let runsStarted = 0;
      const harness = createFakeClaudeSdkQuery({
        initializationResult: {
          commands: [{ name: 'compact', description: 'Compact context', argumentHint: '' }],
          agents: [],
          output_style: 'concise',
          available_output_styles: ['default', 'concise'],
          models: [{ value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: 'Fast' }],
          account: { email: 'dev@example.invalid', subscriptionType: 'max' },
        },
        models: [{ value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: 'Fast' }],
        commands: [{ name: 'compact', description: 'Compact context', argumentHint: '' }],
        account: { email: 'dev@example.invalid', subscriptionType: 'max' },
        mcpServers: [{ name: 'docs', status: 'connected' }],
        contextUsage: {
          categories: [],
          totalTokens: 512,
          maxTokens: 200_000,
          rawMaxTokens: 200_000,
          percentage: 0.25,
          gridRows: [],
          model: 'claude-sonnet-4-6',
          isAutoCompactEnabled: true,
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          apiUsage: null,
        },
        onRun: () => {
          runsStarted += 1;
        },
        onSetPermissionMode: () => ({ mode: 'plan' }),
        rewindFilesResult: { canRewind: true, filesChanged: ['a.ts'] },
        setMcpServersResult: { added: ['s1'], removed: [], errors: {} },
        turns: [
          async (message, ctrl) => {
            const decision = await ctrl.askPermission(
              'Bash',
              { command: 'echo ok' },
              { toolUseID: 'tu-perm', requestId: 'req-perm' },
            );
            seenPermissions.push(decision?.behavior ?? 'null');
            ctrl.emit({
              type: 'result',
              subtype: 'success',
              is_error: false,
              result: 'turn-1-ok',
              parent_tool_use_id: null,
              uuid: message.uuid,
            });
          },
          {
            records: [
              {
                type: 'result',
                subtype: 'success',
                is_error: false,
                result: 'turn-2-ok',
              },
            ],
          },
        ],
      });

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.332',
        ambient: ambientIn(root),
        query: harness.query,
      });
      const profile = {
        profileId: 'sdk-fake',
        engine: 'claude-sdk' as const,
        home: join(root, 'h'),
      };

      // 1. probeCapabilities works cleanly without inference.
      const probed = await driver.probeCapabilities({ profile, cwd: root });
      expect(probed.models).toHaveLength(1);
      expect(probed.commands).toHaveLength(1);
      expect(probed.account?.email).toBe('dev@example.invalid');

      // 2. Multi-turn session stays on ONE open run, exercises canUseTool and live controls,
      //    and reports readUsage().supported === false when usage config is omitted.
      const session = await driver.open({ profile, cwd: root });
      try {
        const turn1 = await session.startTurn({
          turnId: 't-1',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'first' }],
        });
        const deltas1 = [];
        for await (const delta of turn1.deltas) {
          deltas1.push(delta);
          if (delta.type === 'request') {
            await turn1.respond(delta.interactionId, { kind: 'approve' });
          }
        }
        expect(deltas1.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(seenPermissions).toEqual(['allow']);

        const deltas2 = await drain(
          await session.startTurn({
            turnId: 't-2',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'second' }],
          }),
        );
        expect(deltas2.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(harness.promptMessages).toHaveLength(2);
        // 1 probe run + 1 session run serving BOTH turns.
        expect(runsStarted).toBe(2);

        expect((await session.initializationResult()).output_style).toBe('concise');
        expect((await session.getContextUsage()).totalTokens).toBe(512);
        expect((await session.mcpServerStatus())[0]?.name).toBe('docs');
        expect((await session.setMcpServers({})).added).toEqual(['s1']);
        expect(await session.setPermissionMode('acceptEdits')).toEqual({
          mode: 'plan',
        });
        await session.setModel('claude-sonnet-4-6');
        await session.applyFlagSettings({ effortLevel: 'high' });
        const rewind = await session.rewindFiles('m1', { dryRun: true });
        expect(rewind.canRewind).toBe(true);
        expect(rewind.filesChanged).toEqual(['a.ts']);
        expect((await session.readUsage()).supported).toBe(false);
        expect(harness.calls.map((c) => c.method)).toContain('setPermissionMode');
        expect(harness.calls.map((c) => c.method)).toContain('applyFlagSettings');
      } finally {
        await session.close();
      }

      // 3. Functional usage provider makes readUsage().supported === true, and controller.fail/end +
      //    abort forwarding/cleanup work cleanly.
      let usageCalls = 0;
      const withUsage = createFakeClaudeSdkQuery({
        usage: () => {
          usageCalls += 1;
          return {
            session: {
              total_cost_usd: 0.1,
              total_api_duration_ms: 100,
              total_duration_ms: 200,
              total_lines_added: 1,
              total_lines_removed: 0,
              model_usage: {},
            },
            subscription_type: 'max',
            rate_limits_available: true,
            rate_limits: { five_hour: { utilization: 35, resets_at: '2026-12-01T00:00:00Z' } },
            behaviors: null,
          };
        },
        turns: [
          (_msg, ctrl) => {
            ctrl.fail(new Error('ctrl-forced-fail'));
          },
          (_msg, ctrl) => {
            ctrl.end();
          },
        ],
      });
      const usageDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.332',
        ambient: ambientIn(root),
        query: withUsage.query,
      });
      const usageSession = await usageDriver.open({ profile, cwd: root });
      try {
        const res = await usageSession.readUsage();
        expect(usageCalls).toBe(1);
        expect(res.supported).toBe(true);
        if (res.supported) {
          expect(res.planLimits.plan).toBe('max');
          expect(res.planLimits.windows).toMatchObject([
            { name: 'five_hour', usedPercent: 35 },
          ]);
        }
        await expect(
          drain(
            await usageSession.startTurn({
              turnId: 't-fail',
              clientId: crypto.randomUUID(),
              input: [{ type: 'text', text: 'fail' }],
            }),
          ),
        ).rejects.toThrow(/ctrl-forced-fail/);
        await expect(
          drain(
            await usageSession.startTurn({
              turnId: 't-eof',
              clientId: crypto.randomUUID(),
              input: [{ type: 'text', text: 'eof' }],
            }),
          ),
        ).rejects.toThrow();
      } finally {
        await usageSession.close();
      }

      // 4. Pre-aborted abortController ends immediately and close() detaches its abort listener;
      //    askPermission forwards caller abort signal cleanly.
      const preAborted = new AbortController();
      preAborted.abort(new Error('already-aborted'));
      const fakePre = createFakeClaudeSdkQuery();
      async function* emptyPrompt() {
        await new Promise<never>(() => undefined);
      }
      const preRun = fakePre.query({
        prompt: emptyPrompt(),
        options: { abortController: preAborted },
      });
      const seenPre: unknown[] = [];
      for await (const rec of preRun) seenPre.push(rec);
      expect(seenPre).toEqual([]);

      let permSignalAborted = false;
      const permAbortHarness = createFakeClaudeSdkQuery({
        turns: [
          async (_msg, ctrl) => {
            const pAbort = new AbortController();
            setTimeout(() => pAbort.abort(new Error('perm-cancel')), 10);
            await ctrl.askPermission(
              'Bash',
              { command: 'sleep 1' },
              { signal: pAbort.signal },
            );
            ctrl.end();
          },
        ],
      });
      async function* onePrompt() {
        yield {
          type: 'user' as const,
          message: { role: 'user' as const, content: 'go' },
          parent_tool_use_id: null,
          session_id: 's1',
          uuid: crypto.randomUUID(),
        };
      }
      const runAbort = new AbortController();
      const permRun = permAbortHarness.query({
        prompt: onePrompt(),
        options: {
          abortController: runAbort,
          canUseTool: async (_tool, _input, opts) => {
            await new Promise<void>((resolve) => {
              opts.signal.addEventListener(
                'abort',
                () => {
                  permSignalAborted = true;
                  resolve();
                },
                { once: true },
              );
            });
            return { behavior: 'deny', message: 'aborted' };
          },
        },
      });
      for await (const _ of permRun) {
        // drain
      }
      permRun.close?.();
      expect(permSignalAborted).toBe(true);
    }));

  test('makeExecutorDelta, makeCodexNotificationEvent, and makeCodexThreadFixture produce schema-valid fixtures', () => {
    const text = makeExecutorDelta({ type: 'text', text: 'hi' });
    const textWithExplicitUndefined = makeExecutorDelta({
      type: 'text',
      text: 'hi',
      turnId: undefined,
      itemId: undefined,
      raw: undefined,
    });
    expect(textWithExplicitUndefined).toEqual(text);
    const status = makeExecutorDelta({ type: 'status', phase: 'initializing' });
    const end = makeExecutorDelta({ type: 'turn-end', outcome: 'completed' });
    for (const delta of [text, status, end]) {
      expect(ExecutorDeltaSchema.parse(delta)).toEqual(delta);
    }

    const note = makeCodexNotificationEvent('turn/started', {
      threadId: 'th-1',
      turn: { id: 't-1', status: 'inProgress', items: [] },
    });
    expect(parseCodexNotification(note)?.method).toBe('turn/started');
    expect(() => makeCodexNotificationEvent('', {})).toThrow(TypeError);

    const thread = makeCodexThreadFixture({ id: 'th-custom', name: 'Demo' });
    expect(CodexThreadSchema.parse(thread)).toMatchObject({ id: 'th-custom', name: 'Demo' });
    const defaultIdThread = makeCodexThreadFixture({ id: undefined });
    expect(CodexThreadSchema.parse(defaultIdThread).id).toBe('thread-1');
  });

  test('agent-executor entrypoints and testing stubs compile cleanly under exactOptionalPropertyTypes: true alongside real @anthropic-ai/claude-agent-sdk', () => {
    const probePath = join(CORE_ROOT, 'src/__exact_optional_probe__.ts');
    const probeSource = `
      import { query as realSdkQuery } from '@anthropic-ai/claude-agent-sdk';
      import type {
        ExecutorProfileConfig,
        JsonRpcPeerConfig,
      } from './entrypoints/agent-executor';
      import type {
        AcpDriverConfig,
        AcpOpenInput,
      } from './entrypoints/agent-executor/acp';
      import type { ClaudeCliDriverConfig } from './entrypoints/agent-executor/claude';
      import type {
        ClaudeSdkDriverConfig,
        ClaudeSdkOpenInput,
        ClaudeSdkQuery,
      } from './entrypoints/agent-executor/claude-sdk';
      import type {
        CodexDriverConfig,
        CodexRpcCallOptions,
        CodexSharedServerOpenInput,
      } from './entrypoints/agent-executor/codex';
      import {
        createFakeCodexAppServer,
        createStubAcpSession,
        createStubAgentEngineTurn,
        createStubCodexControlClient,
        createStubCodexControlConnection,
        createStubCodexSession,
        createStubCodexSharedServer,
        createStubCodexTurn,
        makeCodexNotificationEvent,
        makeCodexThreadFixture,
        makeExecutorDelta,
        type ReplayExecutorDriverConfig,
      } from './entrypoints/agent-executor/testing';
      import {
        createFakeClaudeSdkQuery,
        createStubClaudeSdkSession,
      } from './entrypoints/agent-executor/testing/claude-sdk';

      export const sdkQueryCheck: ClaudeSdkQuery = realSdkQuery;
      export const profileCheck: ExecutorProfileConfig = {
        profileId: 'p',
        engine: 'codex',
        home: '/tmp/h',
        accountLabel: undefined,
        env: undefined,
      };
      export const peerCheck: JsonRpcPeerConfig = {
        header: 'jsonrpc-2.0',
        send: () => undefined,
        requestTimeoutMs: 1000,
        onRequest: undefined,
        onNotification: undefined,
      };
      export const codexCfg: CodexDriverConfig = {
        executable: undefined,
        transport: undefined,
        maxFrameBytes: undefined,
        onNotification: undefined,
        serverRequestDelivery: undefined,
      };
      export const codexRpcOpts: CodexRpcCallOptions = {
        timeoutMs: undefined,
        signal: undefined,
      };
      export const codexSharedOpen: CodexSharedServerOpenInput = {
        profile: profileCheck,
        cwd: '/tmp',
        onStartupPhase: undefined,
        signal: undefined,
      };
      export const claudeSdkCfg: ClaudeSdkDriverConfig = {
        query: sdkQueryCheck,
        sdkVersion: '0.3.332',
        model: undefined,
        permissionMode: undefined,
        onProviderPid: undefined,
      };
      export const claudeSdkOpen: ClaudeSdkOpenInput = {
        profile: profileCheck,
        cwd: '/tmp',
        nativeThreadId: undefined,
        resumeSessionAt: undefined,
      };
      export const claudeCliCfg: ClaudeCliDriverConfig = {
        executable: undefined,
        model: undefined,
      };
      export const acpCfg: AcpDriverConfig = {
        executable: 'acp',
        onProviderPid: undefined,
        permissionRequestDelivery: undefined,
      };
      export const acpOpen: AcpOpenInput = {
        profile: profileCheck,
        cwd: '/tmp',
        model: undefined,
      };
      export const replayCfg: ReplayExecutorDriverConfig = {
        engine: 'codex',
        turns: [],
        version: undefined,
        workspace: undefined,
        models: undefined,
      };
      export const fakeCodex = () =>
        createFakeCodexAppServer({
          socketPath: '/tmp/x.sock',
          userAgent: undefined,
          handlers: undefined,
          maxFrameBytes: undefined,
        });
      export const fakeClaude = createFakeClaudeSdkQuery({
        turns: undefined,
        usage: undefined,
        onRun: undefined,
      });
      export const stubClient = createStubCodexControlClient({ readConfig: undefined });
      export const stubConn = createStubCodexControlConnection({
        userAgent: undefined,
        providerPid: undefined,
      });
      export const stubCodexSess = createStubCodexSession({
        userAgent: undefined,
        providerPid: undefined,
      });
      export const stubShared = createStubCodexSharedServer({
        userAgent: undefined,
        providerPid: undefined,
      });
      export const stubCodexTurn = createStubCodexTurn({
        deltas: undefined,
        interrupt: undefined,
      });
      export const stubEngineTurn = createStubAgentEngineTurn({
        deltas: undefined,
        interrupt: undefined,
      });
      export const stubClaudeSess = createStubClaudeSdkSession({
        providerPid: undefined,
        close: undefined,
      });
      export const stubAcp = createStubAcpSession({
        providerPid: undefined,
        title: undefined,
      });
      export const deltaFix = makeExecutorDelta({
        type: 'text',
        text: 'ok',
        turnId: undefined,
        itemId: undefined,
        raw: undefined,
      });
      export const noteFix = makeCodexNotificationEvent('turn/started', undefined);
      export const threadFix = makeCodexThreadFixture({ id: undefined, name: undefined });
    `;

    const compilerOptions: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      strict: true,
      exactOptionalPropertyTypes: true,
      skipLibCheck: true,
      noEmit: true,
    };
    const host = ts.createCompilerHost(compilerOptions);
    const origGetSourceFile = host.getSourceFile.bind(host);
    const origFileExists = host.fileExists.bind(host);
    const origReadFile = host.readFile.bind(host);
    host.getSourceFile = (name, languageVersion, ...rest) =>
      name === probePath
        ? ts.createSourceFile(name, probeSource, languageVersion, true)
        : origGetSourceFile(name, languageVersion, ...rest);
    host.fileExists = (name) => name === probePath || origFileExists(name);
    host.readFile = (name) => (name === probePath ? probeSource : origReadFile(name));

    const program = ts.createProgram([probePath], compilerOptions, host);
    const diagnostics = ts
      .getPreEmitDiagnostics(program, program.getSourceFile(probePath))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  });
});
