/**
 * Claude SDK leaf regressions: open refused by an abort, a refused turn that leaves the
 * session usable, `canUseTool` answered on abort, crash and turn end with no listener left,
 * and empty tool ids.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  AccountInfo,
  McpServerStatus,
  ModelInfo,
  Options,
  RewindFilesResult,
  SDKControlInitializeResponse,
  SlashCommand,
  SpawnedProcess,
} from '@anthropic-ai/claude-agent-sdk';
import {
  type ClaudeSdkQuery,
  type ClaudeSdkRun,
  createClaudeSdkDriver,
} from '../../src/agent-executor/claude-sdk/driver';
import { type ExecutorDelta, ExecutorDeltaSchema } from '../../src/agent-executor/vocabulary';
import {
  ambientIn,
  countedSignal,
  drain,
  drainApproving,
  inScratch,
} from '../support/engine-driver-harness';
import { reapAfterEachTest, trackProcess } from '../support/process-reaper';

reapAfterEachTest();

function sdkDriver(root: string, query: ClaudeSdkQuery) {
  return createClaudeSdkDriver({ sdkVersion: '0.3.330', ambient: ambientIn(root), query });
}

function sdkProfile(root: string) {
  return { profileId: 'p', engine: 'claude-sdk' as const, home: join(root, 'home') };
}

function textTurn(turnId: string, clientId: string = crypto.randomUUID()) {
  return { turnId, clientId, input: [{ type: 'text' as const, text: 'hi' }] };
}

/** A successful result for the prompt record `uuid`. */
function success(uuid: unknown, result = 'ok') {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: 's',
    result,
    uuid,
  };
}

/** A query that, per prompt, asks `canUseTool` with `signal`, lets `during` run, then succeeds. */
function askingQuery(ask: {
  name: string;
  toolUseID: string;
  signal: () => AbortSignal;
  during?: (permission: Promise<unknown> | undefined) => Promise<void>;
}): ClaudeSdkQuery {
  return ({ prompt, options }) => {
    async function* run(): AsyncGenerator<unknown> {
      for await (const message of prompt) {
        const permission = options?.canUseTool?.(
          ask.name,
          { path: 'x' },
          { signal: ask.signal(), toolUseID: ask.toolUseID, requestId: 'r' },
        );
        await ask.during?.(permission);
        yield success(message.uuid);
      }
    }
    const records = run();
    return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
  };
}

describe('Claude SDK open', () => {
  test('an already-aborted signal refuses open with its reason', () =>
    inScratch('sdk-pre-aborted', async (root) => {
      const aborted = new AbortController();
      aborted.abort(new Error('nope'));
      const driver = sdkDriver(root, () => {
        throw new Error('query must not start on an aborted open');
      });
      await expect(
        driver.open({ profile: sdkProfile(root), cwd: root, signal: aborted.signal }),
      ).rejects.toThrow('nope');
    }));

  test('an abort while the transcript is checked rejects open before a query starts', () =>
    inScratch('sdk-abort-open', async (root) => {
      const aborted = new AbortController();
      const driver = sdkDriver(root, () => {
        throw new Error('query must not start on an aborted open');
      });
      const opening = driver.open({
        profile: sdkProfile(root),
        cwd: root,
        nativeThreadId: 'existing-session',
        signal: aborted.signal,
      });
      aborted.abort(new Error('aborted-during-transcript-check'));
      await expect(opening).rejects.toThrow('aborted-during-transcript-check');
    }));
});

describe('Claude SDK caller signal', () => {
  /** A query that takes each prompt and never answers it. */
  const silent: ClaudeSdkQuery = ({ prompt }) => {
    async function* run(): AsyncGenerator<unknown> {
      for await (const _message of prompt) await new Promise<never>(() => undefined);
    }
    const records = run();
    return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
  };

  test("the caller's abort ends the running turn with the caller's reason", () =>
    inScratch('sdk-caller-abort', async (root) => {
      const caller = countedSignal();
      const session = await sdkDriver(root, silent).open({
        profile: sdkProfile(root),
        cwd: root,
        signal: caller.signal,
      });
      const turn = await session.startTurn(textTurn('t'));
      const reason = new Error('the caller stopped');
      caller.abort(reason);
      await expect(drain(turn)).rejects.toBe(reason);
      await session.close();
    }));

  test("a closed session leaves no listener on the caller's signal", () =>
    inScratch('sdk-caller-release', async (root) => {
      const caller = countedSignal();
      const session = await sdkDriver(root, silent).open({
        profile: sdkProfile(root),
        cwd: root,
        signal: caller.signal,
      });
      expect(caller.listeners()).toBe(1);
      await session.close();
      expect(caller.listeners()).toBe(0);
    }));
});

describe('Claude SDK turns', () => {
  test('a turn with an invalid clientId is refused, and the session stays usable', () =>
    inScratch('sdk-invalid-turn', async (root) => {
      const driver = sdkDriver(
        root,
        askingQuery({
          name: 'Write',
          toolUseID: 'u',
          signal: () => new AbortController().signal,
        }),
      );
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(session.startTurn(textTurn('bad', 'not-a-uuid'))).rejects.toThrow(/UUID/);
        const deltas = await drainApproving(await session.startTurn(textTurn('ok')));
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      } finally {
        await session.close();
      }
    }));

  test('canUseTool whose signal aborts is denied with interrupt', () =>
    inScratch('sdk-tool-abort', async (root) => {
      const outcomes: unknown[] = [];
      const controller = new AbortController();
      const driver = sdkDriver(
        root,
        askingQuery({
          name: 'Write',
          toolUseID: 'u',
          signal: () => controller.signal,
          async during(permission) {
            controller.abort();
            outcomes.push(await permission);
          },
        }),
      );
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await drain(await session.startTurn(textTurn('t')));
        expect(outcomes).toEqual([
          { behavior: 'deny', interrupt: true, message: 'The tool request was aborted' },
        ]);
      } finally {
        await session.close();
      }
    }));

  describe('a normal turn end with canUseTool still waiting', () => {
    let deltas: ExecutorDelta[] = [];
    let outcome: unknown;
    let listeners = -1;

    beforeAll(() =>
      inScratch('sdk-end-drain', async (root) => {
        const counted = countedSignal();
        const driver = sdkDriver(
          root,
          askingQuery({
            name: 'Write',
            toolUseID: 'tu-1',
            signal: () => counted.signal,
            async during(permission) {
              void permission?.then((value) => {
                outcome = value;
              });
              await Bun.sleep(5);
            },
          }),
        );
        const session = await driver.open({ profile: sdkProfile(root), cwd: root });
        try {
          deltas = await drain(await session.startTurn(textTurn('t-end-drain')));
          await Bun.sleep(10);
          // Read before close(): the turn end itself must have drained it.
          listeners = counted.listeners();
        } finally {
          await session.close();
        }
      }),
    );

    test('the turn completes', () => {
      expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
    });

    test('the waiting permission is denied with interrupt by the turn end, before close', () => {
      expect(outcome).toEqual({
        behavior: 'deny',
        message: 'The turn ended',
        interrupt: true,
      });
    });

    test('no abort listener is left on the tool signal', () => {
      expect(listeners).toBe(0);
    });
  });

  describe('a query that crashes while canUseTool waits', () => {
    let failure: unknown;
    let outcome: unknown;
    let listeners = -1;
    let promptEnded = false;
    let closeCalls = 0;

    beforeAll(() =>
      inScratch('sdk-crash', async (root) => {
        const counted = countedSignal();
        const driver = sdkDriver(root, ({ prompt, options }) => {
          const input = prompt[Symbol.asyncIterator]();
          async function* run(): AsyncGenerator<unknown> {
            const first = await input.next();
            if (first.done) return;
            void input.next().then((next) => {
              promptEnded = next.done === true;
            });
            void options
              ?.canUseTool?.(
                'Bash',
                { command: 'ls' },
                { signal: counted.signal, toolUseID: 'call-1', requestId: 'req-1' },
              )
              .then((value) => {
                outcome = value;
              });
            // Let the permission register, then crash the query.
            await Bun.sleep(5);
            throw new Error('query crashed mid-permission');
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            close() {
              closeCalls += 1;
              throw new Error('close sync failure must be contained');
            },
          };
        });
        const session = await driver.open({ profile: sdkProfile(root), cwd: root });
        try {
          failure = await drain(await session.startTurn(textTurn('t-crash'))).catch(
            (error: unknown) => error,
          );
          await Bun.sleep(15);
          listeners = counted.listeners();
        } finally {
          await session.close();
        }
      }),
    );

    test('the turn fails with the query error', () => {
      expect(String(failure)).toContain('query crashed mid-permission');
    });

    test('the waiting permission is denied with interrupt', () => {
      expect(outcome).toMatchObject({ behavior: 'deny', interrupt: true });
    });

    test('no abort listener is left on the tool signal', () => {
      expect(listeners).toBe(0);
    });

    test('the prompt stream is ended', () => {
      expect(promptEnded).toBe(true);
    });

    test('query.close() is called once and its synchronous failure is contained', () => {
      expect(closeCalls).toBe(1);
    });
  });
});

describe('Claude SDK empty ids', () => {
  test('an empty tool name and toolUseID still give deltas that pass ExecutorDeltaSchema', () =>
    inScratch('sdk-empty-ids', async (root) => {
      const driver = sdkDriver(
        root,
        askingQuery({
          name: '',
          toolUseID: '',
          signal: () => new AbortController().signal,
          async during(permission) {
            await permission;
          },
        }),
      );
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn = await session.startTurn(textTurn('t-sdk'));
        const deltas: ExecutorDelta[] = [];
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          deltas.push(delta);
          if (delta.type === 'request')
            await turn.respond(delta.interactionId, { kind: 'approve' });
        }
        expect(deltas.some((delta) => delta.type === 'request')).toBe(true);
      } finally {
        await session.close();
      }
    }));
});

function fakeSpawnedProcess(
  pid: number,
): SpawnedProcess & { readonly pid: number; killedBy?: string } {
  const proc: SpawnedProcess & { readonly pid: number; killedBy?: string } = {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    exitCode: null,
    kill(sig) {
      proc.killedBy = sig;
      return true;
    },
    on() {
      // no-op
    },
    once() {
      // no-op
    },
    off() {
      // no-op
    },
  };
  return proc;
}

describe('Claude SDK host options, delegation verification, providerPid and live controls', () => {
  test('forwards host launch and delegation options to query, refuses non-empty supportedDialogKinds without onUserDialog, and supports forkSession', () =>
    inScratch('sdk-host-options', async (root) => {
      // Eager validation: non-empty supportedDialogKinds without onUserDialog refuses at driver creation.
      expect(() =>
        createClaudeSdkDriver({
          query: () => {
            throw new Error('must not start');
          },
          sdkVersion: '0.3.330',
          supportedDialogKinds: ['confirm'],
        }),
      ).toThrow(/onUserDialog/);
      expect(() =>
        createClaudeSdkDriver({
          query: () => {
            throw new Error('must not start');
          },
          sdkVersion: '0.3.330',
          verifyDelegation: { requireHooksApplied: true, timeoutMs: 0 },
        }),
      ).toThrow();

      // Empty supportedDialogKinds without onUserDialog is allowed.
      expect(() =>
        createClaudeSdkDriver({
          query: () => {
            throw new Error('unused');
          },
          sdkVersion: '0.3.330',
          supportedDialogKinds: [],
        }),
      ).not.toThrow();

      const seenOptions: Array<Options | undefined> = [];
      const seenPids: number[] = [];
      const forked: Array<{ id: string; opts: unknown }> = [];
      const stderrLines: string[] = [];
      const guardHook: NonNullable<Options['hooks']> = {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse' as const,
                  permissionDecision: 'allow' as const,
                },
              }),
            ],
          },
        ],
      };
      const onUserDialog: NonNullable<Options['onUserDialog']> = async () => ({
        behavior: 'cancelled',
      });
      const fakeProc = fakeSpawnedProcess(424242);

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        model: 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        pathToClaudeCodeExecutable: '/usr/local/bin/claude-custom',
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        settingSources: ['user', 'project', 'local'],
        enableFileCheckpointing: true,
        supportedDialogKinds: ['confirm'],
        onUserDialog,
        hooks: guardHook,
        tools: ['Read', 'Glob', 'Grep'],
        allowedTools: ['Read', 'Glob', 'Grep'],
        disallowedTools: ['Bash'],
        mcpServers: {},
        mcpServersDelivery: 'initialize',
        strictMcpConfig: true,
        plugins: [],
        agents: {},
        extraArgs: { 'strict-mcp-config': null },
        stderr: (chunk) => stderrLines.push(chunk),
        spawnClaudeCodeProcess: () => fakeProc,
        onProviderPid: (pid) => seenPids.push(pid),
        forkSession: async (id, opts) => {
          forked.push({ id, opts });
          return { sessionId: `forked-${id}` };
        },
        query: ({ prompt, options }) => {
          seenOptions.push(options);
          options?.spawnClaudeCodeProcess?.({
            command: '/usr/local/bin/claude-custom',
            args: [],
            cwd: root,
            env: {},
            signal: new AbortController().signal,
          });
          options?.stderr?.('diag-line');
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              yield success(message.uuid);
            }
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });

      const forkRes = await driver.forkSession('orig-1', { upToMessageId: 'msg-9' });
      expect(forkRes).toEqual({ sessionId: 'forked-orig-1' });
      expect(forked).toEqual([{ id: 'orig-1', opts: { upToMessageId: 'msg-9' } }]);
      await expect(driver.forkSession('   ')).rejects.toThrow(TypeError);

      const noForkDriver = sdkDriver(root, () => {
        throw new Error('unused');
      });
      await expect(noForkDriver.forkSession('orig-1')).rejects.toThrow(/forkSession/);

      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        expect(session.providerPid).toBeUndefined();
        await drain(await session.startTurn(textTurn('t-host')));
        expect(session.providerPid).toBe(424242);
        expect(seenPids).toEqual([424242]);
        expect(stderrLines).toEqual(['diag-line']);
        expect(seenOptions[0]).toMatchObject({
          pathToClaudeCodeExecutable: '/usr/local/bin/claude-custom',
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          settingSources: ['user', 'project', 'local'],
          enableFileCheckpointing: true,
          supportedDialogKinds: ['confirm'],
          onUserDialog,
          hooks: guardHook,
          tools: ['Read', 'Glob', 'Grep'],
          allowedTools: ['Read', 'Glob', 'Grep'],
          disallowedTools: ['Bash'],
          mcpServers: {},
          mcpServersDelivery: 'initialize',
          strictMcpConfig: true,
          plugins: [],
          agents: {},
          extraArgs: { 'strict-mcp-config': null },
          allowDangerouslySkipPermissions: true,
        });
      } finally {
        await session.close();
      }
      expect(session.providerPid).toBeUndefined();
    }));

  test('default spawner for onProviderPid drains streaming UTF-8 stderr, records real child pid, clears it on exit, and kills child if onProviderPid throws', () =>
    inScratch('sdk-default-spawn-pid', async (root) => {
      const capturedStderr: string[] = [];
      const capturedPids: number[] = [];
      let observedPidWhileAlive: number | undefined;
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        stderr: (chunk) => capturedStderr.push(chunk),
        onProviderPid: (pid) => {
          trackProcess(pid);
          capturedPids.push(pid);
        },
        query: ({ prompt, options }) => {
          const child = options?.spawnClaudeCodeProcess?.({
            command: process.execPath,
            // Emit split multi-byte UTF-8 + >64 KiB on stderr so streaming decoder & pipe drain are exercised.
            args: [
              '-e',
              'const emoji = Buffer.from("🚀", "utf8"); process.stderr.write(emoji.subarray(0, 2)); setTimeout(() => { process.stderr.write(emoji.subarray(2)); process.stderr.write("e".repeat(80000)); process.exit(0); }, 25);',
            ],
            cwd: root,
            env: options.env ?? {},
            signal: new AbortController().signal,
          });
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<void>((resolve) => {
              child?.once('exit', () => resolve());
            });
            for await (const message of prompt) yield success(message.uuid);
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn = await session.startTurn(textTurn('t-default-spawn'));
        observedPidWhileAlive = session.providerPid;
        await drain(turn);
        expect(capturedPids).toHaveLength(1);
        expect(observedPidWhileAlive).toBe(capturedPids[0]);
        // Once the child exited, proc.once('exit') cleared providerPid to undefined.
        expect(session.providerPid).toBeUndefined();
        const combined = capturedStderr.join('');
        expect(combined.startsWith('🚀')).toBe(true);
        expect(combined.length).toBe('🚀'.length + 80_000);
      } finally {
        await session.close();
      }

      // If onProviderPid throws or config.query throws synchronously after spawn, providerPid is cleared fail-closed.
      const badProc = fakeSpawnedProcess(515151);
      const throwingDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        spawnClaudeCodeProcess: () => badProc,
        onProviderPid: () => {
          throw new Error('ownership registration failed');
        },
        query: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({
            command: 'claude',
            args: [],
            cwd: root,
            env: {},
            signal: new AbortController().signal,
          });
          async function* run(): AsyncGenerator<unknown> {
            // unreachable
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      const s2 = await throwingDriver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(s2.startTurn(textTurn('t-throw'))).rejects.toThrow(
          /ownership registration failed/,
        );
        expect(badProc.killedBy).toBe('SIGTERM');
        expect(s2.providerPid).toBeUndefined();
      } finally {
        await s2.close();
      }

      // Synchronous throw from config.query() after spawn clears providerPid.
      const syncThrowProc = fakeSpawnedProcess(616161);
      const syncThrowDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        spawnClaudeCodeProcess: () => syncThrowProc,
        query: ({ options }) => {
          options?.spawnClaudeCodeProcess?.({
            command: 'claude',
            args: [],
            cwd: root,
            env: {},
            signal: new AbortController().signal,
          });
          throw new Error('sync query boom');
        },
      });
      const s3 = await syncThrowDriver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(s3.startTurn(textTurn('t-sync-throw'))).rejects.toThrow(
          /sync query boom/,
        );
        expect(s3.providerPid).toBeUndefined();
      } finally {
        await s3.close();
      }
    }));

  test('verifyDelegation runs eagerly at open, closes query and releases caller signal on refusal, and re-runs on restart', () =>
    inScratch('sdk-verify-delegation', async (root) => {
      const makeInit = (hooksApplied?: boolean): SDKControlInitializeResponse => ({
        commands: [],
        agents: [],
        output_style: 'default',
        available_output_styles: ['default'],
        models: [],
        account: {},
        ...(hooksApplied !== undefined && { hooks_applied: hooksApplied }),
      });

      // Case 1: hooks_applied !== true refuses open, closes query, leaves 0 listeners on caller signal.
      let closedCount = 0;
      const caller = countedSignal();
      const hooksUnapplied = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireHooksApplied: true, requireNoMcpServers: true },
        query: () => {
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            close: () => {
              closedCount += 1;
            },
            initializationResult: async () => makeInit(false),
            mcpServerStatus: async () => [],
          };
        },
      });
      await expect(
        hooksUnapplied.open({ profile: sdkProfile(root), cwd: root, signal: caller.signal }),
      ).rejects.toThrow(/hooks_applied/);
      expect(closedCount).toBe(1);
      expect(caller.listeners()).toBe(0);

      // Case 2: non-empty mcpServerStatus refuses open.
      const mcpExposed = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireHooksApplied: true, requireNoMcpServers: true },
        query: () => {
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            initializationResult: async () => makeInit(true),
            mcpServerStatus: async () => [
              { name: 'leak-mcp', status: 'connected' } as McpServerStatus,
            ],
          };
        },
      });
      await expect(mcpExposed.open({ profile: sdkProfile(root), cwd: root })).rejects.toThrow(
        /exposed 1 MCP server/,
      );

      // Case 2b: non-array mcpServerStatus response refuses fail-closed.
      const mcpMalformed = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireNoMcpServers: true },
        query: () => {
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            // Intentionally return a non-array at runtime to prove fail-closed handling.
            mcpServerStatus: async () => JSON.parse('{"servers":["leak"]}'),
          };
        },
      });
      await expect(
        mcpMalformed.open({ profile: sdkProfile(root), cwd: root }),
      ).rejects.toThrow(/non-array mcpServerStatus/);

      // Case 3: missing initializationResult / timeout refuses fail-closed.
      const missingInit = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireHooksApplied: true },
        query: () => {
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      await expect(missingInit.open({ profile: sdkProfile(root), cwd: root })).rejects.toThrow(
        /initializationResult/,
      );

      const timedOut = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireHooksApplied: true, timeoutMs: 25 },
        query: () => {
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            initializationResult: () =>
              new Promise<SDKControlInitializeResponse>(() => undefined),
          };
        },
      });
      await expect(timedOut.open({ profile: sdkProfile(root), cwd: root })).rejects.toThrow(
        /timed out/,
      );

      // Case 4: passes at open, crashes during turn 1, then re-verifies delegation on restart for turn 2.
      let attempt = 0;
      const reverifyDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireHooksApplied: true, requireNoMcpServers: true },
        query: ({ prompt }) => {
          attempt += 1;
          const n = attempt;
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              if (n === 1) throw new Error('boom on turn 1');
              yield success(message.uuid);
            }
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            initializationResult: async () => makeInit(n === 1),
            mcpServerStatus: async () => [],
          };
        },
      });
      const session = await reverifyDriver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(drain(await session.startTurn(textTurn('t1')))).rejects.toThrow(/boom/);
        // Second query fails hooks_applied -> refused before turn 2 dispatches!
        await expect(session.startTurn(textTurn('t2'))).rejects.toThrow(/hooks_applied/);
        expect(attempt).toBe(2);
      } finally {
        await session.close();
      }
    }));

  test('ClaudeSdkSession exposes live controls, replays model/permissionMode/flagSettings across restarts, and refuses after close or missing methods', () =>
    inScratch('sdk-live-controls', async (root) => {
      const calls: Array<{ run: number; method: string; args: unknown[] }> = [];
      const openedOptions: Array<Options | undefined> = [];
      let runNumber = 0;

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query: ({ prompt, options }) => {
          runNumber += 1;
          const n = runNumber;
          openedOptions.push(options);
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              if (n === 1) throw new Error('first query crashed');
              yield success(message.uuid);
            }
          }
          const records = run();
          const handle: ClaudeSdkRun = {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            setModel: async (model) => {
              calls.push({ run: n, method: 'setModel', args: [model] });
            },
            setPermissionMode: async (mode) => {
              calls.push({ run: n, method: 'setPermissionMode', args: [mode] });
            },
            applyFlagSettings: async (settings) => {
              calls.push({ run: n, method: 'applyFlagSettings', args: [settings] });
            },
            initializationResult: async () => {
              calls.push({ run: n, method: 'initializationResult', args: [] });
              return {
                commands: [],
                agents: [],
                output_style: 'default',
                available_output_styles: ['default'],
                models: [],
                account: { email: 'dev@example.invalid' },
                hooks_applied: true,
              };
            },
            supportedModels: async () => {
              calls.push({ run: n, method: 'supportedModels', args: [] });
              return [
                {
                  value: 'claude-opus-4-6',
                  displayName: 'Opus',
                  description: 'Flagship',
                } as ModelInfo,
              ];
            },
            supportedCommands: async () => {
              calls.push({ run: n, method: 'supportedCommands', args: [] });
              return [
                { name: 'compact', description: 'Compact', argumentHint: '' } as SlashCommand,
              ];
            },
            accountInfo: async () => {
              calls.push({ run: n, method: 'accountInfo', args: [] });
              return { email: 'dev@example.invalid', subscriptionType: 'max' } as AccountInfo;
            },
            getContextUsage: async (opts) => {
              calls.push({ run: n, method: 'getContextUsage', args: [opts] });
              return {
                categories: [],
                totalTokens: 1200,
                maxTokens: 200_000,
                rawMaxTokens: 200_000,
                percentage: 0.6,
                gridRows: [],
                model: 'claude-opus-4-6',
                isAutoCompactEnabled: true,
                memoryFiles: [],
                mcpTools: [],
                agents: [],
                apiUsage: null,
              };
            },
            mcpServerStatus: async () => {
              calls.push({ run: n, method: 'mcpServerStatus', args: [] });
              return [{ name: 'docs', status: 'connected' } as McpServerStatus];
            },
            toggleMcpServer: async (name, enabled) => {
              calls.push({ run: n, method: 'toggleMcpServer', args: [name, enabled] });
            },
            reconnectMcpServer: async (name) => {
              calls.push({ run: n, method: 'reconnectMcpServer', args: [name] });
            },
            rewindFiles: async (messageId, opts) => {
              calls.push({ run: n, method: 'rewindFiles', args: [messageId, opts] });
              return { canRewind: true, filesChanged: ['a.ts'] } as RewindFilesResult;
            },
          };
          return handle;
        },
      });

      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      // Calling live controls before the first turn shares a single in-flight query start.
      const [initRes, models, commands, account, usage, mcp] = await Promise.all([
        session.initializationResult(),
        session.supportedModels(),
        session.supportedCommands(),
        session.accountInfo(),
        session.getContextUsage({ detail: 'summary' }),
        session.mcpServerStatus(),
      ]);
      expect(runNumber).toBe(1);
      expect(initRes.hooks_applied).toBe(true);
      expect(models).toHaveLength(1);
      expect(commands).toHaveLength(1);
      expect(account.email).toBe('dev@example.invalid');
      expect(usage.totalTokens).toBe(1200);
      expect(mcp).toHaveLength(1);

      await session.setModel('claude-opus-4-6');
      await session.setPermissionMode('acceptEdits');
      await session.applyFlagSettings({ effortLevel: 'high' });
      await session.toggleMcpServer('docs', false);
      await session.reconnectMcpServer('docs');
      const rewind = await session.rewindFiles('msg-1', { dryRun: true });
      expect(rewind.canRewind).toBe(true);

      // Crash turn 1, then verify turn 2 reopens with updated model, permissionMode and replayed flagSettings!
      await expect(drain(await session.startTurn(textTurn('t1')))).rejects.toThrow(
        /first query/,
      );
      const deltas2 = await drain(await session.startTurn(textTurn('t2')));
      expect(deltas2.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      expect(runNumber).toBe(2);
      expect(openedOptions[1]).toMatchObject({
        model: 'claude-opus-4-6',
        permissionMode: 'acceptEdits',
        resume: session.nativeThreadId,
      });
      expect(calls).toContainEqual({
        run: 2,
        method: 'applyFlagSettings',
        args: [{ effortLevel: 'high' }],
      });

      await session.close();
      await expect(session.supportedModels()).rejects.toThrow(/closed/);
      await expect(session.setModel('x')).rejects.toThrow(/closed/);

      // Minimal query lacking live methods refuses explicitly.
      const minimal = sdkDriver(root, () => {
        async function* run(): AsyncGenerator<unknown> {
          await new Promise<never>(() => undefined);
        }
        const records = run();
        return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
      });
      const minSession = await minimal.open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(minSession.supportedModels()).rejects.toThrow(
          /does not support supportedModels/,
        );
      } finally {
        await minSession.close();
      }

      // Idle query crash BEFORE startTurn clears running & providerPid and transparently restarts.
      let idleAttempt = 0;
      let crashFirstIdle!: () => void;
      const idleDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        spawnClaudeCodeProcess: () => fakeSpawnedProcess(700_000 + idleAttempt),
        query: ({ prompt, options }) => {
          idleAttempt += 1;
          const n = idleAttempt;
          options?.spawnClaudeCodeProcess?.({
            command: 'claude',
            args: [],
            cwd: root,
            env: {},
            signal: new AbortController().signal,
          });
          async function* run(): AsyncGenerator<unknown> {
            if (n === 1) {
              await new Promise<void>((resolve) => {
                crashFirstIdle = resolve;
              });
              throw new Error('idle child died before first turn');
            }
            for await (const message of prompt) yield success(message.uuid);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            supportedModels: async () => [],
          };
        },
      });
      const idleSession = await idleDriver.open({ profile: sdkProfile(root), cwd: root });
      try {
        await idleSession.supportedModels();
        expect(idleSession.providerPid).toBe(700_001);
        crashFirstIdle();
        await Bun.sleep(15);
        // Idle exit cleared providerPid and running handle without needing startTurn.
        expect(idleSession.providerPid).toBeUndefined();
        const deltas = await drain(
          await idleSession.startTurn(textTurn('t-after-idle-crash')),
        );
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(idleAttempt).toBe(2);
        expect(idleSession.providerPid).toBe(700_002);
      } finally {
        await idleSession.close();
      }

      // Hung live control RPC aborts cleanly when session.close() runs.
      const hungDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query: () => {
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            supportedModels: () => new Promise<ModelInfo[]>(() => undefined),
          };
        },
      });
      const hungSession = await hungDriver.open({ profile: sdkProfile(root), cwd: root });
      const pendingControl = hungSession.supportedModels();
      await Bun.sleep(5);
      await hungSession.close();
      await expect(pendingControl).rejects.toThrow();
    }));
});
