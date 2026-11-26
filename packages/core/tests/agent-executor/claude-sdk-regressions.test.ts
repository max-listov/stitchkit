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
import { z } from 'zod';
import {
  type ClaudeRuntimeEvent,
  ClaudeRuntimeEventSchema,
} from '../../src/agent-executor/claude/events';
import {
  type ClaudeSdkQuery,
  type ClaudeSdkRun,
  createClaudeSdkDriver,
} from '../../src/agent-executor/claude-sdk/driver';
import type { ClaudeSdkPermissionRequestMeta } from '../../src/agent-executor/claude-sdk/query-loop';
import {
  type ClaudeSdkTurnUsage,
  ClaudeSdkTurnUsageSchema,
} from '../../src/agent-executor/claude-sdk/turn-usage';
import { projectExecutorDeltas } from '../../src/agent-executor/projection';
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

  test('readUsage actively pulls plan limits, preserves passive cache on unsupported/unpublished, and handles RPC failure and abort', () =>
    inScratch('sdk-read-usage', async (root) => {
      const seenOpts: unknown[] = [];
      let usageMode:
        | 'unsupported'
        | 'no-plan-limit'
        | 'known'
        | 'unpublished-sub'
        | 'fail'
        | 'fail-empty'
        | 'fail-huge'
        | 'hang' = 'unsupported';
      const baseSessionUsage = {
        total_cost_usd: 0.42,
        total_api_duration_ms: 1000,
        total_duration_ms: 2000,
        total_lines_added: 10,
        total_lines_removed: 2,
        model_usage: {},
      };
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query: ({ prompt }) => {
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              yield {
                type: 'rate_limit_event',
                rate_limit_info: {
                  unifiedWindows: { five_hour: { utilization: 0.3, resetsAt: 1796032800 } },
                },
              };
              yield success(message.uuid);
            }
          }
          const records = run();
          const base: ClaudeSdkRun = {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
          };
          if (usageMode === 'unsupported') return base;
          return {
            ...base,
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts) => {
              seenOpts.push(opts);
              if (usageMode === 'hang') return new Promise(() => undefined);
              if (usageMode === 'fail') throw new Error('usage endpoint 503');
              if (usageMode === 'fail-empty') throw new Error('');
              if (usageMode === 'fail-huge') throw new Error('E'.repeat(5000));
              if (usageMode === 'no-plan-limit') {
                return {
                  session: baseSessionUsage,
                  subscription_type: null,
                  rate_limits_available: false,
                  rate_limits: null,
                  behaviors: null,
                };
              }
              if (usageMode === 'unpublished-sub') {
                return {
                  session: baseSessionUsage,
                  subscription_type: 'max',
                  rate_limits_available: false,
                  rate_limits: null,
                  behaviors: null,
                };
              }
              return {
                session: baseSessionUsage,
                subscription_type: 'max',
                rate_limits_available: true,
                rate_limits: {
                  five_hour: { utilization: 65, resets_at: '2026-11-30T10:00:00Z' },
                  seven_day: { utilization: null, resets_at: '2026-12-07T10:00:00Z' },
                  model_scoped: [
                    {
                      display_name: 'Fable',
                      utilization: 18,
                      resets_at: '2026-12-07T10:00:00Z',
                    },
                  ],
                  extra_usage: {
                    is_enabled: true,
                    monthly_limit: 5000,
                    used_credits: 1200,
                    utilization: 24,
                    currency: 'USD',
                  },
                },
                behaviors: null,
              };
            },
          };
        },
      });
      const profile = sdkProfile(root);
      // Unsupported query: passive rate_limit_event stays intact in driver.status()!
      const sUnsupported = await driver.open({ profile, cwd: root });
      try {
        await drain(await sUnsupported.startTurn(textTurn('t-passive')));
        expect((await driver.status(profile)).planLimits?.windows).toMatchObject([
          { name: 'five_hour', usedPercent: 30 },
        ]);
        const unsupported = await sUnsupported.readUsage({ skipBehaviors: true });
        expect(unsupported.supported).toBe(false);
        expect(unsupported.planLimits.answer).toBe('unpublished');
        expect((await driver.status(profile)).planLimits?.windows).toMatchObject([
          { name: 'five_hour', usedPercent: 30 },
        ]);
      } finally {
        await sUnsupported.close();
      }

      // Known windows + extra_usage preserved in raw, updates status()!
      usageMode = 'known';
      const sKnown = await driver.open({ profile, cwd: root });
      try {
        const res = await sKnown.readUsage({ skipBehaviors: true });
        expect(seenOpts).toEqual([{ skipBehaviors: true }]);
        expect(res.supported).toBe(true);
        if (!res.supported) return;
        expect(res.planLimits.answer).toBe('known');
        expect(res.planLimits.windows).toEqual([
          { name: 'five_hour', usedPercent: 65, resetsAt: '2026-11-30T10:00:00Z' },
          {
            name: 'model:Fable',
            usedPercent: 18,
            resetsAt: '2026-12-07T10:00:00Z',
            label: 'Fable',
          },
        ]);
        expect(res.raw.rate_limits?.extra_usage?.used_credits).toBe(1200);
        expect((await driver.status(profile)).planLimits?.windows).toHaveLength(2);

        // Unpublished subscription response preserves prior known cache.
        usageMode = 'unpublished-sub';
        const unpub = await sKnown.readUsage();
        expect(unpub.supported).toBe(true);
        expect(unpub.planLimits.answer).toBe('unpublished');
        expect((await driver.status(profile)).planLimits?.answer).toBe('known');

        // RPC failure keeps prior known windows beside error and rethrows, including empty/>4096 messages.
        usageMode = 'fail';
        await expect(sKnown.readUsage()).rejects.toThrow(/usage endpoint 503/);
        const afterFail = (await driver.status(profile)).planLimits;
        expect(afterFail?.answer).toBe('known');
        expect(afterFail?.error).toContain('usage endpoint 503');

        usageMode = 'fail-empty';
        await expect(sKnown.readUsage()).rejects.toThrow(Error);
        expect((await driver.status(profile)).planLimits?.error).toBe(
          'Plan limits read failed',
        );

        usageMode = 'fail-huge';
        await expect(sKnown.readUsage()).rejects.toThrow(/^E+$/);
        expect((await driver.status(profile)).planLimits?.error?.length).toBe(4096);

        // no-plan-limit updates cache authoritatively (clearing prior error).
        usageMode = 'no-plan-limit';
        const noLimit = await sKnown.readUsage();
        expect(noLimit.planLimits.answer).toBe('no-plan-limit');
        expect((await driver.status(profile)).planLimits?.answer).toBe('no-plan-limit');
        expect((await driver.status(profile)).planLimits?.error).toBeUndefined();

        // Hung readUsage unblocks cleanly on session.close() WITHOUT recording a failure into status cache.
        usageMode = 'hang';
        const pending = sKnown.readUsage();
        await Bun.sleep(5);
        await sKnown.close();
        await expect(pending).rejects.toThrow();
        expect((await driver.status(profile)).planLimits?.error).toBeUndefined();
      } finally {
        await sKnown.close();
      }
    }));

  test('canUseTool supports session-scoped addRules and turn-cancelling deny, and result preserves per-model usage', () =>
    inScratch('sdk-session-approval-model-usage', async (root) => {
      const permissions: unknown[] = [];
      const driver = sdkDriver(root, ({ prompt, options }) => {
        async function* run(): AsyncGenerator<unknown> {
          for await (const message of prompt) {
            permissions.push(
              await options?.canUseTool?.(
                'Bash',
                { command: 'echo ok' },
                { signal: new AbortController().signal, toolUseID: 'tu-1', requestId: 'r1' },
              ),
            );
            permissions.push(
              await options?.canUseTool?.(
                'Write',
                { path: 'x' },
                {
                  signal: new AbortController().signal,
                  toolUseID: 'tu-2',
                  requestId: 'r2',
                  suppressAlwaysAllowRule: true,
                },
              ),
            );
            permissions.push(
              await options?.canUseTool?.(
                '',
                { path: 'y' },
                { signal: new AbortController().signal, toolUseID: 'tu-3', requestId: 'r3' },
              ),
            );
            const overModels: Record<string, unknown> = {
              'claude-opus-4-6': {
                inputTokens: 500,
                outputTokens: 120,
                cacheReadInputTokens: 400,
                cacheCreationInputTokens: 80,
                thinkingTokens: 60,
                cacheCreationEphemeral5mInputTokens: 50,
                cacheCreationEphemeral1hInputTokens: 30,
                webSearchRequests: 2,
                costUSD: 0.123,
                contextWindow: 200_000,
                maxOutputTokens: 32_000,
                canonicalModel: 'claude-opus-4-6',
                provider: 'firstParty',
                costBasis: 'list',
              },
              malformed: { inputTokens: -1 },
            };
            for (let i = 0; i < 70; i += 1) {
              overModels[`z-model-${String(i).padStart(2, '0')}`] = {
                inputTokens: 1,
                outputTokens: 1,
              };
            }
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              session_id: 's',
              uuid: message.uuid,
              total_cost_usd: 0.123,
              usage: {
                input_tokens: 500,
                output_tokens: 120,
                cache_read_input_tokens: null,
                cache_creation_input_tokens: 80,
                output_tokens_details: { thinking_tokens: 60 },
              },
              modelUsage: overModels,
            };
          }
        }
        const records = run();
        return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
      });
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn = await session.startTurn(textTurn('t-sdk-appr'));
        const deltas: ExecutorDelta[] = [];
        let reqIndex = 0;
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          deltas.push(delta);
          if (delta.type === 'request') {
            reqIndex += 1;
            if (reqIndex === 1) {
              await turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' });
            } else if (reqIndex === 2) {
              await expect(
                turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' }),
              ).rejects.toThrow(TypeError);
              await turn.respond(delta.interactionId, {
                kind: 'deny',
                message: 'user cancelled',
                interrupt: true,
              });
            } else {
              // Empty toolName refuses scope: 'session' and stays pending for scope: 'once'.
              await expect(
                turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' }),
              ).rejects.toThrow(TypeError);
              await turn.respond(delta.interactionId, { kind: 'approve', scope: 'once' });
            }
          }
        }
        expect(permissions).toEqual([
          {
            behavior: 'allow',
            updatedInput: { command: 'echo ok' },
            updatedPermissions: [
              {
                type: 'addRules',
                rules: [{ toolName: 'Bash' }],
                behavior: 'allow',
                destination: 'session',
              },
            ],
          },
          { behavior: 'deny', message: 'user cancelled', interrupt: true },
          { behavior: 'allow', updatedInput: { path: 'y' } },
        ]);
        const usage = deltas.find((d) => d.type === 'usage');
        expect(usage).toMatchObject({
          inputTokens: 500,
          outputTokens: 120,
          cacheCreationInputTokens: 80,
          thinkingTokens: 60,
          costUsd: 0.123,
        });
        if (usage?.type !== 'usage') throw new Error('expected usage delta');
        expect(Object.keys(usage.modelUsage ?? {})).toHaveLength(64);
        expect(usage.modelUsage?.['claude-opus-4-6']).toEqual({
          inputTokens: 500,
          outputTokens: 120,
          cacheReadInputTokens: 400,
          cacheCreationInputTokens: 80,
          thinkingTokens: 60,
          cacheCreationEphemeral5mInputTokens: 50,
          cacheCreationEphemeral1hInputTokens: 30,
          webSearchRequests: 2,
          costUsd: 0.123,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
          canonicalModel: 'claude-opus-4-6',
          provider: 'firstParty',
          costBasis: 'list',
        });
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      } finally {
        await session.close();
      }
    }));

  test('onQueryExit fires on unexpected idle and mid-turn exits, not on close, abort, or failed open', () =>
    inScratch('sdk-on-query-exit', async (root) => {
      const exits: Array<{
        message: string;
        duringTurn: boolean;
        nativeThreadId: string;
        closedBeforeCallback: boolean;
        pidClearedBeforeCallback: boolean;
      }> = [];
      let triggerIdleExit: (() => void) | undefined;
      let mode: 'idle-crash' | 'idle-eof' | 'turn-crash' | 'turn-eof' | 'wait' = 'idle-crash';
      let attempt = 0;
      let queryClosedCount = 0;
      let throwSyncInExit = false;
      let activeSession: Awaited<ReturnType<typeof driver.open>> | undefined;

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        onQueryExit: (error, ctx) => {
          const closedBeforeCallback = queryClosedCount >= attempt;
          const pidClearedBeforeCallback = activeSession?.providerPid === undefined;
          exits.push({
            message: error instanceof Error ? error.message : String(error),
            duringTurn: ctx.duringTurn,
            nativeThreadId: ctx.nativeThreadId,
            closedBeforeCallback,
            pidClearedBeforeCallback,
          });
          if (throwSyncInExit) {
            throw new Error('observer sync boom');
          }
          // Rejected async callback must be contained without unhandled rejection.
          return Promise.reject(new Error('observer async boom'));
        },
        query: ({ prompt }) => {
          attempt += 1;
          const currentMode = mode;
          async function* run(): AsyncGenerator<unknown> {
            if (currentMode === 'idle-crash' || currentMode === 'idle-eof') {
              await new Promise<void>((resolve) => {
                triggerIdleExit = resolve;
              });
              if (currentMode === 'idle-crash') throw new Error('No conversation found');
              return;
            }
            for await (const message of prompt) {
              if (currentMode === 'turn-crash') throw new Error('mid-turn crash');
              if (currentMode === 'turn-eof') return;
              yield success(message.uuid);
            }
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            close: () => {
              queryClosedCount += 1;
            },
            supportedModels: async () => [],
          };
        },
      });

      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      activeSession = session;
      try {
        // 1. Idle crash between turns fires onQueryExit({ duringTurn: false }) after query.close() and state reset.
        await session.supportedModels();
        triggerIdleExit?.();
        await Bun.sleep(20);
        expect(exits).toEqual([
          {
            message: 'No conversation found',
            duringTurn: false,
            nativeThreadId: session.nativeThreadId,
            closedBeforeCallback: true,
            pidClearedBeforeCallback: true,
          },
        ]);

        // 2. Clean EOF while idle fires onQueryExit with honest idle message (and sync throw is contained).
        mode = 'idle-eof';
        throwSyncInExit = true;
        await session.supportedModels();
        triggerIdleExit?.();
        await Bun.sleep(20);
        throwSyncInExit = false;
        expect(exits[1]).toEqual({
          message: 'The Agent SDK query ended while idle',
          duringTurn: false,
          nativeThreadId: session.nativeThreadId,
          closedBeforeCallback: true,
          pidClearedBeforeCallback: true,
        });

        // 3. Mid-turn crash fires onQueryExit({ duringTurn: true }) and fails turn.
        mode = 'turn-crash';
        await expect(drain(await session.startTurn(textTurn('t-mid')))).rejects.toThrow(
          /mid-turn crash/,
        );
        await Bun.sleep(20);
        expect(exits[2]).toEqual({
          message: 'mid-turn crash',
          duringTurn: true,
          nativeThreadId: session.nativeThreadId,
          closedBeforeCallback: true,
          pidClearedBeforeCallback: true,
        });

        // 4. Clean mid-turn EOF fires onQueryExit with honest mid-turn message.
        mode = 'turn-eof';
        await expect(drain(await session.startTurn(textTurn('t-mid-eof')))).rejects.toThrow(
          /The Agent SDK query ended during the turn/,
        );
        await Bun.sleep(20);
        expect(exits[3]).toEqual({
          message: 'The Agent SDK query ended during the turn',
          duringTurn: true,
          nativeThreadId: session.nativeThreadId,
          closedBeforeCallback: true,
          pidClearedBeforeCallback: true,
        });

        // 5. Intentional session.close() does NOT fire onQueryExit.
        mode = 'wait';
        await drain(await session.startTurn(textTurn('t-ok')));
      } finally {
        await session.close();
      }
      await Bun.sleep(20);
      expect(exits).toHaveLength(4);
      expect(attempt).toBe(5);

      // 6. Caller signal abort and failed open() do NOT fire onQueryExit.
      const callerAbort = new AbortController();
      mode = 'wait';
      const sAbort = await driver.open({
        profile: sdkProfile(root),
        cwd: root,
        signal: callerAbort.signal,
      });
      try {
        await sAbort.supportedModels();
        callerAbort.abort(new Error('caller cancelled'));
        await Bun.sleep(20);
      } finally {
        await sAbort.close();
      }
      expect(exits).toHaveLength(4);

      const failOpenExits: unknown[] = [];
      const failOpenDriver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        verifyDelegation: { requireHooksApplied: true },
        onQueryExit: (err) => failOpenExits.push(err),
        query: () => {
          const records: AsyncIterator<unknown> = {
            next: async () => {
              throw new Error('died during open');
            },
            return: async () => ({ value: undefined, done: true }),
          };
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            initializationResult: async () => ({
              commands: [],
              agents: [],
              output_style: 'default',
              available_output_styles: ['default'],
              models: [],
              account: {},
              hooks_applied: false,
            }),
          };
        },
      });
      await expect(
        failOpenDriver.open({ profile: sdkProfile(root), cwd: root }),
      ).rejects.toThrow(/hooks_applied/);
      await Bun.sleep(20);
      expect(failOpenExits).toEqual([]);
    }));

  test('approve with updatedInput answers AskUserQuestion, rejects non-object updatedInput, and onPermissionRequest exposes ExitPlanMode and safety metadata without hardcoded refusal copy', () =>
    inScratch('sdk-updated-input-and-permission-meta', async (root) => {
      const permissions: unknown[] = [];
      const metas: ClaudeSdkPermissionRequestMeta[] = [];
      const questions = [{ question: 'Pick DB', options: ['Postgres', 'SQLite'] }];
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        onPermissionRequest: (meta) => {
          metas.push(meta);
          if (meta.toolName === 'Bash') {
            throw new Error('observer throw must not break permission flow');
          }
        },
        query: ({ prompt, options }) => {
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              permissions.push(
                await options?.canUseTool?.(
                  'AskUserQuestion',
                  { questions },
                  {
                    signal: new AbortController().signal,
                    toolUseID: 'tu-ask-1',
                    requestId: 'req-ask-1',
                    title: 'Answer user question',
                    description: 'Select target database',
                    decisionReason: 'User input required',
                    agentID: 'sub-agent-1',
                  },
                ),
              );
              permissions.push(
                await options?.canUseTool?.(
                  'ExitPlanMode',
                  { plan: '1. Edit\n2. Test' },
                  {
                    signal: new AbortController().signal,
                    toolUseID: 'tu-plan-1',
                    requestId: 'req-plan-1',
                    title: 'Approve execution plan',
                    displayName: 'Exit plan',
                    description: 'Review proposed steps',
                    blockedPath: '/etc/hosts',
                    decisionReason: 'Plan approval required',
                    defaultToNo: true,
                    suppressAlwaysAllowRule: true,
                    suggestions: [
                      {
                        type: 'setMode',
                        mode: 'acceptEdits',
                        destination: 'session',
                      },
                    ],
                    mcpServer: { name: 'docs', source: 'user' },
                    matchedAskRule: {
                      source: 'projectSettings',
                      toolName: 'ExitPlanMode',
                    },
                  },
                ),
              );
              permissions.push(
                await options?.canUseTool?.(
                  'Bash',
                  { command: 'rm -rf tmp' },
                  {
                    signal: new AbortController().signal,
                    toolUseID: 'tu-bash-1',
                    requestId: 'req-bash-1',
                    blockedPath: '/tmp/protected',
                    decisionReason: 'Destructive command',
                  },
                ),
              );
              yield success(message.uuid);
            }
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      expect(driver.capabilities.updatedToolInput).toBe(true);
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const turn = await session.startTurn(textTurn('t-ask-plan'));
        const deltas: ExecutorDelta[] = [];
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          deltas.push(delta);
          if (delta.type !== 'request') continue;
          if (delta.toolName === 'AskUserQuestion') {
            // Non-object updatedInput is refused by schema while keeping pending intact.
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'approve',
                updatedInput: 'bad' as never,
              }),
            ).rejects.toThrow();
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'approve',
                updatedInput: ['bad'] as never,
              }),
            ).rejects.toThrow();
            await turn.respond(delta.interactionId, {
              kind: 'approve',
              updatedInput: { questions, answers: { 'Pick DB': 'Postgres' } },
            });
          } else if (delta.toolName === 'ExitPlanMode') {
            expect(delta.input).toEqual({ plan: '1. Edit\n2. Test' });
            await turn.respond(delta.interactionId, {
              kind: 'deny',
              message: 'Host custom plan revision request',
              interrupt: false,
            });
          } else if (delta.toolName === 'Bash') {
            await turn.respond(delta.interactionId, {
              kind: 'deny',
              message: 'Host custom safety block',
              interrupt: true,
            });
          }
        }
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(metas).toHaveLength(3);
        expect(metas[0]).toMatchObject({
          turnId: 't-ask-plan',
          toolName: 'AskUserQuestion',
          toolUseID: 'tu-ask-1',
          requestId: 'req-ask-1',
          title: 'Answer user question',
          description: 'Select target database',
          decisionReason: 'User input required',
          agentID: 'sub-agent-1',
          input: { questions },
        });
        expect(metas[1]).toMatchObject({
          toolName: 'ExitPlanMode',
          toolUseID: 'tu-plan-1',
          title: 'Approve execution plan',
          displayName: 'Exit plan',
          description: 'Review proposed steps',
          blockedPath: '/etc/hosts',
          decisionReason: 'Plan approval required',
          defaultToNo: true,
          suppressAlwaysAllowRule: true,
          suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
          mcpServer: { name: 'docs', source: 'user' },
          matchedAskRule: { source: 'projectSettings', toolName: 'ExitPlanMode' },
        });
        expect(permissions).toEqual([
          {
            behavior: 'allow',
            updatedInput: { questions, answers: { 'Pick DB': 'Postgres' } },
          },
          { behavior: 'deny', message: 'Host custom plan revision request' },
          { behavior: 'deny', message: 'Host custom safety block', interrupt: true },
        ]);
      } finally {
        await session.close();
      }
    }));

  test('forwards onElicitation to query and exposes setMcpServers, stopTask, and backgroundTasks with fail-closed validation', () =>
    inScratch('sdk-elicitation-mcp-tasks', async (root) => {
      const seenOptions: Array<Options | undefined> = [];
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const onElicitation: NonNullable<Options['onElicitation']> = async (request) => ({
        action: 'accept',
        content: { server: request.serverName },
      });
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        mcpServersDelivery: 'initialize',
        onElicitation,
        query: ({ prompt, options }) => {
          seenOptions.push(options);
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) yield success(message.uuid);
          }
          const records = run();
          return {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            setMcpServers: async (servers) => {
              calls.push({ method: 'setMcpServers', args: [servers] });
              return { added: Object.keys(servers), removed: [], errors: {} };
            },
            stopTask: async (taskId) => {
              calls.push({ method: 'stopTask', args: [taskId] });
            },
            backgroundTasks: async (toolUseId) => {
              calls.push({ method: 'backgroundTasks', args: [toolUseId] });
              return toolUseId === undefined;
            },
          };
        },
      });
      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        // Invalid arguments fail closed with TypeError before invoking query methods.
        await expect(session.stopTask('')).rejects.toThrow(TypeError);
        await expect(session.stopTask('   ')).rejects.toThrow(TypeError);
        await expect(session.backgroundTasks('   ')).rejects.toThrow(TypeError);
        expect(calls).toEqual([]);

        const mcpRes = await session.setMcpServers({
          docs: { type: 'http', url: 'https://example.invalid/mcp' },
        });
        expect(mcpRes).toEqual({ added: ['docs'], removed: [], errors: {} });
        await session.stopTask('task-42');
        expect(await session.backgroundTasks()).toBe(true);
        expect(await session.backgroundTasks('tu-bg-1')).toBe(false);

        expect(seenOptions[0]?.mcpServersDelivery).toBe('initialize');
        expect(seenOptions[0]?.onElicitation).toBe(onElicitation);
        const elicitationReply = await seenOptions[0]?.onElicitation?.(
          { serverName: 'oauth-srv', message: 'Sign in' },
          { signal: new AbortController().signal, requestId: 'el-req-1' },
        );
        expect(elicitationReply).toEqual({
          action: 'accept',
          content: { server: 'oauth-srv' },
        });
        expect(calls).toEqual([
          {
            method: 'setMcpServers',
            args: [{ docs: { type: 'http', url: 'https://example.invalid/mcp' } }],
          },
          { method: 'stopTask', args: ['task-42'] },
          { method: 'backgroundTasks', args: [undefined] },
          { method: 'backgroundTasks', args: ['tu-bg-1'] },
        ]);
      } finally {
        await session.close();
      }
      await expect(session.setMcpServers({})).rejects.toThrow(/closed/);
      await expect(session.stopTask('task-42')).rejects.toThrow(/closed/);
      await expect(session.backgroundTasks()).rejects.toThrow(/closed/);

      // Minimal query lacking these methods fails closed.
      const minimalSession = await sdkDriver(root, () => {
        async function* run(): AsyncGenerator<unknown> {
          await new Promise<never>(() => undefined);
        }
        const records = run();
        return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
      }).open({ profile: sdkProfile(root), cwd: root });
      try {
        await expect(minimalSession.setMcpServers({})).rejects.toThrow(/setMcpServers/);
        await expect(minimalSession.stopTask('t1')).rejects.toThrow(/stopTask/);
        await expect(minimalSession.backgroundTasks()).rejects.toThrow(/backgroundTasks/);
      } finally {
        await minimalSession.close();
      }

      // Hung stopTask/setMcpServers/backgroundTasks abort cleanly on session.close().
      const hungSession = await sdkDriver(root, () => {
        async function* run(): AsyncGenerator<unknown> {
          await new Promise<never>(() => undefined);
        }
        const records = run();
        return {
          [Symbol.asyncIterator]: () => records,
          interrupt: async () => undefined,
          stopTask: () => new Promise<void>(() => undefined),
        };
      }).open({ profile: sdkProfile(root), cwd: root });
      const hungStop = hungSession.stopTask('task-hung');
      await Bun.sleep(5);
      await hungSession.close();
      await expect(hungStop).rejects.toThrow();
    }));

  test('onEvent receives task lifecycle, background_tasks_changed, tool_progress, api_retry and elicitation_complete during and after turns, while compact_boundary emits window reset', () =>
    inScratch('sdk-events-and-compaction', async (root) => {
      const events: ClaudeRuntimeEvent[] = [];
      let emitPostTurn!: () => void;
      const postTurnDone = Promise.withResolvers<void>();
      const noEventDriver = sdkDriver(root, () => {
        throw new Error('unused');
      });
      expect(noEventDriver.capabilities.backgroundWorkOutlivesTurn).toBe(false);

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        onEvent: (event) => {
          ClaudeRuntimeEventSchema.parse(event);
          events.push(event);
          if (event.type === 'api_retry') {
            throw new Error('observer sync error must not break query loop');
          }
          if (event.type === 'background_tasks_changed' && event.tasks.length === 0) {
            postTurnDone.resolve();
          }
        },
        query: ({ prompt }) => {
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              yield {
                type: 'stream_event',
                api_message_id: 'm1',
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'stale-sdk' },
                },
              };
              yield {
                type: 'system',
                subtype: 'compact_boundary',
                uuid: 'cmp-sdk-1',
                session_id: 's1',
                compact_metadata: {
                  trigger: 'manual',
                  pre_tokens: 150_000,
                  post_tokens: 10_000,
                },
              };
              yield {
                type: 'stream_event',
                api_message_id: 'm2',
                event: {
                  type: 'content_block_delta',
                  index: 0,
                  delta: { type: 'text_delta', text: 'fresh-sdk' },
                },
              };
              yield {
                type: 'system',
                subtype: 'task_started',
                task_id: 'task-99',
                run_id: 'run-1',
                tool_use_id: 'tu-sub-1',
                description: 'Research agent',
                subagent_type: 'Explore',
                is_backgrounded: true,
                spawn_depth: 1,
                task_type: 'local_agent',
                uuid: 'ev-1',
                session_id: 's1',
              };
              yield {
                type: 'system',
                subtype: 'task_updated',
                task_id: 'task-99',
                run_id: 'run-1',
                patch: { status: 'running', is_backgrounded: true },
              };
              yield {
                type: 'system',
                subtype: 'task_progress',
                task_id: 'task-99',
                description: 'Scanning files',
                usage: { total_tokens: 900, tool_uses: 3, duration_ms: 450 },
                last_tool_name: 'Grep',
                summary: 'Found 4 matches',
              };
              yield {
                type: 'tool_progress',
                tool_use_id: 'tu-sub-1',
                tool_name: 'Agent',
                parent_tool_use_id: null,
                elapsed_time_seconds: 2.25,
                task_id: 'task-99',
                heartbeat: true,
                subagent_type: 'Explore',
                subagent_retry: {
                  agent_id: 'task-99',
                  attempt: 1,
                  max_retries: 2,
                  retry_delay_ms: 500,
                  error_status: 529,
                  error_category: 'overloaded',
                },
              };
              yield {
                type: 'system',
                subtype: 'api_retry',
                attempt: 1,
                max_retries: 3,
                retry_delay_ms: 1500,
                error_status: null,
                error: 'overloaded',
                no_response: { waited_ms: 5000, retry_wait_ms: 10000 },
              };
              yield {
                type: 'system',
                subtype: 'elicitation_complete',
                mcp_server_name: 'github',
                elicitation_id: 'el-42',
              };
              yield {
                type: 'system',
                subtype: 'background_tasks_changed',
                tasks: [
                  {
                    task_id: 'task-99',
                    run_id: 'run-1',
                    task_type: 'local_agent',
                    subagent_type: 'Explore',
                    description: 'Research agent',
                  },
                ],
              };
              // Negative control: malformed tool_progress surfaces as unhandled.
              yield { type: 'tool_progress', tool_use_id: '' };
              yield success(message.uuid);
              // Post-turn background completion after turn-end (between turns!).
              await new Promise<void>((resolve) => {
                emitPostTurn = resolve;
              });
              yield {
                type: 'system',
                subtype: 'task_notification',
                task_id: 'task-99',
                run_id: 'run-1',
                status: 'completed',
                output_file: '/tmp/task-99.out',
                summary: 'Research finished',
                usage: { total_tokens: 1500, tool_uses: 5, duration_ms: 1200 },
              };
              yield {
                type: 'system',
                subtype: 'background_tasks_changed',
                tasks: [],
              };
              await new Promise<never>(() => undefined);
            }
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      expect(driver.capabilities.backgroundWorkOutlivesTurn).toBe(true);
      expect(() => z.toJSONSchema(ClaudeRuntimeEventSchema)).not.toThrow();

      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const deltas = await drain(await session.startTurn(textTurn('t-events')));
        for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
        expect(deltas).toContainEqual({
          type: 'window',
          turnId: 't-events',
          itemId: 'compact:cmp-sdk-1',
          raw: { source: 'claude', type: 'system/compact_boundary' },
          reset: 'context',
        });
        expect(projectExecutorDeltas(deltas)).toEqual([{ type: 'text', text: 'fresh-sdk' }]);
        const unhandled = deltas.filter((d) => d.type === 'error' && d.kind === 'unhandled');
        expect(unhandled).toHaveLength(1);
        expect(unhandled[0]?.raw).toEqual({ source: 'claude', type: 'tool_progress' });

        // Trigger post-turn background notifications after Turn 1 already finished.
        emitPostTurn();
        await postTurnDone.promise;
        expect(events.map((e) => e.type)).toEqual([
          'task_started',
          'task_updated',
          'task_progress',
          'tool_progress',
          'api_retry',
          'elicitation_complete',
          'background_tasks_changed',
          'task_notification',
          'background_tasks_changed',
        ]);
        const notif = events.find((e) => e.type === 'task_notification');
        expect(notif).toMatchObject({
          taskId: 'task-99',
          status: 'completed',
          outputFile: '/tmp/task-99.out',
          summary: 'Research finished',
          usage: { totalTokens: 1500, toolUses: 5, durationMs: 1200 },
        });
      } finally {
        await session.close();
      }
    }));

  test('onTurnUsage computes additive per-turn modelUsage deltas and otherUsage, resets baseline on query restart, and emits undefined on backwards counters or missing baseline', () =>
    inScratch('sdk-turn-usage-delta', async (root) => {
      const summaries: ClaudeSdkTurnUsage[] = [];
      let queryNumber = 0;
      let turnIndex = 0;

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        onTurnUsage: (usage) => {
          ClaudeSdkTurnUsageSchema.parse(usage);
          summaries.push(usage);
        },
        query: ({ prompt }) => {
          queryNumber += 1;
          const q = queryNumber;
          async function* run(): AsyncGenerator<unknown> {
            yield {
              type: 'system',
              subtype: 'init',
              session_id: 's-usage',
              model: 'claude-sonnet-4-6',
            };
            for await (const message of prompt) {
              turnIndex += 1;
              if (turnIndex === 1) {
                yield {
                  type: 'assistant',
                  parent_tool_use_id: null,
                  message: { id: 'a1', model: 'claude-sonnet-4-6', content: [] },
                };
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  uuid: message.uuid,
                  usage: {
                    input_tokens: 100,
                    output_tokens: 40,
                    cache_read_input_tokens: 50,
                    cache_creation_input_tokens: 20,
                  },
                  modelUsage: {
                    'claude-sonnet-4-6': {
                      inputTokens: 100,
                      outputTokens: 40,
                      cacheReadInputTokens: 50,
                      cacheCreationInputTokens: 20,
                      costUSD: 0.05,
                    },
                    'claude-haiku-4-5': {
                      inputTokens: 30,
                      outputTokens: 10,
                      cacheReadInputTokens: 0,
                      cacheCreationInputTokens: 0,
                      costUSD: 0.002,
                    },
                  },
                };
              } else if (turnIndex === 2) {
                // Cumulative growth on Query 1.
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  uuid: message.uuid,
                  usage: {
                    input_tokens: 150,
                    output_tokens: 50,
                    cache_read_input_tokens: 100,
                    cache_creation_input_tokens: 0,
                  },
                  modelUsage: {
                    'claude-sonnet-4-6': {
                      inputTokens: 250,
                      outputTokens: 90,
                      cacheReadInputTokens: 150,
                      cacheCreationInputTokens: 20,
                      costUSD: 0.12,
                    },
                    'claude-haiku-4-5': {
                      inputTokens: 80,
                      outputTokens: 25,
                      cacheReadInputTokens: 10,
                      cacheCreationInputTokens: 0,
                      costUSD: 0.005,
                    },
                  },
                };
              } else if (turnIndex === 3) {
                // Counter moves backwards -> delta and otherUsage must be undefined and baseline invalidated.
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  uuid: message.uuid,
                  usage: { input_tokens: 10, output_tokens: 5 },
                  modelUsage: {
                    'claude-sonnet-4-6': {
                      inputTokens: 200,
                      outputTokens: 90,
                      cacheReadInputTokens: 150,
                      cacheCreationInputTokens: 20,
                    },
                    'claude-haiku-4-5': {
                      inputTokens: 80,
                      outputTokens: 25,
                      cacheReadInputTokens: 10,
                      cacheCreationInputTokens: 0,
                    },
                  },
                };
              } else if (turnIndex === 4) {
                // Missing baseline after turn 3 invalidation -> delta undefined while re-anchoring baseline.
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  uuid: message.uuid,
                  usage: { input_tokens: 100, output_tokens: 20 },
                  modelUsage: {
                    'claude-sonnet-4-6': { inputTokens: 300, outputTokens: 110 },
                  },
                };
              } else if (turnIndex === 5) {
                // Re-anchored baseline: delta works, but newly appearing optional counter has no baseline (undefined).
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  uuid: message.uuid,
                  usage: { input_tokens: 50, output_tokens: 20 },
                  modelUsage: {
                    'claude-sonnet-4-6': {
                      inputTokens: 350,
                      outputTokens: 130,
                      thinkingTokens: 12,
                    },
                  },
                };
              } else if (turnIndex === 6 && q === 1) {
                throw new Error('query 1 died before turn 6 result');
              } else {
                // Query 2 fresh process: counters restart near zero -> baseline must reset, NOT treat as backwards!
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  uuid: message.uuid,
                  usage: { input_tokens: 40, output_tokens: 15 },
                  modelUsage: {
                    'claude-sonnet-4-6': { inputTokens: 40, outputTokens: 15 },
                  },
                };
              }
            }
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      expect(() => z.toJSONSchema(ClaudeSdkTurnUsageSchema)).not.toThrow();

      const session = await driver.open({ profile: sdkProfile(root), cwd: root });
      try {
        const d1 = await drain(await session.startTurn(textTurn('t1')));
        const d2 = await drain(await session.startTurn(textTurn('t2')));
        await drain(await session.startTurn(textTurn('t3')));
        await drain(await session.startTurn(textTurn('t4')));
        await drain(await session.startTurn(textTurn('t5')));
        await expect(drain(await session.startTurn(textTurn('t6-crash')))).rejects.toThrow(
          /query 1 died/,
        );
        await drain(await session.startTurn(textTurn('t7-after-restart')));

        // Cumulative ExecutorUsageDelta.modelUsage stays intact for backward compatibility.
        const u1 = d1.find((d) => d.type === 'usage');
        const u2 = d2.find((d) => d.type === 'usage');
        expect(
          u1?.type === 'usage' ? u1.modelUsage?.['claude-sonnet-4-6']?.inputTokens : -1,
        ).toBe(100);
        expect(
          u2?.type === 'usage' ? u2.modelUsage?.['claude-sonnet-4-6']?.inputTokens : -1,
        ).toBe(250);

        expect(summaries).toHaveLength(6);
        expect(summaries[0]).toMatchObject({
          turnId: 't1',
          primaryModel: 'claude-sonnet-4-6',
          modelUsageDelta: {
            'claude-sonnet-4-6': {
              inputTokens: 100,
              outputTokens: 40,
              cacheReadInputTokens: 50,
              cacheCreationInputTokens: 20,
            },
            'claude-haiku-4-5': { inputTokens: 30, outputTokens: 10 },
          },
          otherUsage: { inputTokens: 30, outputTokens: 10 },
        });
        expect(summaries[1]).toMatchObject({
          turnId: 't2',
          modelUsageDelta: {
            'claude-sonnet-4-6': {
              inputTokens: 150,
              outputTokens: 50,
              cacheReadInputTokens: 100,
              cacheCreationInputTokens: 0,
            },
            'claude-haiku-4-5': {
              inputTokens: 50,
              outputTokens: 15,
              cacheReadInputTokens: 10,
              cacheCreationInputTokens: 0,
            },
          },
          otherUsage: { inputTokens: 60, outputTokens: 15 },
        });
        expect(summaries[1]?.modelUsageDelta?.['claude-sonnet-4-6']?.costUsd).toBeCloseTo(
          0.07,
        );
        // Turn 3 backwards -> undefined delta & otherUsage.
        expect(summaries[2]?.modelUsageDelta).toBeUndefined();
        expect(summaries[2]?.otherUsage).toBeUndefined();
        expect(summaries[2]?.cumulativeModelUsage?.['claude-sonnet-4-6']?.inputTokens).toBe(
          200,
        );
        // Turn 4 invalidated baseline -> undefined delta & otherUsage, re-anchors at 300/110.
        expect(summaries[3]?.modelUsageDelta).toBeUndefined();
        expect(summaries[3]?.otherUsage).toBeUndefined();
        // Turn 5 re-anchored: known counters diff cleanly, fresh thinkingTokens without baseline stays undefined.
        expect(summaries[4]?.modelUsageDelta?.['claude-sonnet-4-6']).toEqual({
          inputTokens: 50,
          outputTokens: 20,
        });
        expect(summaries[4]?.otherUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
        // Turn 7 on restarted Query 2: fresh baseline -> 40/15 accepted cleanly.
        expect(queryNumber).toBe(2);
        expect(summaries[5]).toMatchObject({
          turnId: 't7-after-restart',
          modelUsageDelta: {
            'claude-sonnet-4-6': { inputTokens: 40, outputTokens: 15 },
          },
          otherUsage: { inputTokens: 0, outputTokens: 0 },
        });
      } finally {
        await session.close();
      }
    }));

  test('probeCapabilities runs isolated never-yielding probe for models, commands, account, and optional usage, closing query in finally on success, timeout, abort and error', () =>
    inScratch('sdk-probe-capabilities', async (root) => {
      const seenOptions: Array<Options | undefined> = [];
      const usageOpts: unknown[] = [];
      let closeCalls = 0;
      let yieldedAnyPrompt = false;
      let promptCompletedOnAbort = false;
      let mode: 'full' | 'init-only' | 'no-usage-rpc' | 'fail' | 'hang' | 'missing-rpcs' =
        'full';

      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        pathToClaudeCodeExecutable: '/usr/local/bin/claude-probe',
        settingSources: ['user', 'project'],
        query: ({ prompt, options }) => {
          seenOptions.push(options);
          const iterator = prompt[Symbol.asyncIterator]();
          void iterator.next().then((step) => {
            if (step.done) promptCompletedOnAbort = true;
            else yieldedAnyPrompt = true;
          });
          async function* run(): AsyncGenerator<unknown> {
            await new Promise<never>(() => undefined);
          }
          const records = run();
          const base: ClaudeSdkRun = {
            [Symbol.asyncIterator]: () => records,
            interrupt: async () => undefined,
            close: () => {
              closeCalls += 1;
            },
          };
          if (mode === 'missing-rpcs') return base;
          if (mode === 'hang') {
            return {
              ...base,
              initializationResult: () =>
                new Promise<SDKControlInitializeResponse>(() => undefined),
            };
          }
          if (mode === 'fail') {
            return {
              ...base,
              initializationResult: async () => {
                throw new Error('probe init failed');
              },
            };
          }
          const initResponse: SDKControlInitializeResponse = {
            commands: [{ name: 'compact', description: 'Compact', argumentHint: '' }],
            agents: [],
            output_style: 'default',
            available_output_styles: ['default'],
            models: [
              { value: 'claude-sonnet-4-6', displayName: 'Sonnet', description: 'Fast' },
            ],
            account: { email: 'probe@example.invalid', subscriptionType: 'max' },
          };
          if (mode === 'init-only') {
            return { ...base, initializationResult: async () => initResponse };
          }
          const withMeta: ClaudeSdkRun = {
            ...base,
            initializationResult: async () => initResponse,
            supportedModels: async () => initResponse.models,
            supportedCommands: async () => initResponse.commands,
            accountInfo: async () => initResponse.account,
          };
          if (mode === 'no-usage-rpc') return withMeta;
          return {
            ...withMeta,
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (opts) => {
              usageOpts.push(opts);
              return {
                session: {
                  total_cost_usd: 0,
                  total_api_duration_ms: 0,
                  total_duration_ms: 0,
                  total_lines_added: 0,
                  total_lines_removed: 0,
                  model_usage: {},
                },
                subscription_type: 'max',
                rate_limits_available: true,
                rate_limits: {
                  five_hour: { utilization: 25, resets_at: '2026-11-30T10:00:00Z' },
                },
                behaviors: null,
              };
            },
          };
        },
      });

      const profile = sdkProfile(root);
      // 1. Default probe without includeUsage: isolated options, never-yielding prompt, closed in finally.
      const res1 = await driver.probeCapabilities({ profile, cwd: root });
      await Bun.sleep(5);
      expect(yieldedAnyPrompt).toBe(false);
      expect(promptCompletedOnAbort).toBe(true);
      expect(closeCalls).toBe(1);
      expect(usageOpts).toEqual([]);
      expect(res1.usage).toBeUndefined();
      expect(res1.models).toHaveLength(1);
      expect(res1.commands).toHaveLength(1);
      expect(res1.account?.email).toBe('probe@example.invalid');
      expect(seenOptions[0]).toMatchObject({
        cwd: root,
        persistSession: false,
        settings: { disableAllHooks: true },
        strictMcpConfig: true,
        mcpServers: {},
        allowedTools: [],
        pathToClaudeCodeExecutable: '/usr/local/bin/claude-probe',
        settingSources: ['user', 'project'],
      });
      const deniedTool = await seenOptions[0]?.canUseTool?.(
        'Bash',
        { command: 'id' },
        { signal: new AbortController().signal, toolUseID: 'u', requestId: 'r' },
      );
      expect(deniedTool).toMatchObject({ behavior: 'deny', interrupt: true });

      // 2. With includeUsage: passes { skipBehaviors: true } and caches plan limits.
      const res2 = await driver.probeCapabilities({ profile, cwd: root, includeUsage: true });
      expect(usageOpts).toEqual([{ skipBehaviors: true }]);
      expect(res2.usage?.supported).toBe(true);
      expect(res2.usage?.planLimits.windows).toMatchObject([
        { name: 'five_hour', usedPercent: 25 },
      ]);
      expect((await driver.status(profile)).planLimits?.windows).toHaveLength(1);
      expect(closeCalls).toBe(2);

      // 3. Init-only and missing usage RPC degrade cleanly without throwing.
      mode = 'init-only';
      const res3 = await driver.probeCapabilities({ profile, cwd: root, includeUsage: true });
      expect(res3.models).toHaveLength(1);
      expect(res3.usage?.supported).toBe(false);
      expect(res3.usage?.planLimits.answer).toBe('unpublished');
      expect(closeCalls).toBe(3);

      // 4. Error, timeoutMs, caller abort, and missing RPCs all close in finally and leave 0 listeners.
      mode = 'fail';
      await expect(driver.probeCapabilities({ profile, cwd: root })).rejects.toThrow(
        /probe init failed/,
      );
      expect(closeCalls).toBe(4);

      mode = 'hang';
      await expect(
        driver.probeCapabilities({ profile, cwd: root, timeoutMs: 25 }),
      ).rejects.toThrow(/timed out/);
      expect(closeCalls).toBe(5);

      const caller = countedSignal();
      const pendingProbe = driver.probeCapabilities({
        profile,
        cwd: root,
        signal: caller.signal,
      });
      await Bun.sleep(5);
      caller.abort(new Error('probe-cancelled'));
      await expect(pendingProbe).rejects.toThrow(/probe-cancelled/);
      expect(closeCalls).toBe(6);
      expect(caller.listeners()).toBe(0);

      mode = 'missing-rpcs';
      await expect(driver.probeCapabilities({ profile, cwd: root })).rejects.toThrow(
        /capability probe RPCs/,
      );
      expect(closeCalls).toBe(7);

      // Invalid timeoutMs or pre-aborted signal refuses BEFORE invoking query.
      const preAborted = new AbortController();
      preAborted.abort(new Error('already-aborted'));
      await expect(
        driver.probeCapabilities({ profile, cwd: root, timeoutMs: 0 }),
      ).rejects.toThrow();
      await expect(
        driver.probeCapabilities({ profile, cwd: root, signal: preAborted.signal }),
      ).rejects.toThrow(/already-aborted/);
      expect(closeCalls).toBe(7);
    }));

  test('open forwards resumeSessionAt and resumeDropsTurn on initial query, clears them on restart, and refuses invalid combinations fail-closed', () =>
    inScratch('sdk-resume-session-at', async (root) => {
      const openedOptions: Array<Options | undefined> = [];
      let attempt = 0;
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: ambientIn(root),
        query: ({ prompt, options }) => {
          attempt += 1;
          const runNum = attempt;
          openedOptions.push(options);
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              if (runNum === 1) throw new Error('crash after truncated start');
              yield success(message.uuid);
            }
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      const profile = sdkProfile(root);
      // Fail-closed TypeErrors before starting any query.
      await expect(
        driver.open({ profile, cwd: root, resumeSessionAt: 'msg-1' }),
      ).rejects.toThrow(TypeError);
      await expect(
        driver.open({ profile, cwd: root, nativeThreadId: 'sess-1', resumeSessionAt: '   ' }),
      ).rejects.toThrow(TypeError);
      await expect(
        driver.open({ profile, cwd: root, resumeDropsTurn: 'turn-prompt-2' }),
      ).rejects.toThrow(TypeError);
      await expect(
        driver.open({
          profile,
          cwd: root,
          nativeThreadId: 'sess-1',
          resumeDropsTurn: 'turn-prompt-2',
        }),
      ).rejects.toThrow(TypeError);
      await expect(
        driver.open({
          profile,
          cwd: root,
          nativeThreadId: 'sess-1',
          resumeSessionAt: 'msg-1',
          resumeDropsTurn: '',
        }),
      ).rejects.toThrow(TypeError);
      expect(openedOptions).toEqual([]);

      // Valid truncating resume forwards both options on the first query, then clears on restart.
      const session = await driver.open({
        profile,
        cwd: root,
        nativeThreadId: 'sess-truncate-1',
        resumeSessionAt: 'msg-keep-42',
        resumeDropsTurn: 'prompt-drop-43',
      });
      try {
        await expect(drain(await session.startTurn(textTurn('t1-trunc')))).rejects.toThrow(
          /crash after truncated start/,
        );
        const deltas2 = await drain(await session.startTurn(textTurn('t2-plain-resume')));
        expect(deltas2.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        expect(openedOptions).toHaveLength(2);
        expect(openedOptions[0]).toMatchObject({
          resume: 'sess-truncate-1',
          resumeSessionAt: 'msg-keep-42',
          resumeDropsTurn: 'prompt-drop-43',
        });
        expect(openedOptions[1]?.resume).toBe('sess-truncate-1');
        expect(openedOptions[1]?.resumeSessionAt).toBeUndefined();
        expect(openedOptions[1]?.resumeDropsTurn).toBeUndefined();
      } finally {
        await session.close();
      }
    }));
});
