/**
 * Codex driver regressions: a resumed thread keeps its policy, items classify by kind,
 * requests the interrupt answers or races, an honest `raw.type`, and empty ids.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import {
  CODEX_CONTENT_ITEMS,
  CODEX_TOOL_ITEMS,
  classifyCodexNotification,
} from '../../src/agent-executor/codex/classify';
import {
  type CodexDriverConfig,
  createCodexDriver,
} from '../../src/agent-executor/codex/driver';
import { createCodexHandlers } from '../../src/agent-executor/codex/handlers';
import { codexPlanWindows } from '../../src/agent-executor/codex/limits';
import {
  answerCodexSessionRequest,
  buildCodexRequestAnswer,
  type CodexTurnSlot,
  type PendingExternalCodexRequest,
} from '../../src/agent-executor/codex/request-answers';
import { CodexSkillInputSchema } from '../../src/agent-executor/codex/turn-input';
import {
  CodexUnixSocketError,
  connectCodexUnixSocket,
} from '../../src/agent-executor/codex/unix-socket';
import { createWsFrameDecoder } from '../../src/agent-executor/codex/ws-frame';
import {
  JSON_RPC_METHOD_NOT_FOUND,
  JsonRpcError,
} from '../../src/agent-executor/json-rpc-peer';
import { createTurnDeltaChannel } from '../../src/agent-executor/session-primitives';
import type { FakeEngineStep } from '../../src/agent-executor/testing/fake-engine';
import { type ExecutorDelta, ExecutorDeltaSchema } from '../../src/agent-executor/vocabulary';
import {
  ambientIn,
  drain,
  drainApproving,
  FAKE_CODEX,
  inScratch,
  readJsonLines,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest, trackProcess } from '../support/process-reaper';

reapAfterEachTest();

type CodexDriverOptions = Omit<CodexDriverConfig, 'executable' | 'prefixArgs' | 'ambient'>;

function codexDriver(root: string, options: CodexDriverOptions = {}) {
  return createCodexDriver({
    executable: process.execPath,
    prefixArgs: [FAKE_CODEX],
    ambient: ambientIn(root),
    ...options,
  });
}

async function codexSession(
  root: string,
  label: string,
  steps: FakeEngineStep[],
  open: { options?: CodexDriverOptions; nativeThreadId?: string } = {},
) {
  const home = join(root, `home-${label}`);
  const session = await codexDriver(root, open.options).open({
    profile: {
      profileId: label,
      engine: 'codex',
      home,
      env: {
        FAKE_ENGINE_SCENARIO: await writeScenario(root, steps),
        FAKE_ENGINE_PID_FILE: trackedPidFile(root, label),
      },
    },
    cwd: root,
    ...(open.nativeThreadId !== undefined && { nativeThreadId: open.nativeThreadId }),
  });
  return { session, home };
}

const turnCompleted = (status: 'completed' | 'interrupted'): FakeEngineStep => ({
  do: 'emit',
  record: {
    method: 'turn/completed',
    params: { threadId: 'fake-thread', turn: { id: 'fake-turn', status, items: [] } },
  },
});

describe('Codex driver: a resumed thread whose turn calls tools and fails rate-limited', () => {
  let resumed: unknown;
  let cwd = '';
  let deltas: ExecutorDelta[] = [];

  beforeAll(() =>
    inScratch('codex-resume', async (root) => {
      cwd = root;
      const { session, home } = await codexSession(
        root,
        'codex-resume',
        [
          {
            do: 'emit',
            record: {
              method: 'item/started',
              params: {
                threadId: 'resumed-1',
                turnId: 'fake-turn',
                item: { type: 'dynamicToolCall', id: 'dt-1', tool: 'lookup_docs' },
              },
            },
          },
          {
            do: 'emit',
            record: {
              method: 'item/completed',
              params: {
                threadId: 'resumed-1',
                turnId: 'fake-turn',
                item: {
                  type: 'webSearch',
                  id: 'ws-1',
                  query: 'stitchkit',
                  results: [{ title: 'ok' }],
                },
              },
            },
          },
          {
            do: 'emit',
            record: {
              method: 'turn/completed',
              params: {
                threadId: 'resumed-1',
                turn: {
                  id: 'fake-turn',
                  status: 'failed',
                  items: [],
                  error: {
                    message: 'too many requests',
                    codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } },
                  },
                },
              },
            },
          },
        ],
        {
          options: {
            approvalPolicy: 'on-request',
            sandbox: 'workspace-write',
            model: 'gpt-5-codex',
          },
          nativeThreadId: 'resumed-1',
        },
      );
      try {
        const [first] = (await readFile(join(home, 'thread-resume.jsonl'), 'utf8'))
          .trim()
          .split('\n');
        resumed = JSON.parse(first ?? '{}');
        deltas = await drain(
          await session.startTurn({
            turnId: 't1',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          }),
        );
      } finally {
        await session.close();
      }
    }),
  );

  test('thread/resume carries the cwd, approval policy, sandbox and model', () => {
    expect(resumed).toMatchObject({
      threadId: 'resumed-1',
      cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
      model: 'gpt-5-codex',
    });
  });

  test('a dynamicToolCall item is a tool call named by its tool', () => {
    expect(deltas).toContainEqual(
      expect.objectContaining({ type: 'tool-call', callId: 'dt-1', toolName: 'lookup_docs' }),
    );
  });

  test('a completed webSearch item is a successful tool result', () => {
    expect(deltas).toContainEqual(
      expect.objectContaining({ type: 'tool-result', callId: 'ws-1', outcome: 'success' }),
    );
  });

  test('an HTTP 429 turn failure is a rateLimited error', () => {
    expect(deltas).toContainEqual(
      expect.objectContaining({ type: 'error', kind: 'rateLimited' }),
    );
  });
});

describe('Codex driver: requests and the interrupt', () => {
  test('an interrupt while requestUserInput waits answers it with empty answers', () =>
    inScratch('codex-input-interrupt', async (root) => {
      const { session, home } = await codexSession(root, 'codex-input-interrupt', [
        {
          do: 'emit',
          record: {
            id: 'input-req-1',
            method: 'item/tool/requestUserInput',
            params: {
              itemId: 'call-input-1',
              questions: [{ id: 'q1', question: 'Pick one', header: 'Choice' }],
            },
          },
        },
        { do: 'expect', type: 'response' },
        { do: 'expect', type: 'turn/interrupt' },
        turnCompleted('interrupted'),
      ]);
      try {
        const turn = await session.startTurn({
          turnId: 't-input',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'go' }],
        });
        const deltas: ExecutorDelta[] = [];
        for await (const delta of turn.deltas) {
          deltas.push(delta);
          if (delta.type === 'request') await turn.interrupt();
        }
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'interrupted' });
        expect(await readJsonLines(join(home, 'responses.jsonl'))).toContainEqual({
          id: 'input-req-1',
          result: { answers: {} },
        });
      } finally {
        await session.close();
      }
    }));

  test('an approval answered by respond() is resolved under its own request type', () =>
    inScratch('codex-respond', async (root) => {
      const { session } = await codexSession(root, 'codex-respond', [
        {
          do: 'emit',
          record: {
            id: 'appr-1',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'call-a1', command: 'echo ok' },
          },
        },
        { do: 'expect', type: 'response' },
        turnCompleted('completed'),
      ]);
      try {
        const deltas = await drainApproving(
          await session.startTurn({
            turnId: 't-appr',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          }),
        );
        const resolved = deltas.find((delta) => delta.type === 'request-resolved');
        expect(resolved?.raw).toEqual({
          source: 'codex',
          type: 'item/commandExecution/requestApproval',
        });
      } finally {
        await session.close();
      }
    }));

  test('a request the engine closes itself (serverRequest/resolved) is closed on the stream and never answered', () =>
    inScratch('codex-engine-resolved', async (root) => {
      const { session, home } = await codexSession(root, 'codex-engine-resolved', [
        {
          do: 'emit',
          record: {
            id: 'appr-closed',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'call-closed', command: 'echo closed' },
          },
        },
        {
          do: 'emit',
          record: { method: 'serverRequest/resolved', params: { requestId: 'appr-closed' } },
        },
        { do: 'delay', ms: 50 },
        turnCompleted('completed'),
      ]);
      try {
        const turn = await session.startTurn({
          turnId: 't-closed',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'go' }],
        });
        const deltas = await drain(turn);
        expect(
          deltas.filter(
            (delta) => delta.type === 'request' || delta.type === 'request-resolved',
          ),
        ).toMatchObject([
          { type: 'request', interactionId: 'appr-closed' },
          {
            type: 'request-resolved',
            interactionId: 'appr-closed',
            raw: { source: 'codex', type: 'serverRequest/resolved' },
          },
        ]);
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        await expect(turn.respond('appr-closed', { kind: 'approve' })).rejects.toThrow();
        const answered = join(home, 'responses.jsonl');
        // The fake writes this file only once the executor answers something.
        const responses = existsSync(answered) ? await readJsonLines(answered) : [];
        expect(responses).not.toContainEqual(expect.objectContaining({ id: 'appr-closed' }));
      } finally {
        await session.close();
      }
    }));

  describe('requests the engine sends after turn/interrupt', () => {
    const deltas: ExecutorDelta[] = [];
    let responses: unknown[] = [];

    beforeAll(() =>
      inScratch('codex-interrupt-race', async (root) => {
        const { session, home } = await codexSession(root, 'codex-interrupt-race', [
          {
            do: 'emit',
            record: {
              method: 'item/agentMessage/delta',
              params: {
                threadId: 'fake-thread',
                turnId: 'fake-turn',
                itemId: 'm1',
                delta: 'hi',
              },
            },
          },
          { do: 'expect', type: 'turn/interrupt' },
          {
            do: 'emit',
            record: {
              id: 'race-appr',
              method: 'item/commandExecution/requestApproval',
              params: { itemId: 'c1', command: 'echo race' },
            },
          },
          { do: 'expect', type: 'response' },
          {
            do: 'emit',
            record: {
              id: 'race-input',
              method: 'item/tool/requestUserInput',
              params: {
                itemId: 'c2',
                questions: [{ id: 'q1', question: 'Choice?', header: 'Pick' }],
              },
            },
          },
          { do: 'expect', type: 'response' },
          turnCompleted('interrupted'),
        ]);
        try {
          const turn = await session.startTurn({
            turnId: 't-race',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          });
          let interrupted = false;
          const played = (async () => {
            for await (const delta of turn.deltas) {
              deltas.push(delta);
              if (!interrupted && delta.type === 'text') {
                interrupted = true;
                await turn.interrupt();
              }
            }
          })();
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              played,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new Error('Timed out waiting for interrupted Codex turn')),
                  2_000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          responses = await readJsonLines(join(home, 'responses.jsonl'));
        } finally {
          await session.close();
        }
      }),
    );

    test('are not offered to the consumer, and the turn ends interrupted', () => {
      expect(deltas.some((delta) => delta.type === 'request')).toBe(false);
      expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'interrupted' });
    });

    test('an approval is cancelled at once', () => {
      expect(responses).toContainEqual({ id: 'race-appr', result: { decision: 'cancel' } });
    });

    test('a user-input request is answered with empty answers at once', () => {
      expect(responses).toContainEqual({ id: 'race-input', result: { answers: {} } });
    });
  });
});

describe('Codex empty ids', () => {
  test('an empty tool name and an empty approval itemId still give deltas that pass ExecutorDeltaSchema', () =>
    inScratch('codex-empty-ids', async (root) => {
      const { session } = await codexSession(root, 'codex-empty-ids', [
        {
          do: 'emit',
          record: {
            method: 'item/started',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              item: { type: 'dynamicToolCall', id: 'dt-empty', tool: '' },
            },
          },
        },
        {
          do: 'emit',
          record: {
            id: 'appr-empty',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: '', command: 'echo 1' },
          },
        },
        { do: 'expect', type: 'response' },
        turnCompleted('completed'),
      ]);
      try {
        const deltas = await drainApproving(
          await session.startTurn({
            turnId: 't-codex',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'hi' }],
          }),
        );
        for (const delta of deltas) ExecutorDeltaSchema.parse(delta);
        expect(deltas.some((delta) => delta.type === 'tool-call')).toBe(true);
        expect(deltas.some((delta) => delta.type === 'request')).toBe(true);
      } finally {
        await session.close();
      }
    }));
});

describe('Codex plan windows', () => {
  test('a window whose resetsAt is out of the Date range keeps its usage', () => {
    expect(codexPlanWindows({ primary: { usedPercent: 25, resetsAt: 1e16 } })).toEqual([
      { name: 'limit:primary', usedPercent: 25 },
    ]);
  });

  test('codexPlanWindows unfolds full account/rateLimits/read envelopes, deduplicates rateLimitsByLimitId, preserves weekly vs 5h windows, and bounds name length and count', () => {
    const envelope = {
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1796032800 },
        secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1796637600 },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 1796032800 },
          secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1796637600 },
        },
        codex_spark: {
          limitId: 'codex_spark',
          limitName: 'GPT-5.3-Codex-Spark',
          // Weekly-only window delivered in `primary` must NOT collide with a 5h window.
          primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 1796637600 },
        },
        dup_dur: {
          primary: { usedPercent: 10, windowDurationMins: 60 },
          secondary: { usedPercent: 20, windowDurationMins: 60 },
        },
      },
    };
    const windows = codexPlanWindows(envelope);
    expect(windows).toEqual([
      {
        name: 'codex:300m',
        usedPercent: 15,
        resetsAt: '2026-11-30T10:00:00.000Z',
        windowDurationMins: 300,
        label: 'Codex',
      },
      {
        name: 'codex:10080m',
        usedPercent: 45,
        resetsAt: '2026-12-07T10:00:00.000Z',
        windowDurationMins: 10080,
        label: 'Codex',
      },
      {
        name: 'codex_spark:10080m',
        usedPercent: 30,
        resetsAt: '2026-12-07T10:00:00.000Z',
        windowDurationMins: 10080,
        label: 'GPT-5.3-Codex-Spark',
      },
      { name: 'dup_dur:60m:primary', usedPercent: 10, windowDurationMins: 60 },
      { name: 'dup_dur:60m:secondary', usedPercent: 20, windowDurationMins: 60 },
    ]);

    // Overlong limitId/label and >32 buckets are bounded cleanly and produce distinct names.
    const hugeBuckets: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      const id = `${'a'.repeat(300)}_${i}`;
      hugeBuckets[id] = {
        limitId: id,
        limitName: 'L'.repeat(300),
        primary: { usedPercent: 5, windowDurationMins: 300 },
      };
    }
    const bounded = codexPlanWindows({ rateLimitsByLimitId: hugeBuckets });
    expect(bounded).toHaveLength(32);
    expect(new Set(bounded.map((w) => w.name)).size).toBe(32);
    for (const w of bounded) {
      expect(w.name.length).toBeLessThanOrEqual(256);
      expect((w.label ?? '').length).toBeLessThanOrEqual(256);
    }

    // resetsAt: 0 omits resetsAt safely, and one malformed bucket does not drop healthy buckets.
    const partial = codexPlanWindows({
      rateLimitsByLimitId: {
        broken: { primary: { usedPercent: -10 } },
        healthy: {
          limitId: 'healthy',
          primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 0 },
        },
      },
    });
    expect(partial).toEqual([
      { name: 'healthy:300m', usedPercent: 22, windowDurationMins: 300 },
    ]);
  });
});

describe('Codex Unix socket transport, policy, and live session controls', () => {
  test('unix-listen and unix-connect transport modes manage providerPid, symlink sockets, stdout draining, and probe non-collision', () =>
    inScratch('codex-unix-transport', async (root) => {
      // Eager validation refusals
      expect(() =>
        createCodexDriver({ serverArgs: ['--listen', 'unix:///tmp/a.sock'] }),
      ).toThrow(/serverArgs/);
      expect(() => createCodexDriver({ serverArgs: ['--stdio'] })).toThrow(/serverArgs/);
      expect(() =>
        createCodexDriver({
          transport: { kind: 'unix-connect', socketPath: join(root, 'a.sock') },
          serverArgs: ['-c', 'x=1'],
        }),
      ).toThrow(/unix-connect/);
      expect(() =>
        createCodexDriver({
          transport: { kind: 'unix-listen', socketPath: 'relative.sock' },
        }),
      ).toThrow(/absolute path/);
      expect(() =>
        createCodexDriver({
          transport: {
            kind: 'unix-listen',
            socketPath: join(root, 'bad.sock'),
            listenTimeoutMs: 0,
          },
        }),
      ).toThrow();

      // unix-listen with symlinked socket (like real codex-cli 0.171.0) + stdout >1.5 MiB drain + serverArgs
      const sockDir = join(root, 'sock');
      mkdirSync(sockDir, { mode: 0o700 });
      const socketPath = join(sockDir, 'app.sock');
      const home = join(root, 'home-listen');
      const scenarioPath = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              itemId: 'm1',
              delta: 'hello',
            },
          },
        },
        turnCompleted('completed'),
      ]);
      const listenDriver = codexDriver(root, {
        transport: { kind: 'unix-listen', socketPath, listenTimeoutMs: 5_000 },
        serverArgs: ['-c', 'analytics=false'],
      });
      const profile = {
        profileId: 'unix-listen',
        engine: 'codex' as const,
        home,
        env: {
          FAKE_ENGINE_SCENARIO: scenarioPath,
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'unix-listen'),
          FAKE_CODEX_SYMLINK_SOCKET: '1',
          FAKE_CODEX_SPAM_STDOUT: '1',
          FAKE_CODEX_RATE_LIMITS: JSON.stringify({
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 18, windowDurationMins: 300 },
            },
            rateLimitsByLimitId: {
              codex: {
                limitId: 'codex',
                limitName: 'Codex',
                primary: { usedPercent: 18, windowDurationMins: 300 },
                secondary: { usedPercent: 52, windowDurationMins: 10080 },
              },
              spark: {
                limitId: 'spark',
                limitName: 'Spark',
                primary: { usedPercent: 9, windowDurationMins: 10080 },
              },
            },
          }),
        },
      };

      const session = await listenDriver.open({ profile, cwd: root });
      trackProcess(session.providerPid);
      try {
        expect(session.providerPid).toBeNumber();
        expect(session.providerPid).toBeGreaterThan(0);

        // Pre-existing socketPath is refused fail-closed with CodexUnixSocketError('target-refused').
        await expect(
          codexDriver(root, {
            transport: { kind: 'unix-listen', socketPath, listenTimeoutMs: 5_000 },
          }).open({ profile, cwd: root }),
        ).rejects.toMatchObject({ kind: 'target-refused' });

        const argv = JSON.parse(await readFile(join(home, 'argv.json'), 'utf8'));
        expect(argv).toContain('--listen');
        expect(argv).toContain(`unix://${socketPath}`);
        expect(argv).toContain('-c');
        expect(argv).toContain('analytics=false');

        const cid = crypto.randomUUID();
        const deltas = await drain(
          await session.startTurn({
            turnId: 't-u1',
            clientId: cid,
            input: [{ type: 'text', text: 'hi' }],
          }),
        );
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });

        // Ephemeral status() and findInput() use stdio and do NOT collide with the live Unix socket!
        // Use a dedicated pid file for ephemeral probes so the live daemon's pid file stays intact.
        const probeProfile = {
          ...profile,
          env: {
            ...profile.env,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'unix-listen-probe'),
          },
        };
        const st = await listenDriver.status(probeProfile);
        expect(st.planLimits?.windows.map((w) => w.name)).toEqual([
          'codex:10080m',
          'codex:300m',
          'spark:10080m',
        ]);
        expect(
          await listenDriver.findInput({
            profile: probeProfile,
            cwd: root,
            nativeThreadId: session.nativeThreadId,
            clientId: cid,
          }),
        ).toBe(true);

        // External unix-connect client attaches to the SAME live server and leaves it running on close()!
        const connectDriver = codexDriver(root, {
          transport: { kind: 'unix-connect', socketPath },
        });
        const attached = await connectDriver.open({ profile: probeProfile, cwd: root });
        expect(attached.providerPid).toBeUndefined();
        const models = await attached.listModels();
        expect(models).toEqual({ data: [{ id: 'gpt-5-codex', model: 'gpt-5-codex' }] });
        await attached.close();

        // After unix-connect closed, the original writer session is still alive and serving requests.
        expect(await session.readAccount()).toMatchObject({ requiresOpenaiAuth: true });
      } finally {
        await session.close();
      }

      // Caller abort AFTER open() in unix-listen tears down the live WebSocket & child process.
      const abortSock = join(sockDir, 'abort-after-open.sock');
      const abortCtl = new AbortController();
      const abortSession = await codexDriver(root, {
        transport: { kind: 'unix-listen', socketPath: abortSock, listenTimeoutMs: 5_000 },
      }).open({
        profile: {
          profileId: 'unix-abort',
          engine: 'codex',
          home: join(root, 'home-abort'),
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'unix-abort'),
          },
        },
        cwd: root,
        signal: abortCtl.signal,
      });
      trackProcess(abortSession.providerPid);
      try {
        abortCtl.abort(new Error('caller cancelled unix-listen session'));
        await Bun.sleep(50);
        await expect(abortSession.readConfig()).rejects.toThrow();
      } finally {
        await abortSession.close();
      }

      // Early child exit in unix-listen fails immediately with stderr (far faster than listenTimeoutMs).
      const earlySock = join(sockDir, 'early.sock');
      const startedAt = Date.now();
      const earlyDriver = codexDriver(root, {
        transport: { kind: 'unix-listen', socketPath: earlySock, listenTimeoutMs: 10_000 },
      });
      await expect(
        earlyDriver.open({
          profile: {
            profileId: 'early',
            engine: 'codex',
            home: join(root, 'home-early'),
            env: {
              FAKE_ENGINE_SCENARIO: scenarioPath,
              FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'early'),
              FAKE_CODEX_EXIT_EARLY: '1',
            },
          },
          cwd: root,
        }),
      ).rejects.toThrow(/early startup boom/);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    }));

  test('RFC 6455 frame decoder and Unix socket target security enforce bounds fail-closed', () =>
    inScratch('codex-ws-bounds', async (root) => {
      // Fragmented UTF-8 text + Ping + Close work cleanly
      const messages: string[] = [];
      const pings: Buffer[] = [];
      const errors: string[] = [];
      const closes: Array<{ code: number | undefined; reason: string }> = [];
      const dec = createWsFrameDecoder({
        maxFrameBytes: 64,
        onMessage: (m) => messages.push(m),
        onPing: (p) => pings.push(p),
        onClose: (code, reason) => closes.push({ code, reason }),
        onProtocolError: (e) => errors.push(e),
      });
      // Multi-byte UTF-8 emoji split across two fragments (FIN=0 text + FIN=1 continuation)
      const full = Buffer.from('hi🚀ok', 'utf8');
      dec.push(Buffer.concat([Buffer.from([0x01, 4]), full.subarray(0, 4)]));
      dec.push(Buffer.concat([Buffer.from([0x89, 2]), Buffer.from('pg')])); // Ping in middle of fragmentation (legal RFC 6455!)
      dec.push(Buffer.concat([Buffer.from([0x80, full.length - 4]), full.subarray(4)]));
      dec.push(Buffer.from([0x88, 4, 0x03, 0xe8, 0x6f, 0x6b])); // Close 1000 "ok"
      expect(messages).toEqual(['hi🚀ok']);
      expect(pings.map((p) => p.toString())).toEqual(['pg']);
      expect(closes).toEqual([{ code: 1000, reason: 'ok' }]);
      expect(errors).toEqual([]);

      const assertProtoErr = (frame: Buffer, pattern: RegExp) => {
        const errs: string[] = [];
        createWsFrameDecoder({
          maxFrameBytes: 32,
          onMessage: () => undefined,
          onPing: () => undefined,
          onClose: () => undefined,
          onProtocolError: (e) => errs.push(e),
        }).push(frame);
        expect(errs[0] ?? '').toMatch(pattern);
      };
      assertProtoErr(Buffer.from([0x91, 0x00]), /RSV/);
      assertProtoErr(Buffer.from([0x81, 0x80, 0, 0, 0, 0]), /masked/);
      assertProtoErr(Buffer.from([0x82, 0x00]), /data opcode/);
      // 64-bit length with MSB set rejected BEFORE waiting for body bytes!
      assertProtoErr(Buffer.from([0x81, 127, 0x80, 0, 0, 0, 0, 0, 0, 1]), /MSB/);
      // Oversized 64-bit frame length rejected BEFORE allocation!
      assertProtoErr(Buffer.from([0x81, 127, 0, 0, 0, 0, 0, 0, 1, 0]), /maxFrameBytes/);
      // Invalid UTF-8 rejected fail-closed!
      assertProtoErr(Buffer.from([0x81, 2, 0xff, 0xfe]), /UTF-8/);
      // Interleaved text frame, unexpected continuation, fragmented control, control >125B, 1-byte close
      assertProtoErr(Buffer.from([0x01, 1, 0x61, 0x81, 1, 0x62]), /Interleaved/);
      assertProtoErr(Buffer.from([0x80, 1, 0x61]), /Unexpected WebSocket continuation/);
      assertProtoErr(Buffer.from([0x09, 0]), /Control WebSocket frame must not be fragmented/);
      assertProtoErr(Buffer.from([0x89, 126, 0, 126]), /exceeds 125 bytes/);
      assertProtoErr(Buffer.from([0x88, 1, 0x03]), /cannot be 1 byte/);
      // >1024 fragments & total fragmented bytes exceeding maxFrameBytes
      const fragErrs: string[] = [];
      const fragDec = createWsFrameDecoder({
        maxFrameBytes: 4096,
        onMessage: () => undefined,
        onPing: () => undefined,
        onClose: () => undefined,
        onProtocolError: (e) => fragErrs.push(e),
      });
      fragDec.push(Buffer.from([0x01, 0]));
      for (let i = 0; i < 1025; i += 1) fragDec.push(Buffer.from([0x00, 0]));
      expect(fragErrs[0] ?? '').toMatch(/exceeded 1024 frames/);

      const byteErrs: string[] = [];
      const byteDec = createWsFrameDecoder({
        maxFrameBytes: 10,
        onMessage: () => undefined,
        onPing: () => undefined,
        onClose: () => undefined,
        onProtocolError: (e) => byteErrs.push(e),
      });
      byteDec.push(Buffer.from([0x01, 6, 97, 97, 97, 97, 97, 97]));
      byteDec.push(Buffer.from([0x80, 6, 98, 98, 98, 98, 98, 98]));
      expect(byteErrs[0] ?? '').toMatch(/exceeded maxFrameBytes/);

      // Security checks on Unix socket target
      const looseDir = join(root, 'loose');
      mkdirSync(looseDir, { mode: 0o777 });
      chmodSync(looseDir, 0o777);
      const looseSock = join(looseDir, 's.sock');
      await expect(
        connectCodexUnixSocket({
          socketPath: looseSock,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({ kind: 'target-refused' });

      const privDir = join(root, 'priv');
      mkdirSync(privDir, { mode: 0o700 });
      const regularFile = join(privDir, 'not-a-sock');
      writeFileSync(regularFile, 'hi');
      await expect(
        connectCodexUnixSocket({
          socketPath: regularFile,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({ kind: 'target-refused' });

      // Symlink pointing to a regular file or to a socket inside a 0o777 directory is refused fail-closed!
      const linkToFile = join(privDir, 'link-to-file.sock');
      symlinkSync(regularFile, linkToFile);
      await expect(
        connectCodexUnixSocket({
          socketPath: linkToFile,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({ kind: 'target-refused' });

      const looseTargetSock = join(looseDir, 'target.sock');
      const looseServer = createServer();
      await new Promise<void>((resolve) => looseServer.listen(looseTargetSock, resolve));
      const linkToLoose = join(privDir, 'link-to-loose.sock');
      symlinkSync(looseTargetSock, linkToLoose);
      try {
        await expect(
          connectCodexUnixSocket({
            socketPath: linkToLoose,
            signal: new AbortController().signal,
            onMessage: () => undefined,
            onClose: () => undefined,
          }),
        ).rejects.toMatchObject({ kind: 'target-refused' });
      } finally {
        looseServer.close();
      }

      const absentSock = join(privDir, 'missing.sock');
      await expect(
        connectCodexUnixSocket({
          socketPath: absentSock,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({ kind: 'endpoint-absent' });

      // Wrong expectedOwnerUid is refused fail-closed.
      const wrongUid = (process.getuid?.() ?? 0) + 1;
      await expect(
        connectCodexUnixSocket({
          socketPath: regularFile,
          expectedOwnerUid: wrongUid,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({ kind: 'target-refused' });

      // Stale (un-listened) socket inode left behind by a SIGKILLed listener gives endpoint-not-listening.
      const staleSock = join(privDir, 'stale.sock');
      const staleProc = Bun.spawn(
        [
          process.execPath,
          '-e',
          `require('node:net').createServer().listen(${JSON.stringify(staleSock)}, () => process.stdout.write('up\\n'));`,
        ],
        { stdout: 'pipe', stderr: 'ignore' },
      );
      trackProcess(staleProc.pid);
      const staleReader = staleProc.stdout.getReader();
      await staleReader.read();
      staleReader.releaseLock();
      staleProc.kill('SIGKILL');
      await staleProc.exited;
      await expect(
        connectCodexUnixSocket({
          socketPath: staleSock,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }),
      ).rejects.toMatchObject({ kind: 'endpoint-not-listening' });

      // HTTP non-101, bad Sec-WebSocket-Accept, >64 KiB headers WITH \r\n\r\n, pipelined trailing frame, Ping->Pong & maxPendingWriteBytes
      const badUpgradeSock = join(privDir, 'bad-upgrade.sock');
      let mode: '403' | 'bad-accept' | 'huge-header' | 'pipelined-ping' = '403';
      let sawPongPayload: string | undefined;
      const badServer = createServer((sock) => {
        sock.once('data', (reqBuf) => {
          const req = reqBuf.toString('latin1');
          const key = /^sec-websocket-key:\s*(.+)$/im.exec(req)?.[1]?.trim() ?? '';
          const accept = createHash('sha1')
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
          if (mode === '403') {
            sock.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
          } else if (mode === 'bad-accept') {
            sock.end(
              'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: wrong==\r\n\r\n',
            );
          } else if (mode === 'huge-header') {
            sock.end(
              `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nX-Pad: ${'a'.repeat(70_000)}\r\n\r\n`,
            );
          } else {
            // Send 101 + pipelined text frame + Ping frame in the SAME write!
            const textPayload = Buffer.from('pipelined-hello', 'utf8');
            const textFrame = Buffer.concat([
              Buffer.from([0x81, textPayload.byteLength]),
              textPayload,
            ]);
            const pingFrame = Buffer.from([0x89, 2, 0x70, 0x69]); // "pi"
            sock.write(
              Buffer.concat([
                Buffer.from(
                  `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
                  'latin1',
                ),
                textFrame,
                pingFrame,
              ]),
            );
            sock.on('data', (frame: Buffer) => {
              if ((frame[0] ?? 0) === 0x8a && frame.byteLength >= 8) {
                const len = (frame[1] ?? 0) & 0x7f;
                const mask = frame.subarray(2, 6);
                const out = Buffer.allocUnsafe(len);
                for (let i = 0; i < len; i += 1) {
                  out[i] = (frame[6 + i] ?? 0) ^ (mask[i & 3] ?? 0);
                }
                sawPongPayload = out.toString('utf8');
              }
            });
          }
        });
      });
      await new Promise<void>((resolve) => badServer.listen(badUpgradeSock, resolve));
      try {
        const err403 = await connectCodexUnixSocket({
          socketPath: badUpgradeSock,
          signal: new AbortController().signal,
          onMessage: () => undefined,
          onClose: () => undefined,
        }).catch((e: unknown) => e);
        expect(err403).toBeInstanceOf(CodexUnixSocketError);
        expect(Reflect.get(Object(err403), 'kind')).toBe('upgrade-refused');

        mode = 'bad-accept';
        await expect(
          connectCodexUnixSocket({
            socketPath: badUpgradeSock,
            signal: new AbortController().signal,
            onMessage: () => undefined,
            onClose: () => undefined,
          }),
        ).rejects.toMatchObject({ kind: 'upgrade-refused' });

        mode = 'huge-header';
        await expect(
          connectCodexUnixSocket({
            socketPath: badUpgradeSock,
            signal: new AbortController().signal,
            onMessage: () => undefined,
            onClose: () => undefined,
          }),
        ).rejects.toMatchObject({ kind: 'upgrade-refused' });

        mode = 'pipelined-ping';
        const received: string[] = [];
        const ws = await connectCodexUnixSocket({
          socketPath: badUpgradeSock,
          signal: new AbortController().signal,
          maxPendingWriteBytes: 32,
          onMessage: (m) => received.push(m),
          onClose: () => undefined,
        });
        try {
          await Bun.sleep(25);
          expect(received).toEqual(['pipelined-hello']);
          expect(sawPongPayload).toBe('pi');
          expect(() => ws.send('x'.repeat(64))).toThrow(RangeError);
        } finally {
          await ws.close();
        }
      } finally {
        badServer.close();
      }
    }));

  test('thread policy overrides, prepareThread, verifyThread, and applied threadContext enforce delegation fail-closed', () =>
    inScratch('codex-policy-delegation', async (root) => {
      const scenarioPath = await writeScenario(root, [turnCompleted('completed')]);
      const home = join(root, 'home-policy');
      const seenHooks: string[] = [];
      const driver = codexDriver(root, {
        model: 'gpt-5-codex',
        modelProvider: 'openai',
        approvalPolicy: 'never',
        sandbox: 'workspace-write',
        developerInstructions: 'Follow delegation boundary strictly.',
        runtimeWorkspaceRoots: [root],
        config: {
          'mcp_servers.enabled': false,
          'sandbox_workspace_write.network_access': false,
        },
        prepareThread: async ({ controls }) => {
          seenHooks.push('prepare');
          const cfg = await controls.readConfig({ cwd: root, includeLayers: true });
          expect(cfg).toHaveProperty('config');
          return {
            developerInstructions: 'Dynamic policy instructions.',
            config: { 'features.plugins': false },
          };
        },
        verifyThread: async ({ nativeThreadId, threadContext, controls }) => {
          seenHooks.push(`verify:${nativeThreadId}`);
          expect(threadContext).toMatchObject({
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            reasoningEffort: 'high',
            sandbox: 'workspace-write',
          });
          const mcps = await controls.listMcpServerStatus({ threadId: nativeThreadId });
          expect(mcps).toEqual({ data: [] });
          const skills = await controls.listSkills({ cwds: [root] });
          expect(skills).toEqual({ data: [] });
        },
      });
      const profile = {
        profileId: 'policy',
        engine: 'codex' as const,
        home,
        env: {
          FAKE_ENGINE_SCENARIO: scenarioPath,
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'policy'),
          FAKE_CODEX_THREAD_CONTEXT: JSON.stringify({
            model: 'gpt-5-codex',
            modelProvider: 'openai',
            reasoningEffort: 'high',
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            cwd: root,
            runtimeWorkspaceRoots: [root],
          }),
        },
      };

      const session = await driver.open({ profile, cwd: root });
      try {
        expect(seenHooks).toEqual(['prepare', 'verify:fake-thread']);
        expect(session.providerPid).toBeNumber();
        expect(session.threadContext).toMatchObject({
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          reasoningEffort: 'high',
        });
        const [started] = await readJsonLines(join(home, 'thread-start.jsonl'));
        expect(started).toMatchObject({
          cwd: root,
          model: 'gpt-5-codex',
          modelProvider: 'openai',
          approvalPolicy: 'never',
          sandbox: 'workspace-write',
          developerInstructions: 'Dynamic policy instructions.',
          runtimeWorkspaceRoots: [root],
          config: {
            'mcp_servers.enabled': false,
            'sandbox_workspace_write.network_access': false,
            'features.plugins': false,
          },
        });
      } finally {
        await session.close();
      }

      // Failing verifyThread stops the spawned app-server cleanly without leaking the process!
      const pidFile = trackedPidFile(root, 'verify-fail');
      const failingDriver = codexDriver(root, {
        verifyThread: async () => {
          throw new Error('delegation policy rejected: leaked MCP server');
        },
      });
      await expect(
        failingDriver.open({
          profile: {
            profileId: 'verify-fail',
            engine: 'codex',
            home: join(root, 'home-verify-fail'),
            env: { FAKE_ENGINE_SCENARIO: scenarioPath, FAKE_ENGINE_PID_FILE: pidFile },
          },
          cwd: root,
        }),
      ).rejects.toThrow(/delegation policy rejected/);
      const failedPid = Number((await readFile(pidFile, 'utf8')).trim());
      trackProcess(failedPid);
      // On Linux under PR_SET_CHILD_SUBREAPER (test-leak-gate), an already-terminated child stays
      // as a zombie ('Z') until the subreaper finishes and kill(pid, 0) still returns 0 for zombies.
      const isDead = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        if (process.platform === 'linux') {
          try {
            const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
            return state === 'Z' || state === 'X';
          } catch {
            return true;
          }
        }
        return false;
      };
      expect(isDead(failedPid)).toBe(true);
    }));

  test('CodexSession supports per-turn overrides, steerTurn with attachments, non-mutating forkThread, compactThread, inspection RPCs, and survives rate-limit merge overflow', () =>
    inScratch('codex-session-controls', async (root) => {
      // Build two rate-limit notifications whose union exceeds PlanLimitsSchema's 32-window limit
      // so mergeRateLimitEvent actually throws ZodError and proves case 'limits' try/catch keeps the loop alive!
      const batchA: Record<
        string,
        { primary: { usedPercent: number; windowDurationMins: number } }
      > = {};
      const batchB: Record<
        string,
        { primary: { usedPercent: number; windowDurationMins: number } }
      > = {};
      for (let i = 0; i < 20; i += 1) {
        batchA[`bucket_a_${i}`] = { primary: { usedPercent: 10, windowDurationMins: 300 } };
        batchB[`bucket_b_${i}`] = { primary: { usedPercent: 20, windowDurationMins: 300 } };
      }
      const scenarioPath = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            method: 'account/rateLimits/updated',
            params: { rateLimits: {}, rateLimitsByLimitId: batchA },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'account/rateLimits/updated',
            params: { rateLimits: {}, rateLimitsByLimitId: batchB },
          },
        },
        { do: 'expect', type: 'turn/steer' },
        turnCompleted('completed'),
      ]);
      const home = join(root, 'home-controls');
      let resolveFileCalls = 0;
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const driver = codexDriver(root, {
        modelProvider: 'openai',
        resolveFile: async () => {
          resolveFileCalls += 1;
          return pngBytes;
        },
      });
      const session = await driver.open({
        profile: {
          profileId: 'controls',
          engine: 'codex',
          home,
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'controls'),
            FAKE_CODEX_THREAD_CONTEXT: JSON.stringify({
              model: 'gpt-5-codex',
              modelProvider: 'openai',
              reasoningEffort: 'medium',
            }),
          },
        },
        cwd: root,
      });
      try {
        // Inspection RPCs
        expect(await session.readConfig({ includeLayers: true })).toHaveProperty('config');
        expect(await session.listMcpServerStatus()).toEqual({ data: [] });
        expect(await session.listSkills()).toEqual({ data: [] });
        expect(await session.listModels({ includeHidden: true })).toMatchObject({
          data: [{ id: 'gpt-5-codex' }],
        });
        expect(await session.readAccount({ refreshToken: false })).toMatchObject({
          requiresOpenaiAuth: true,
        });
        expect(await session.readRateLimits()).toHaveProperty('rateLimits');

        // Fail-closed refusal when per-turn modelProvider differs from active thread provider,
        // rejected eagerly BEFORE calling resolveFile!
        await expect(
          session.startTurn({
            turnId: 't-bad-provider',
            clientId: crypto.randomUUID(),
            input: [
              { type: 'text', text: 'hi' },
              { type: 'file', mediaType: 'image/png', reference: 'never-read.png' },
            ],
            modelProvider: 'anthropic',
          }),
        ).rejects.toThrow(TypeError);
        expect(resolveFileCalls).toBe(0);

        // Start turn with full per-turn overrides (reasoningEffort -> effort, collaborationMode, etc.)
        const turn = await session.startTurn({
          turnId: 't-ctrl',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'start' }],
          model: 'gpt-5.3-codex',
          modelProvider: 'openai',
          reasoningEffort: 'high',
          collaborationMode: {
            mode: 'plan',
            settings: { model: 'gpt-5.3-codex', reasoning_effort: 'high' },
          },
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly' },
          runtimeWorkspaceRoots: [root],
        });

        const [turnStartParams] = await readJsonLines(join(home, 'turn-start.jsonl'));
        expect(turnStartParams).toMatchObject({
          threadId: 'fake-thread',
          model: 'gpt-5.3-codex',
          effort: 'high',
          collaborationMode: {
            mode: 'plan',
            settings: { model: 'gpt-5.3-codex', reasoning_effort: 'high' },
          },
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly' },
          runtimeWorkspaceRoots: [root],
        });
        // modelProvider is verified locally and NOT sent on turn/start wire.
        expect(turnStartParams).not.toHaveProperty('modelProvider');

        // Mismatched expectedTurnId refused
        await expect(
          session.steerTurn({
            input: [{ type: 'text', text: 'wrong' }],
            expectedTurnId: 'other-turn',
          }),
        ).rejects.toThrow(TypeError);

        // steerTurn with text + image attachment via inlineParts
        const steerRes = await session.steerTurn({
          input: [
            { type: 'text', text: 'focus on tests' },
            { type: 'file', mediaType: 'image/png', reference: 'shot.png' },
          ],
          clientId: 'steer-1',
        });
        expect(steerRes).toEqual({ turnId: 'fake-turn' });
        const [steered] = await readJsonLines(join(home, 'turn-steer.jsonl'));
        expect(steered).toMatchObject({
          threadId: 'fake-thread',
          expectedTurnId: 'fake-turn',
          clientUserMessageId: 'steer-1',
          input: [
            { type: 'text', text: 'focus on tests', text_elements: [] },
            { type: 'image', url: expect.stringMatching(/^data:image\/png;base64,/) },
          ],
        });

        const deltas = await drain(turn);
        // The >32-window rate-limit merge overflow emitted an unhandled error delta instead of crashing the session!
        expect(deltas).toContainEqual(
          expect.objectContaining({
            type: 'error',
            kind: 'unhandled',
            raw: { source: 'codex', type: 'account/rateLimits/updated' },
          }),
        );
        expect(deltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });

        // forkThread does NOT mutate current session's nativeThreadId
        const forked = await session.forkThread({
          model: 'gpt-5-codex',
          beforeTurnId: 'fake-turn',
        });
        expect(forked.nativeThreadId).toBe('forked-thread');
        expect(forked.threadContext.model).toBe('gpt-5-codex');
        expect(session.nativeThreadId).toBe('fake-thread');

        // compactThread invokes thread/compact/start for current threadId
        await session.compactThread();
        const [compacted] = await readJsonLines(join(home, 'thread-compact.jsonl'));
        expect(compacted).toEqual({ threadId: 'fake-thread' });
      } finally {
        await session.close();
      }

      // Live controls refuse after close
      await expect(session.readConfig()).rejects.toThrow(/closed/);
      await expect(session.compactThread()).rejects.toThrow(/closed/);

      // prepareThread overriding modelProvider updates activeModelProvider even when thread/start omits it
      const dynSession = await codexDriver(root, {
        modelProvider: 'openai',
        prepareThread: async () => ({ modelProvider: 'azure' }),
      }).open({
        profile: {
          profileId: 'dyn-provider',
          engine: 'codex',
          home: join(root, 'home-dyn-provider'),
          env: {
            FAKE_ENGINE_SCENARIO: await writeScenario(root, [turnCompleted('completed')]),
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'dyn-provider'),
          },
        },
        cwd: root,
      });
      try {
        await expect(
          dynSession.startTurn({
            turnId: 't-old-prov',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'hi' }],
            modelProvider: 'openai',
          }),
        ).rejects.toThrow(TypeError);
        const okDeltas = await drain(
          await dynSession.startTurn({
            turnId: 't-new-prov',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'hi' }],
            modelProvider: 'azure',
          }),
        );
        expect(okDeltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
      } finally {
        await dynSession.close();
      }
    }));

  test('Codex driver observes external TUI turns, handles server requests without -32601, preserves full payloads, and fires onDisconnect', () =>
    inScratch('codex-tui-observation', async (root) => {
      const sockDir = join(root, 'sock');
      mkdirSync(sockDir, { mode: 0o700 });
      const socketPath = join(sockDir, 'tui-shared.sock');
      const home = join(root, 'home-tui');
      const scenarioPath = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            method: 'thread/status/changed',
            params: { threadId: 'fake-thread', status: { type: 'active', activeFlags: [] } },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'turn/started',
            params: {
              threadId: 'fake-thread',
              turn: { id: 'tui-turn-1', status: 'inProgress' },
            },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'item/plan/delta',
            params: {
              threadId: 'fake-thread',
              turnId: 'tui-turn-1',
              itemId: 'plan-1',
              delta: 'step 1',
            },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'thread/settings/updated',
            params: { threadId: 'fake-thread', threadSettings: { model: 'gpt-5-codex' } },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'model/rerouted',
            params: {
              threadId: 'fake-thread',
              turnId: 'tui-turn-1',
              fromModel: 'a',
              toModel: 'b',
              reason: 'highRiskCyberActivity',
            },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'thread/compacted',
            params: { threadId: 'fake-thread', turnId: 'tui-turn-1' },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'item/agentMessage/delta',
            params: {
              threadId: 'fake-thread',
              turnId: 'tui-turn-1',
              itemId: 'm-tui',
              delta: 'hello from tui',
            },
          },
        },
        {
          do: 'emit',
          record: {
            id: 'tui-appr-1',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'fake-thread',
              turnId: 'tui-turn-1',
              itemId: 'cmd-1',
              command: 'rm -rf build',
              cwd: root,
              reason: 'Clean build dir',
              availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'tui-input-1',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'fake-thread',
              turnId: 'tui-turn-1',
              itemId: 'inp-1',
              questions: [
                {
                  id: 'q1',
                  header: 'Environment',
                  question: 'Which target?',
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: 'dev', description: 'Development server' },
                    { label: 'prod', description: 'Production server' },
                  ],
                },
              ],
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            method: 'thread/tokenUsage/updated',
            params: {
              threadId: 'fake-thread',
              turnId: 'tui-turn-1',
              tokenUsage: {
                last: {
                  inputTokens: 100,
                  outputTokens: 50,
                  cachedInputTokens: 20,
                  cacheWriteInputTokens: 10,
                  reasoningOutputTokens: 15,
                  totalTokens: 150,
                },
                total: {
                  inputTokens: 500,
                  outputTokens: 250,
                  cachedInputTokens: 100,
                  cacheWriteInputTokens: 40,
                  reasoningOutputTokens: 70,
                  totalTokens: 750,
                },
                modelContextWindow: 200_000,
              },
            },
          },
        },
        {
          do: 'emit',
          record: {
            method: 'turn/completed',
            params: {
              threadId: 'fake-thread',
              turn: { id: 'tui-turn-1', status: 'completed', items: [] },
            },
          },
        },
      ]);

      const notifications: Array<{
        method: string;
        duringActiveTurn: boolean;
        deltaTypes: string[];
        turnIds: string[];
        usage?: unknown;
      }> = [];
      const externalRequests: Array<{
        interactionId: string;
        method: string;
        delta: ExecutorDelta;
      }> = [];
      const disconnects: Error[] = [];

      const ownerDriver = codexDriver(root, {
        transport: { kind: 'unix-listen', socketPath, listenTimeoutMs: 5_000 },
        onNotification: (event) => {
          notifications.push({
            method: event.method,
            duringActiveTurn: event.duringActiveTurn,
            deltaTypes: event.deltas.map((d) => d.type),
            turnIds: event.deltas.map((d) => d.turnId),
            ...(event.deltas[0]?.type === 'usage' && { usage: event.deltas[0] }),
          });
          if (event.method === 'thread/compacted') {
            // Observer throws must not crash the reader loop!
            throw new Error('notification observer throw');
          }
        },
        onServerRequest: async (req) => {
          externalRequests.push({
            interactionId: req.interactionId,
            method: req.method,
            delta: req.delta,
          });
          if (req.method === 'item/commandExecution/requestApproval') {
            await req.respond({ kind: 'approve', scope: 'session' });
          } else if (req.method === 'item/tool/requestUserInput') {
            await req.respond({ kind: 'input', value: { q1: { answers: ['dev'] } } });
          }
        },
        onDisconnect: (error) => {
          disconnects.push(error);
        },
      });

      const profile = {
        profileId: 'tui-owner',
        engine: 'codex' as const,
        home,
        env: {
          FAKE_ENGINE_SCENARIO: scenarioPath,
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'tui-owner'),
          FAKE_CODEX_BROADCAST_TUI: '1',
        },
      };

      const ownerSession = await ownerDriver.open({ profile, cwd: root });
      trackProcess(ownerSession.providerPid);
      try {
        // Verify app/list/updated is opted out at initialize.
        const [initParams] = await readJsonLines(join(home, 'initialize.jsonl'));
        expect(initParams).toMatchObject({
          capabilities: {
            optOutNotificationMethods: expect.arrayContaining(['app/list/updated']),
          },
        });

        // Second client (simulated TUI) attaches via unix-connect and starts a turn!
        const tuiDriver = codexDriver(root, {
          transport: { kind: 'unix-connect', socketPath },
        });
        const tuiSession = await tuiDriver.open({
          profile: {
            ...profile,
            env: { ...profile.env, FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'tui-client') },
          },
          cwd: root,
          nativeThreadId: ownerSession.nativeThreadId,
        });
        try {
          const tuiTurn = await tuiSession.startTurn({
            turnId: 'client-2-turn',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'run from tui' }],
          });
          const tuiDeltas = await drain(tuiTurn);
          expect(tuiDeltas.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'completed' });
        } finally {
          await tuiSession.close();
        }

        await Bun.sleep(40);

        // Owner observed all lifecycle notifications + external turn deltas without starting a turn!
        const methods = notifications.map((n) => n.method);
        expect(methods).toEqual(
          expect.arrayContaining([
            'thread/status/changed',
            'turn/started',
            'item/plan/delta',
            'thread/settings/updated',
            'model/rerouted',
            'thread/compacted',
            'item/agentMessage/delta',
            'thread/tokenUsage/updated',
            'turn/completed',
          ]),
        );
        const textNotif = notifications.find((n) => n.method === 'item/agentMessage/delta');
        expect(textNotif).toMatchObject({
          duringActiveTurn: false,
          deltaTypes: ['text'],
          turnIds: ['tui-turn-1'],
        });
        const usageNotif = notifications.find((n) => n.method === 'thread/tokenUsage/updated');
        expect(usageNotif?.usage).toMatchObject({
          type: 'usage',
          turnId: 'tui-turn-1',
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 20,
          cacheCreationInputTokens: 10,
          thinkingTokens: 15,
          totalTokens: 150,
          total: {
            inputTokens: 500,
            outputTokens: 250,
            cachedInputTokens: 100,
            cacheCreationInputTokens: 40,
            thinkingTokens: 70,
            totalTokens: 750,
          },
        });

        // Both approval and requestUserInput arrived with full fields and zero -32601 errors!
        expect(externalRequests).toHaveLength(2);
        expect(externalRequests[0]?.delta).toMatchObject({
          type: 'request',
          kind: 'approval',
          interactionId: 'tui-appr-1',
          turnId: 'tui-turn-1',
          prompt: 'rm -rf build',
          input: {
            command: 'rm -rf build',
            cwd: root,
            reason: 'Clean build dir',
            availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
          },
        });
        expect(externalRequests[1]?.delta).toMatchObject({
          type: 'request',
          kind: 'input',
          interactionId: 'tui-input-1',
          turnId: 'tui-turn-1',
          input: [
            {
              id: 'q1',
              header: 'Environment',
              question: 'Which target?',
              isOther: true,
              isSecret: false,
              options: [
                { label: 'dev', description: 'Development server' },
                { label: 'prod', description: 'Production server' },
              ],
            },
          ],
        });
        const responses = await readJsonLines(join(home, 'responses.jsonl'));
        expect(responses).toContainEqual({
          id: 'tui-appr-1',
          result: { decision: 'acceptForSession' },
        });
        expect(responses).toContainEqual({
          id: 'tui-input-1',
          result: { answers: { q1: { answers: ['dev'] } } },
        });
        expect(responses.some((r) => Reflect.get(Object(r), 'error') !== undefined)).toBe(
          false,
        );

        // Idle disconnect fires onDisconnect immediately when the underlying server dies!
        expect(disconnects).toHaveLength(0);
        if (ownerSession.providerPid !== undefined) {
          process.kill(ownerSession.providerPid, 'SIGKILL');
        }
        for (let i = 0; i < 40 && disconnects.length === 0; i += 1) await Bun.sleep(25);
        expect(disconnects).toHaveLength(1);
      } finally {
        await ownerSession.close();
      }
      // Intentional close must NOT fire a second disconnect.
      expect(disconnects).toHaveLength(1);
    }));

  test('CodexSession exposes readThread, listCollaborationModes, listTurns, listItems, connectControl, skill inputs, forkFrom open, and approval decision guards', () =>
    inScratch('codex-rpcs-skills-fork', async (root) => {
      const home = join(root, 'home-rpcs');
      const scenarioPath = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            id: 'appr-restricted',
            method: 'item/commandExecution/requestApproval',
            params: {
              itemId: 'cmd-r1',
              command: 'git push',
              availableDecisions: ['accept', 'decline', 'cancel'],
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'appr-human',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'cmd-h1', command: 'sudo reboot', kind: 'humanCommand' },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'appr-file',
            method: 'item/fileChange/requestApproval',
            params: { itemId: 'fc-1', reason: 'Edit README', grantRoot: root },
          },
        },
        { do: 'expect', type: 'response' },
        turnCompleted('completed'),
      ]);

      let resolveFileCalls = 0;
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const prepareCalls: unknown[] = [];
      const driver = codexDriver(root, {
        modelProvider: 'openai',
        resolveFile: async () => {
          resolveFileCalls += 1;
          return pngBytes;
        },
        prepareThread: async (ctx) => {
          prepareCalls.push({ nativeThreadId: ctx.nativeThreadId, forkFrom: ctx.forkFrom });
          return undefined;
        },
      });
      const profile = {
        profileId: 'rpcs',
        engine: 'codex' as const,
        home,
        env: {
          FAKE_ENGINE_SCENARIO: scenarioPath,
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'rpcs'),
          FAKE_CODEX_THREAD_CONTEXT: JSON.stringify({
            model: 'gpt-5-codex',
            modelProvider: 'azure',
          }),
        },
      };

      // 1. Threadless connectControl: readConfig + listModels + readThread + listTurns + listItems without thread/start!
      const ctrl = await driver.connectControl({
        profile: {
          ...profile,
          env: { ...profile.env, FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'rpcs-ctrl') },
        },
        cwd: root,
      });
      try {
        expect(ctrl.providerPid).toBeNumber();
        expect(await ctrl.readConfig({ cwd: root })).toHaveProperty('config');
        expect(await ctrl.listModels()).toMatchObject({ data: [{ id: 'gpt-5-codex' }] });
        expect(await ctrl.listCollaborationModes()).toMatchObject({
          data: [{ mode: 'plan' }, { mode: 'default' }],
        });
        expect(
          await ctrl.readThread({ threadId: 't-ext', includeTurns: false }),
        ).toMatchObject({
          thread: { id: 't-ext', canAcceptDirectInput: true },
        });
        expect(
          await ctrl.listTurns({ threadId: 't-ext', limit: 10, sortDirection: 'desc' }),
        ).toHaveProperty('data');
        expect(
          await ctrl.listItems({
            threadId: 't-ext',
            turnId: 'turn-0',
            cursor: { type: 'item', itemId: 'i-0' },
            deferOutput: { commandExecution: true },
          }),
        ).toMatchObject({ data: [{ item: { type: 'contextCompaction' } }] });
        await expect(ctrl.readThread({ threadId: '   ' })).rejects.toThrow(TypeError);
        await expect(ctrl.listTurns({ threadId: 't-ext', limit: -1 })).rejects.toThrow(
          TypeError,
        );
        await expect(
          ctrl.listTurns({ threadId: 't-ext', limit: 0x1_0000_0000 }),
        ).rejects.toThrow(TypeError);
        await expect(ctrl.listItems({ threadId: 't-ext', turnId: '   ' })).rejects.toThrow(
          TypeError,
        );
        await expect(
          ctrl.listItems({ threadId: 't-ext', cursor: { type: 'item', itemId: '  ' } }),
        ).rejects.toThrow(TypeError);
        expect(existsSync(join(home, 'thread-start.jsonl'))).toBe(false);
      } finally {
        await ctrl.close();
      }
      const rpcLog = await readJsonLines(join(home, 'rpc.jsonl'));
      expect(rpcLog).toContainEqual({ method: 'collaborationMode/list', params: {} });
      expect(rpcLog).toContainEqual({
        method: 'thread/read',
        params: { threadId: 't-ext', includeTurns: false },
      });
      expect(rpcLog).toContainEqual({
        method: 'thread/turns/list',
        params: { threadId: 't-ext', limit: 10, sortDirection: 'desc' },
      });
      expect(rpcLog).toContainEqual({
        method: 'thread/items/list',
        params: {
          threadId: 't-ext',
          turnId: 'turn-0',
          cursor: { type: 'item', itemId: 'i-0' },
          deferOutput: { commandExecution: true },
        },
      });

      // 2. Eager open() and CodexSkillInputSchema validation refusals before spawn.
      expect(
        CodexSkillInputSchema.safeParse({ type: 'skill', name: '   ', path: '/a' }).success,
      ).toBe(false);
      expect(
        CodexSkillInputSchema.safeParse({ type: 'skill', name: 'ok', path: '/a\0b' }).success,
      ).toBe(false);
      await expect(
        driver.open({
          profile,
          cwd: root,
          nativeThreadId: 'th-1',
          forkFrom: { threadId: 'th-2' },
        }),
      ).rejects.toThrow(/mutually exclusive/);
      await expect(
        driver.open({ profile, cwd: root, forkFrom: { threadId: '   ' } }),
      ).rejects.toThrow(/non-empty/);
      await expect(
        driver.open({
          profile,
          cwd: root,
          forkFrom: { threadId: 'th-1', beforeTurnId: 'a', lastTurnId: 'b' },
        }),
      ).rejects.toThrow(/mutually exclusive/);
      await expect(
        driver.open({
          profile,
          cwd: root,
          forkFrom: { threadId: 'th-1', runtimeWorkspaceRoots: ['   '] },
        }),
      ).rejects.toThrow(/non-empty/);

      // 3. Open session directly via thread/fork with deferGoalContinuation + excludeTurns default true.
      const forkedSession = await driver.open({
        profile,
        cwd: root,
        forkFrom: {
          threadId: 'orig-thread-9',
          beforeTurnId: 'turn-4',
          deferGoalContinuation: true,
          modelProvider: 'azure',
        },
      });
      try {
        expect(forkedSession.nativeThreadId).toBe('forked-thread');
        expect(prepareCalls[0]).toMatchObject({
          forkFrom: { threadId: 'orig-thread-9', deferGoalContinuation: true },
        });
        const [forkReq] = await readJsonLines(join(home, 'thread-fork.jsonl'));
        expect(forkReq).toMatchObject({
          threadId: 'orig-thread-9',
          beforeTurnId: 'turn-4',
          excludeTurns: true,
          deferGoalContinuation: true,
          modelProvider: 'azure',
        });

        // Session-bound RPCs default threadId to nativeThreadId.
        expect(await forkedSession.readThread()).toMatchObject({
          thread: { id: 'forked-thread' },
        });
        expect(await forkedSession.listTurns({ itemsView: 'full' })).toHaveProperty('data');
        expect(await forkedSession.listItems()).toHaveProperty('data');

        // forkThread supports deferGoalContinuation and refuses beforeTurnId + lastTurnId.
        await expect(
          forkedSession.forkThread({ beforeTurnId: 'a', lastTurnId: 'b' }),
        ).rejects.toThrow(/mutually exclusive/);
        await forkedSession.forkThread({ deferGoalContinuation: true });
        const forkReqs = await readJsonLines(join(home, 'thread-fork.jsonl'));
        expect(forkReqs[1]).toMatchObject({
          threadId: 'forked-thread',
          deferGoalContinuation: true,
        });

        // Invalid skill input refused eagerly BEFORE resolveFile is called!
        await expect(
          forkedSession.startTurn({
            turnId: 't-bad-skill',
            clientId: crypto.randomUUID(),
            input: [
              { type: 'skill', name: 'bad\0name', path: '/tmp/SKILL.md' },
              { type: 'file', mediaType: 'image/png', reference: 'never.png' },
            ],
          }),
        ).rejects.toThrow(TypeError);
        expect(resolveFileCalls).toBe(0);

        // Order-preserving [text, skill, image] turn + approval decision guards (availableDecisions, humanCommand, fileChange)!
        const turn = await forkedSession.startTurn({
          turnId: 't-skills',
          clientId: crypto.randomUUID(),
          input: [
            { type: 'text', text: 'apply skill' },
            { type: 'skill', name: 'audit', path: '/skills/audit/SKILL.md' },
            { type: 'file', mediaType: 'image/png', reference: 'shot.png' },
          ],
          modelProvider: 'azure',
        });
        const [startedTurn] = await readJsonLines(join(home, 'turn-start.jsonl'));
        expect(startedTurn).toMatchObject({
          input: [
            { type: 'text', text: 'apply skill', text_elements: [] },
            { type: 'skill', name: 'audit', path: '/skills/audit/SKILL.md' },
            { type: 'image', url: expect.stringMatching(/^data:image\/png;base64,/) },
          ],
        });

        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          if (delta.type === 'request' && delta.interactionId === 'appr-restricted') {
            // steerTurn supports ordered CodexSkillInput alongside text while a turn is active.
            await forkedSession.steerTurn({
              input: [
                { type: 'text', text: 'steer with skill' },
                { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
              ],
            });
            // acceptForSession not in availableDecisions -> refused without removing pending!
            await expect(
              turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' }),
            ).rejects.toThrow(TypeError);
            await turn.respond(delta.interactionId, {
              kind: 'deny',
              message: 'abort turn',
              interrupt: true,
            });
          } else if (delta.type === 'request' && delta.interactionId === 'appr-human') {
            await expect(
              turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' }),
            ).rejects.toThrow(/humanCommand/);
            await turn.respond(delta.interactionId, { kind: 'approve', scope: 'once' });
          } else if (delta.type === 'request' && delta.interactionId === 'appr-file') {
            expect(delta.input).toMatchObject({ reason: 'Edit README', grantRoot: root });
            await forkedSession.respond(delta.interactionId, {
              kind: 'approve',
              scope: 'session',
            });
          }
        }
        const [steered] = await readJsonLines(join(home, 'turn-steer.jsonl'));
        expect(steered).toMatchObject({
          input: [
            { type: 'text', text: 'steer with skill', text_elements: [] },
            { type: 'skill', name: 'review', path: '/skills/review/SKILL.md' },
          ],
        });
        const responses = await readJsonLines(join(home, 'responses.jsonl'));
        expect(responses).toContainEqual({
          id: 'appr-restricted',
          result: { decision: 'cancel' },
        });
        expect(responses).toContainEqual({ id: 'appr-human', result: { decision: 'accept' } });
        expect(responses).toContainEqual({
          id: 'appr-file',
          result: { decision: 'acceptForSession' },
        });
      } finally {
        await forkedSession.close();
      }

      // 4. forkFrom.modelProvider falls back as activeModelProvider when threadContext omits modelProvider.
      const fallbackSession = await codexDriver(root, { modelProvider: 'openai' }).open({
        profile: {
          profileId: 'fork-fallback',
          engine: 'codex',
          home: join(root, 'home-fallback'),
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'fork-fallback'),
            FAKE_CODEX_THREAD_CONTEXT: JSON.stringify({ model: 'gpt-5-codex' }),
          },
        },
        cwd: root,
        forkFrom: { threadId: 'orig-fallback', modelProvider: 'bedrock' },
      });
      try {
        await expect(
          fallbackSession.startTurn({
            turnId: 't-wrong-prov',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'hi' }],
            modelProvider: 'openai',
          }),
        ).rejects.toThrow(/cannot switch modelProvider/);
      } finally {
        await fallbackSession.close();
      }
    }));

  test('Codex observer disconnect/close never sends cancel to external pending requests and suppresses onDisconnect during failed open or caller abort', () =>
    inScratch('codex-observer-safety', async (root) => {
      const sockDir = join(root, 'sock');
      mkdirSync(sockDir, { mode: 0o700 });
      const socketPath = join(sockDir, 'safety.sock');
      const home = join(root, 'home-safety');
      const scenarioPath = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            id: 'ext-unanswered-1',
            method: 'item/commandExecution/requestApproval',
            params: { itemId: 'cmd-u1', command: 'echo stay' },
          },
        },
        { do: 'delay', ms: 300 },
        turnCompleted('completed'),
      ]);

      // 1. stdio early startup exit rejects open() and connectControl() without firing onDisconnect.
      const earlyDisconnects: Error[] = [];
      const earlyProfile = {
        profileId: 'stdio-early',
        engine: 'codex' as const,
        home: join(root, 'home-stdio-early'),
        env: {
          FAKE_ENGINE_SCENARIO: scenarioPath,
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'stdio-early'),
          FAKE_CODEX_EXIT_EARLY: '1',
        },
      };
      await expect(
        codexDriver(root, { onDisconnect: (err) => earlyDisconnects.push(err) }).open({
          profile: earlyProfile,
          cwd: root,
        }),
      ).rejects.toThrow();
      await expect(
        codexDriver(root, {
          onDisconnect: (err) => earlyDisconnects.push(err),
        }).connectControl({
          profile: {
            ...earlyProfile,
            env: {
              ...earlyProfile.env,
              FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'stdio-early-c'),
            },
          },
          cwd: root,
        }),
      ).rejects.toThrow();
      expect(earlyDisconnects).toEqual([]);

      // 2. Failed open() (verifyThread throws) must NOT invoke onDisconnect.
      const failedDisconnects: Error[] = [];
      await expect(
        codexDriver(root, {
          onDisconnect: (err) => failedDisconnects.push(err),
          verifyThread: async () => {
            throw new Error('verify rejected');
          },
        }).open({
          profile: {
            profileId: 'fail-open',
            engine: 'codex',
            home: join(root, 'home-fail-open'),
            env: {
              FAKE_ENGINE_SCENARIO: scenarioPath,
              FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'fail-open'),
            },
          },
          cwd: root,
        }),
      ).rejects.toThrow(/verify rejected/);
      expect(failedDisconnects).toEqual([]);

      // 3. Real caller AbortController abort suppresses onDisconnect on both open() and connectControl().
      const abortDisconnects: Error[] = [];
      const openAc = new AbortController();
      const abortSession = await codexDriver(root, {
        onDisconnect: (err) => abortDisconnects.push(err),
      }).open({
        profile: {
          profileId: 'caller-abort-s',
          engine: 'codex',
          home: join(root, 'home-abort-s'),
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'caller-abort-s'),
          },
        },
        cwd: root,
        signal: openAc.signal,
      });
      try {
        openAc.abort(new Error('caller cancelled session'));
        await Bun.sleep(30);
      } finally {
        await abortSession.close();
      }
      const ctrlAc = new AbortController();
      const abortCtrl = await codexDriver(root, {
        onDisconnect: (err) => abortDisconnects.push(err),
      }).connectControl({
        profile: {
          profileId: 'caller-abort-c',
          engine: 'codex',
          home: join(root, 'home-abort-c'),
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'caller-abort-c'),
          },
        },
        cwd: root,
        signal: ctrlAc.signal,
      });
      try {
        ctrlAc.abort(new Error('caller cancelled control'));
        await Bun.sleep(30);
      } finally {
        await abortCtrl.close();
      }
      expect(abortDisconnects).toEqual([]);

      // 4. Closing OR abnormal server drop while holding an external pending request must NOT send `cancel`.
      const ownerSession = await codexDriver(root, {
        transport: { kind: 'unix-listen', socketPath, listenTimeoutMs: 5_000 },
      }).open({
        profile: {
          profileId: 'safety-owner',
          engine: 'codex',
          home,
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'safety-owner'),
            FAKE_CODEX_BROADCAST_TUI: '1',
          },
        },
        cwd: root,
      });
      trackProcess(ownerSession.providerPid);
      let dropObserver:
        | Awaited<ReturnType<ReturnType<typeof codexDriver>['connectControl']>>
        | undefined;
      try {
        let sawExternal = false;
        let sawDropExternal = false;
        const closeObserverDisconnects: Error[] = [];
        const dropObserverDisconnects: Error[] = [];
        const observerCtrl = await codexDriver(root, {
          transport: { kind: 'unix-connect', socketPath },
          onServerRequest: () => {
            sawExternal = true;
          },
          onDisconnect: (err) => closeObserverDisconnects.push(err),
        }).connectControl({
          profile: {
            profileId: 'safety-obs',
            engine: 'codex',
            home,
            env: { FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'safety-obs') },
          },
          cwd: root,
        });
        dropObserver = await codexDriver(root, {
          transport: { kind: 'unix-connect', socketPath },
          onServerRequest: () => {
            sawDropExternal = true;
          },
          onDisconnect: async (err) => {
            dropObserverDisconnects.push(err);
            throw new Error('disconnect observer boom');
          },
        }).connectControl({
          profile: {
            profileId: 'safety-obs-drop',
            engine: 'codex',
            home,
            env: { FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'safety-obs-drop') },
          },
          cwd: root,
        });
        try {
          const turn = await ownerSession.startTurn({
            turnId: 't-stay',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'go' }],
          });
          for (let i = 0; i < 40 && (!sawExternal || !sawDropExternal); i += 1) {
            await Bun.sleep(10);
          }
          expect(sawExternal).toBe(true);
          expect(sawDropExternal).toBe(true);
          // Intentional close suppresses onDisconnect and never sends cancel.
          await observerCtrl.close();
          expect(closeObserverDisconnects).toEqual([]);
          await Bun.sleep(30);
          const answeredFile = join(home, 'responses.jsonl');
          const responses = existsSync(answeredFile) ? await readJsonLines(answeredFile) : [];
          expect(responses).not.toContainEqual({
            id: 'ext-unanswered-1',
            result: { decision: 'cancel' },
          });
          // Abnormal server shutdown fires onDisconnect on unix-connect observer without sending cancel.
          await ownerSession.close();
          for (let i = 0; i < 40 && dropObserverDisconnects.length === 0; i += 1) {
            await Bun.sleep(10);
          }
          expect(dropObserverDisconnects).toHaveLength(1);
          const afterDrop = existsSync(answeredFile) ? await readJsonLines(answeredFile) : [];
          expect(afterDrop).not.toContainEqual({
            id: 'ext-unanswered-1',
            result: { decision: 'cancel' },
          });
          await drain(turn).catch(() => undefined);
        } finally {
          await observerCtrl.close();
        }
      } finally {
        await dropObserver?.close();
        await ownerSession.close();
      }
    }));

  test('Codex handlers enforce -32601 order, external pending cap 256, serverRequest/resolved cleanup, turn/completed ordering, observer error isolation, and humanCommand guard', async () => {
    const limits = new Map();
    const externalPending = new Map<string, PendingExternalCodexRequest>();
    let activeTurn: CodexTurnSlot | undefined;
    const notifications: Array<{
      method: string;
      duringActiveTurn: boolean;
      turnStillActiveInCallback: boolean;
      deltas: readonly ExecutorDelta[];
    }> = [];
    const seenRequests: Array<{ interactionId: string; method: string }> = [];
    let observerBehavior: 'hold' | 'sync-throw' | 'async-reject' | 'json-rpc-error' = 'hold';

    // 1. Without onServerRequest, known request outside turn throws -32601 BEFORE parsing params.
    const noObserverHandlers = createCodexHandlers({
      profileId: 'p',
      limits,
      externalPending: new Map(),
      getTurn: () => undefined,
      clearTurn: () => undefined,
    });
    expect(() =>
      noObserverHandlers.onRequest(
        'item/commandExecution/requestApproval',
        'malformed-not-object',
        'req-no-obs',
      ),
    ).toThrow(JsonRpcError);
    try {
      noObserverHandlers.onRequest(
        'item/commandExecution/requestApproval',
        'malformed-not-object',
        'req-no-obs',
      );
    } catch (error) {
      expect(error).toBeInstanceOf(JsonRpcError);
      expect((error as JsonRpcError).code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    }

    // 2. With onServerRequest configured, test unknown method (-32601), observer error isolation,
    //    serverRequest/resolved on unanswered external request, respond(), cap 256, and turn/completed order.
    const handlers = createCodexHandlers({
      profileId: 'p',
      limits,
      externalPending,
      getTurn: () => activeTurn,
      clearTurn: () => {
        activeTurn = undefined;
      },
      onNotification: async (ev) => {
        notifications.push({
          method: ev.method,
          duringActiveTurn: ev.duringActiveTurn,
          turnStillActiveInCallback: activeTurn !== undefined,
          deltas: ev.deltas,
        });
        throw new Error('notification async boom');
      },
      onServerRequest: (ev) => {
        seenRequests.push({ interactionId: ev.interactionId, method: ev.method });
        if (observerBehavior === 'sync-throw') throw new Error('secret host db password');
        if (observerBehavior === 'async-reject') {
          return Promise.reject(new Error('secret async failure'));
        }
        if (observerBehavior === 'json-rpc-error') {
          throw new JsonRpcError(-32001, 'explicit refusal');
        }
        return undefined;
      },
    });

    // Unknown method throws -32601 without invoking onServerRequest.
    try {
      handlers.onRequest('item/unknown/customRequest', {}, 'req-unknown');
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(JsonRpcError);
      expect((error as JsonRpcError).code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    }
    expect(seenRequests).toEqual([]);

    // Arbitrary sync throw and async rejection isolate error (no -32603 leak) and clear externalPending.
    observerBehavior = 'sync-throw';
    let syncSettled = false;
    void handlers
      .onRequest(
        'item/commandExecution/requestApproval',
        { itemId: 'c1', command: 'ls' },
        'req-sync-boom',
      )
      .then(
        () => {
          syncSettled = true;
        },
        () => {
          syncSettled = true;
        },
      );
    expect(externalPending.has('req-sync-boom')).toBe(false);

    observerBehavior = 'async-reject';
    let asyncSettled = false;
    void handlers
      .onRequest(
        'item/commandExecution/requestApproval',
        { itemId: 'c2', command: 'ls' },
        'req-async-boom',
      )
      .then(
        () => {
          asyncSettled = true;
        },
        () => {
          asyncSettled = true;
        },
      );
    await Bun.sleep(10);
    expect(externalPending.has('req-async-boom')).toBe(false);
    expect(syncSettled).toBe(false);
    expect(asyncSettled).toBe(false);

    // Explicit JsonRpcError IS forwarded cleanly and removes pending entry.
    observerBehavior = 'json-rpc-error';
    await expect(
      handlers.onRequest(
        'item/commandExecution/requestApproval',
        { itemId: 'c3', command: 'ls' },
        'req-rpc-err',
      ),
    ).rejects.toMatchObject({ code: -32001, message: 'explicit refusal' });
    expect(externalPending.has('req-rpc-err')).toBe(false);

    // Unanswered external request cleared by serverRequest/resolved emits request-resolved with external turnId.
    observerBehavior = 'hold';
    void handlers.onRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'c4', turnId: 'ext-turn-77', command: 'pwd' },
      'req-ext-resolve',
    );
    expect(externalPending.has('req-ext-resolve')).toBe(true);
    handlers.onNotification('serverRequest/resolved', { requestId: 'req-ext-resolve' });
    expect(externalPending.has('req-ext-resolve')).toBe(false);
    expect(notifications.at(-1)?.deltas).toEqual([
      {
        type: 'request-resolved',
        turnId: 'ext-turn-77',
        itemId: 'resolved:req-ext-resolve',
        raw: { source: 'codex', type: 'serverRequest/resolved' },
        interactionId: 'req-ext-resolve',
      },
    ]);
    expect(() =>
      answerCodexSessionRequest({
        turn: undefined,
        externalPending,
        interactionId: 'req-ext-resolve',
        reply: { kind: 'approve' },
      }),
    ).toThrow(TypeError);

    // External request answered through answerCodexSessionRequest resolves the RPC promise.
    const answeredPromise = handlers.onRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'c5', turnId: 'ext-turn-78', command: 'whoami' },
      'req-ext-ans',
    );
    answerCodexSessionRequest({
      turn: undefined,
      externalPending,
      interactionId: 'req-ext-ans',
      reply: { kind: 'approve', scope: 'session' },
    });
    expect(await answeredPromise).toEqual({ decision: 'acceptForSession' });

    // Duplicate interactionId refused with -32603 without overwriting existing entry.
    void handlers.onRequest(
      'item/commandExecution/requestApproval',
      { itemId: 'c6', command: 'id' },
      'req-dup',
    );
    expect(() =>
      handlers.onRequest(
        'item/commandExecution/requestApproval',
        { itemId: 'c7', command: 'id' },
        'req-dup',
      ),
    ).toThrow(/Duplicate pending/);

    // Cap 256 enforced before parsing params or invoking observer.
    for (let i = externalPending.size; i < 256; i += 1) {
      void handlers.onRequest(
        'item/commandExecution/requestApproval',
        { itemId: `cap-${i}`, command: 'true' },
        `req-cap-${i}`,
      );
    }
    const seenCountAtCap = seenRequests.length;
    expect(() =>
      handlers.onRequest('item/commandExecution/requestApproval', 'bad-params', 'req-cap-257'),
    ).toThrow(/limit 256/);
    expect(seenRequests.length).toBe(seenCountAtCap);
    externalPending.clear();

    // Active turn turn/completed invokes onNotification with duringActiveTurn: true AFTER clearTurn().
    activeTurn = {
      state: { turnId: 'local-t-1', interruptRequested: false },
      channel: createTurnDeltaChannel(),
      pending: new Map(),
    };
    handlers.onNotification('turn/completed', { turn: { id: 'ct-1', status: 'completed' } });
    expect(activeTurn).toBeUndefined();
    expect(notifications.at(-1)).toMatchObject({
      method: 'turn/completed',
      duringActiveTurn: true,
      turnStillActiveInCallback: false,
    });

    // humanCommand refuses acceptForSession EVEN IF availableDecisions erroneously lists acceptForSession.
    expect(() =>
      buildCodexRequestAnswer(
        {
          method: 'item/commandExecution/requestApproval',
          kind: 'humanCommand',
          availableDecisions: ['accept', 'acceptForSession'],
        },
        { kind: 'approve', scope: 'session' },
      ),
    ).toThrow(/humanCommand/);

    // item/permissions/requestApproval refuses deny.interrupt fail-closed (protocol has no cancel reply).
    expect(() =>
      buildCodexRequestAnswer(
        {
          method: 'item/permissions/requestApproval',
          kind: 'permissions',
          permissions: {},
        },
        { kind: 'deny', message: 'stop turn', interrupt: true },
      ),
    ).toThrow(TypeError);
  });

  test('Codex handles item/permissions/requestApproval and mcpServer/elicitation/request in active turns and external observers, refusing updatedInput fail-closed without deleting pending', () =>
    inScratch('codex-perms-elicit', async (root) => {
      const requestedPerms = {
        fileSystem: { read: ['/workspace/docs'], write: ['/workspace/out'] },
        network: { enabled: true },
      };
      const { session, home } = await codexSession(root, 'perms-elicit', [
        {
          do: 'emit',
          record: {
            id: 'cmd-upd-1',
            method: 'item/commandExecution/requestApproval',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              itemId: 'c-1',
              command: 'ls',
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'perm-1',
            method: 'item/permissions/requestApproval',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              itemId: 'p-1',
              cwd: root,
              permissions: requestedPerms,
              reason: 'Allow network and docs read',
              startedAtMs: 1795457925000,
              environmentId: 'env-local',
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'perm-deny',
            method: 'item/permissions/requestApproval',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              itemId: 'p-2',
              cwd: root,
              permissions: { network: { enabled: true } },
              startedAtMs: 1795457925001,
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'elicit-form',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'github-mcp',
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              mode: 'form',
              message: 'Provide repository owner',
              requestedSchema: {
                type: 'object',
                properties: { owner: { type: 'string' } },
                required: ['owner'],
              },
              _meta: { source: 'mcp' },
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'elicit-oai-slash',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'oai-mcp',
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              mode: 'openai/form',
              message: 'Approve action?',
              requestedSchema: { type: 'object', properties: {} },
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'elicit-oai-camel',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'oai-mcp-2',
              threadId: 'fake-thread',
              turnId: null,
              mode: 'openaiForm',
              message: 'Confirm release?',
              requestedSchema: { fields: [] },
            },
          },
        },
        { do: 'expect', type: 'response' },
        {
          do: 'emit',
          record: {
            id: 'elicit-url',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'oauth-mcp',
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              environmentId: 'env-oauth',
              mode: 'url',
              message: 'Sign in in browser',
              elicitationId: 'el-url-42',
              url: 'https://example.invalid/oauth',
            },
          },
        },
        { do: 'expect', type: 'response' },
        turnCompleted('completed'),
      ]);

      try {
        const turn = await session.startTurn({
          turnId: 't-pe',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'run' }],
        });
        for await (const delta of turn.deltas) {
          ExecutorDeltaSchema.parse(delta);
          if (delta.type !== 'request') continue;
          if (delta.interactionId === 'cmd-upd-1') {
            // updatedInput refused with TypeError BEFORE removing pending request!
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'approve',
                updatedInput: { command: 'echo hijacked' },
              }),
            ).rejects.toThrow(TypeError);
            // Request is still pending and can be legitimately approved afterwards.
            await turn.respond(delta.interactionId, { kind: 'approve' });
          } else if (delta.interactionId === 'perm-1') {
            expect(delta.kind).toBe('approval');
            expect(delta.callId).toBe('p-1');
            expect(delta.prompt).toBe('Allow network and docs read');
            expect(delta.input).toMatchObject({
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              cwd: root,
              permissions: requestedPerms,
              startedAtMs: 1795457925000,
              environmentId: 'env-local',
            });
            // Refuses updatedInput and input kind without deleting pending.
            await expect(
              turn.respond(delta.interactionId, {
                kind: 'approve',
                updatedInput: { permissions: {} },
              }),
            ).rejects.toThrow(TypeError);
            await expect(
              turn.respond(delta.interactionId, { kind: 'input', value: {} }),
            ).rejects.toThrow(TypeError);
            await turn.respond(delta.interactionId, { kind: 'approve', scope: 'session' });
          } else if (delta.interactionId === 'perm-deny') {
            await turn.respond(delta.interactionId, { kind: 'deny', message: 'no network' });
          } else if (delta.interactionId === 'elicit-form') {
            expect(delta.kind).toBe('input');
            expect(delta.toolName).toBe('github-mcp');
            expect(delta.prompt).toBe('Provide repository owner');
            expect(delta.input).toMatchObject({
              serverName: 'github-mcp',
              mode: 'form',
              _meta: { source: 'mcp' },
            });
            // Approve kind is refused without deleting pending.
            await expect(
              turn.respond(delta.interactionId, { kind: 'approve' }),
            ).rejects.toThrow(TypeError);
            await turn.respond(delta.interactionId, {
              kind: 'input',
              value: {
                action: 'accept',
                content: { owner: 'stitchkit' },
                _meta: { persist: 'once' },
              },
            });
          } else if (delta.interactionId === 'elicit-oai-slash') {
            expect(delta.input).toMatchObject({ mode: 'openai/form', serverName: 'oai-mcp' });
            await turn.respond(delta.interactionId, {
              kind: 'deny',
              message: 'user declined',
            });
          } else if (delta.interactionId === 'elicit-oai-camel') {
            expect(delta.input).toMatchObject({ mode: 'openaiForm', turnId: null });
            await turn.respond(delta.interactionId, {
              kind: 'input',
              value: { action: 'cancel' },
            });
          } else if (delta.interactionId === 'elicit-url') {
            expect(delta.kind).toBe('input');
            expect(delta.callId).toBe('el-url-42');
            expect(delta.input).toMatchObject({
              mode: 'url',
              elicitationId: 'el-url-42',
              url: 'https://example.invalid/oauth',
              environmentId: 'env-oauth',
            });
            // Safe refusal when host denies unsupported url mode -> cancel (never decline).
            await turn.respond(delta.interactionId, {
              kind: 'deny',
              message: 'url elicitation unsupported',
            });
          }
        }
        const responses = await readJsonLines(join(home, 'responses.jsonl'));
        expect(responses).toEqual([
          { id: 'cmd-upd-1', result: { decision: 'accept' } },
          { id: 'perm-1', result: { permissions: requestedPerms, scope: 'session' } },
          { id: 'perm-deny', result: { permissions: {} } },
          {
            id: 'elicit-form',
            result: {
              action: 'accept',
              content: { owner: 'stitchkit' },
              _meta: { persist: 'once' },
            },
          },
          { id: 'elicit-oai-slash', result: { action: 'decline' } },
          { id: 'elicit-oai-camel', result: { action: 'cancel' } },
          { id: 'elicit-url', result: { action: 'cancel' } },
        ]);
      } finally {
        await session.close();
      }

      // Interrupt while permissions approval and elicitation are pending sends {} and cancel.
      const { session: intSession, home: intHome } = await codexSession(root, 'pe-interrupt', [
        {
          do: 'emit',
          record: {
            id: 'perm-int',
            method: 'item/permissions/requestApproval',
            params: {
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              itemId: 'p-int',
              cwd: root,
              permissions: { network: { enabled: true } },
              startedAtMs: 1,
            },
          },
        },
        {
          do: 'emit',
          record: {
            id: 'elicit-int',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'srv',
              threadId: 'fake-thread',
              turnId: 'fake-turn',
              mode: 'url',
              message: 'Open URL',
              elicitationId: 'el-int',
              url: 'https://example.invalid',
            },
          },
        },
        { do: 'expect', type: 'response' },
        { do: 'expect', type: 'response' },
        { do: 'expect', type: 'turn/interrupt' },
        turnCompleted('interrupted'),
      ]);
      try {
        const intTurn = await intSession.startTurn({
          turnId: 't-int-pe',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'go' }],
        });
        let seenCount = 0;
        for await (const delta of intTurn.deltas) {
          if (delta.type === 'request') {
            seenCount += 1;
            if (seenCount === 2) await intTurn.interrupt();
          }
        }
        const intResponses = await readJsonLines(join(intHome, 'responses.jsonl'));
        expect(intResponses).toContainEqual({ id: 'perm-int', result: { permissions: {} } });
        expect(intResponses).toContainEqual({
          id: 'elicit-int',
          result: { action: 'cancel' },
        });
      } finally {
        await intSession.close();
      }

      // External onServerRequest path: permissions + elicitation + fail-closed updatedInput preserves externalPending.
      const externalPending = new Map<string, PendingExternalCodexRequest>();
      const externalEvents: Array<{
        interactionId: string;
        method: string;
        deltaKind: string;
      }> = [];
      const extHandlers = createCodexHandlers({
        profileId: 'ext-pe',
        limits: new Map(),
        externalPending,
        getTurn: () => undefined,
        clearTurn: () => undefined,
        onServerRequest: (ev) => {
          externalEvents.push({
            interactionId: ev.interactionId,
            method: ev.method,
            deltaKind: ev.delta.kind,
          });
        },
      });
      const extPermPromise = extHandlers.onRequest(
        'item/permissions/requestApproval',
        {
          threadId: 'ext-thr',
          turnId: 'ext-turn-1',
          itemId: 'ext-p1',
          cwd: root,
          permissions: { fileSystem: { read: ['/tmp'] } },
          startedAtMs: 123,
        },
        'ext-perm-1',
      );
      expect(() =>
        answerCodexSessionRequest({
          turn: undefined,
          externalPending,
          interactionId: 'ext-perm-1',
          reply: { kind: 'approve', updatedInput: { cwd: '/evil' } },
        }),
      ).toThrow(TypeError);
      expect(externalPending.has('ext-perm-1')).toBe(true);
      answerCodexSessionRequest({
        turn: undefined,
        externalPending,
        interactionId: 'ext-perm-1',
        reply: { kind: 'approve' },
      });
      expect(await extPermPromise).toEqual({
        permissions: { fileSystem: { read: ['/tmp'] } },
        scope: 'turn',
      });

      const extElicitPromise = extHandlers.onRequest(
        'mcpServer/elicitation/request',
        {
          serverName: 'ext-mcp',
          threadId: 'ext-thr',
          mode: 'url',
          message: 'Auth required',
          elicitationId: 'ext-el-1',
          url: 'https://example.invalid/auth',
        },
        'ext-elicit-1',
      );
      answerCodexSessionRequest({
        turn: undefined,
        externalPending,
        interactionId: 'ext-elicit-1',
        reply: { kind: 'deny', message: 'unsupported' },
      });
      expect(await extElicitPromise).toEqual({ action: 'cancel' });
      expect(externalEvents).toEqual([
        {
          interactionId: 'ext-perm-1',
          method: 'item/permissions/requestApproval',
          deltaKind: 'approval',
        },
        {
          interactionId: 'ext-elicit-1',
          method: 'mcpServer/elicitation/request',
          deltaKind: 'input',
        },
      ]);
    }));

  test('Codex exposes all 9 verified 0.171.0 thread RPCs with validation, session threadId defaults, capabilities, and untouched -32601 propagation on injectItems', () =>
    inScratch('codex-9-rpcs', async (root) => {
      const driver = codexDriver(root);
      expect(driver.capabilities).toMatchObject({
        revert: true,
        injectItems: true,
        updatedToolInput: false,
      });

      const scenarioPath = await writeScenario(root, []);
      const home = join(root, 'home-rpcs');
      const profile = {
        profileId: 'rpcs',
        engine: 'codex' as const,
        home,
        env: {
          FAKE_ENGINE_SCENARIO: scenarioPath,
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'rpcs'),
        },
      };

      // 1. Session defaults threadId to nativeThreadId for all 7 thread-scoped RPCs + listThreads / listLoadedThreads.
      const session = await driver.open({ profile, cwd: root });
      try {
        const reverted = await session.revertThread({ beforeTurnId: 'turn-2' });
        expect(reverted).toEqual({
          thread: { id: 'fake-thread', turns: [] },
          turnsBackwardsCursor: 'turns-back-1',
          itemsBackwardsCursor: 'items-back-1',
        });
        expect(
          await session.injectItems({
            items: [
              {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'ctx' }],
              },
            ],
          }),
        ).toEqual({});
        expect(await session.unsubscribeThread()).toEqual({ status: 'unsubscribed' });
        expect(
          await session.listThreads({
            cursor: 'c1',
            limit: 25,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            modelProviders: ['openai'],
            sourceKinds: ['cli', 'appServer'],
            archived: false,
            cwd: [root],
            searchTerm: 'demo',
            sectionId: null,
            includedThreadIds: Array.from({ length: 100 }, (_, i) => `thr-${i}`),
            excludedThreadIds: ['thr-excl-1'],
            originators: [],
            currentAccountOnly: true,
            useStateDbOnly: true,
          }),
        ).toMatchObject({ data: [{ id: 'fake-thread' }] });
        expect(await session.listLoadedThreads({ cursor: null, limit: 10 })).toEqual({
          data: ['fake-thread'],
          nextCursor: null,
        });
        expect(await session.archiveThread()).toEqual({});
        expect(await session.unarchiveThread()).toEqual({ thread: { id: 'fake-thread' } });
        expect(
          await session.updateThreadMetadata({
            gitInfo: { branch: 'main', originUrl: null, sha: 'abc123' },
          }),
        ).toEqual({ thread: { id: 'fake-thread' } });
        expect(await session.setThreadName({ name: 'My Thread' })).toEqual({});

        // Validation guards fail eagerly with TypeError before RPC.
        await expect(session.revertThread({ beforeTurnId: '   ' })).rejects.toThrow(TypeError);
        await expect(
          session.listThreads({
            includedThreadIds: Array.from({ length: 101 }, (_, i) => `t-${i}`),
          }),
        ).rejects.toThrow(/at most 100/);
        await expect(
          session.listThreads({
            excludedThreadIds: Array.from({ length: 101 }, (_, i) => `t-${i}`),
          }),
        ).rejects.toThrow(/at most 100/);
        await expect(session.listThreads({ includedThreadIds: [''] })).rejects.toThrow(
          TypeError,
        );
        await expect(session.listThreads({ limit: -1 })).rejects.toThrow(TypeError);
        await expect(session.listThreads({ limit: 0x1_0000_0000 })).rejects.toThrow(TypeError);
        await expect(session.listLoadedThreads({ limit: 0x1_0000_0000 })).rejects.toThrow(
          TypeError,
        );
        await expect(
          session.updateThreadMetadata({ gitInfo: { branch: '  ' } }),
        ).rejects.toThrow(TypeError);
        await expect(session.setThreadName({ name: '   ' })).rejects.toThrow(TypeError);
      } finally {
        await session.close();
      }

      const rpcCalls = await readJsonLines(join(home, 'rpc.jsonl'));
      expect(rpcCalls).toEqual([
        {
          method: 'thread/revert',
          params: { threadId: 'fake-thread', beforeTurnId: 'turn-2' },
        },
        {
          method: 'thread/inject_items',
          params: {
            threadId: 'fake-thread',
            items: [
              {
                type: 'message',
                role: 'developer',
                content: [{ type: 'input_text', text: 'ctx' }],
              },
            ],
          },
        },
        { method: 'thread/unsubscribe', params: { threadId: 'fake-thread' } },
        expect.objectContaining({
          method: 'thread/list',
          params: expect.objectContaining({
            limit: 25,
            sortKey: 'updated_at',
            sectionId: null,
            excludedThreadIds: ['thr-excl-1'],
            currentAccountOnly: true,
            useStateDbOnly: true,
          }),
        }),
        { method: 'thread/loaded/list', params: { cursor: null, limit: 10 } },
        { method: 'thread/archive', params: { threadId: 'fake-thread' } },
        { method: 'thread/unarchive', params: { threadId: 'fake-thread' } },
        {
          method: 'thread/metadata/update',
          params: {
            threadId: 'fake-thread',
            gitInfo: { branch: 'main', originUrl: null, sha: 'abc123' },
          },
        },
        { method: 'thread/name/set', params: { threadId: 'fake-thread', name: 'My Thread' } },
      ]);

      // 2. CodexControlConnection requires explicit threadId and propagates -32601 untouched on injectItems.
      const ctrl = await driver.connectControl({
        profile: {
          profileId: 'rpcs-ctrl',
          engine: 'codex',
          home: join(root, 'home-ctrl'),
          env: {
            FAKE_ENGINE_SCENARIO: scenarioPath,
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'rpcs-ctrl'),
            FAKE_CODEX_INJECT_UNSUPPORTED: '1',
          },
        },
        cwd: root,
      });
      try {
        await expect(ctrl.archiveThread({ threadId: '  ' })).rejects.toThrow(TypeError);
        expect(await ctrl.archiveThread({ threadId: 'thr-explicit' })).toEqual({});
        const injectErr = await ctrl
          .injectItems({ threadId: 'thr-explicit', items: [] })
          .catch((error: unknown) => error);
        expect(injectErr).toBeInstanceOf(JsonRpcError);
        expect(injectErr).toMatchObject({ code: JSON_RPC_METHOD_NOT_FOUND });
      } finally {
        await ctrl.close();
      }
    }));

  test('classifyCodexNotification classifies all 19 ThreadItem types, quiet 0.171.0 lifecycle notifications, and preserves unknown codexErrorInfo without crashing', () => {
    const state = { turnId: 't-cls', interruptRequested: false };

    // All 19 ThreadItem types of 0.171.0 produce zero false `unhandled` verdicts.
    const itemSamples: Record<string, Record<string, unknown>> = {
      userMessage: { type: 'userMessage', id: 'i-1', content: [] },
      hookPrompt: { type: 'hookPrompt', id: 'i-2', fragments: [] },
      agentMessage: { type: 'agentMessage', id: 'i-3', text: 'hi' },
      plan: { type: 'plan', id: 'i-4', text: 'step 1' },
      reasoning: { type: 'reasoning', id: 'i-5' },
      contextCompaction: { type: 'contextCompaction', id: 'i-6' },
      subAgentActivity: {
        type: 'subAgentActivity',
        id: 'i-7',
        agentPath: '/a',
        agentThreadId: 'sub-1',
        kind: 'started',
      },
      enteredReviewMode: { type: 'enteredReviewMode', id: 'i-8', review: 'pr-1' },
      exitedReviewMode: { type: 'exitedReviewMode', id: 'i-9', review: 'pr-1' },
      commandExecution: {
        type: 'commandExecution',
        id: 'i-10',
        command: 'ls',
        status: 'completed',
        aggregatedOutput: 'ok',
      },
      fileChange: { type: 'fileChange', id: 'i-11', status: 'completed', changes: [] },
      mcpToolCall: {
        type: 'mcpToolCall',
        id: 'i-12',
        server: 's',
        tool: 'fetch',
        arguments: {},
        status: 'completed',
        result: 'ok',
      },
      dynamicToolCall: {
        type: 'dynamicToolCall',
        id: 'i-13',
        tool: 'dyn',
        arguments: {},
        status: 'completed',
        contentItems: [],
      },
      collabAgentToolCall: {
        type: 'collabAgentToolCall',
        id: 'i-14',
        tool: 'spawnAgent',
        senderThreadId: 't0',
        receiverThreadIds: ['t1'],
        agentsStates: { t1: { status: 'running' } },
        status: 'completed',
      },
      webSearch: { type: 'webSearch', id: 'i-15', query: 'q', results: [] },
      imageView: { type: 'imageView', id: 'i-16', path: '/tmp/a.png' },
      sleep: { type: 'sleep', id: 'i-17', durationMs: 250 },
      imageGeneration: {
        type: 'imageGeneration',
        id: 'i-18',
        status: 'completed',
        savedPath: '/tmp/gen.png',
      },
      functionCallOutput: {
        type: 'functionCallOutput',
        id: 'i-19',
        name: 'custom_fn',
        output: { ok: true },
      },
    };
    expect(Object.keys(itemSamples)).toHaveLength(19);
    for (const [typeName, item] of Object.entries(itemSamples)) {
      const started = classifyCodexNotification('item/started', { item }, state);
      const completed = classifyCodexNotification('item/completed', { item }, state);
      if (CODEX_CONTENT_ITEMS.has(typeName)) {
        expect(started.kind, typeName).toBe('ignore');
        expect(completed.kind, typeName).toBe('ignore');
      } else {
        expect(CODEX_TOOL_ITEMS.has(typeName), typeName).toBe(true);
        expect(started.kind, typeName).toBe('deltas');
        expect(completed.kind, typeName).toBe('deltas');
        if (completed.kind === 'deltas') {
          expect(completed.deltas[0]).toMatchObject({
            type: 'tool-result',
            outcome: 'success',
          });
        }
      }
    }

    // Specific tool names and failed imageGeneration outcome.
    const collab = classifyCodexNotification(
      'item/started',
      { item: itemSamples.collabAgentToolCall },
      state,
    );
    expect(collab).toMatchObject({
      kind: 'deltas',
      deltas: [{ type: 'tool-call', toolName: 'spawnAgent' }],
    });
    const fnOut = classifyCodexNotification(
      'item/completed',
      { item: itemSamples.functionCallOutput },
      state,
    );
    expect(fnOut).toMatchObject({
      kind: 'deltas',
      deltas: [
        {
          type: 'tool-result',
          toolName: 'custom_fn',
          outcome: 'success',
          output: { ok: true },
        },
      ],
    });
    const imgFail = classifyCodexNotification(
      'item/completed',
      {
        item: {
          type: 'imageGeneration',
          id: 'i-18-fail',
          status: 'completed',
          failure: { message: 'policy blocked' },
        },
      },
      state,
    );
    expect(imgFail).toMatchObject({
      kind: 'deltas',
      deltas: [
        {
          type: 'tool-result',
          toolName: 'imageGeneration',
          outcome: 'error',
          output: { message: 'policy blocked' },
        },
      ],
    });

    // New 0.171.0 lifecycle notifications are ignored cleanly without false unhandled; unknown stays unhandled.
    for (const quietMethod of [
      'thread/reverted',
      'thread/archived',
      'thread/unarchived',
      'thread/closed',
      'item/commandExecution/terminalInteraction',
      'item/mcpToolCall/progress',
      'item/autoApprovalReview/started',
      'guardianWarning',
      'modelProvider/authRecoveryStarted',
    ]) {
      expect(classifyCodexNotification(quietMethod, {}, state).kind, quietMethod).toBe(
        'ignore',
      );
    }
    expect(classifyCodexNotification('future/unheardOfNotification', {}, state).kind).toBe(
      'unhandled',
    );

    // Negative controls: unknown codexErrorInfo (string & object) with empty or generic message never crashes and preserves the code.
    const emptyMsgUnknownString = classifyCodexNotification(
      'turn/completed',
      {
        turn: {
          id: 'turn-err-1',
          status: 'failed',
          error: { message: '', codexErrorInfo: 'futureExperimentalQuotaError' },
        },
      },
      state,
    );
    expect(emptyMsgUnknownString.kind).toBe('end');
    if (emptyMsgUnknownString.kind === 'end') {
      expect(emptyMsgUnknownString.deltas[0]).toMatchObject({
        type: 'error',
        kind: 'restartRecommended',
      });
      expect(
        emptyMsgUnknownString.deltas[0]?.type === 'error'
          ? emptyMsgUnknownString.deltas[0].message
          : '',
      ).toContain('futureExperimentalQuotaError');
    }

    const emptyMsgUnknownObject = classifyCodexNotification(
      'turn/completed',
      {
        turn: {
          id: 'turn-err-2',
          status: 'failed',
          error: {
            message: '   ',
            codexErrorInfo: { futureVendorFault: { reason: 'gpu_oom' } },
          },
        },
      },
      state,
    );
    expect(emptyMsgUnknownObject.kind).toBe('end');
    if (emptyMsgUnknownObject.kind === 'end') {
      const msg =
        emptyMsgUnknownObject.deltas[0]?.type === 'error'
          ? emptyMsgUnknownObject.deltas[0].message
          : '';
      expect(msg).toContain('futureVendorFault');
      expect(msg).toContain('gpu_oom');
    }

    const nonEmptyMsgUnknownCode = classifyCodexNotification(
      'turn/completed',
      {
        turn: {
          id: 'turn-err-3',
          status: 'failed',
          error: {
            message: 'Upstream rejected request',
            codexErrorInfo: 'brandNewVendorCode',
          },
        },
      },
      state,
    );
    expect(nonEmptyMsgUnknownCode.kind).toBe('end');
    if (nonEmptyMsgUnknownCode.kind === 'end') {
      const msg =
        nonEmptyMsgUnknownCode.deltas[0]?.type === 'error'
          ? nonEmptyMsgUnknownCode.deltas[0].message
          : '';
      expect(msg).toContain('Upstream rejected request');
      expect(msg).toContain('brandNewVendorCode');
    }
  });
});
