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
  type CodexDriverConfig,
  createCodexDriver,
} from '../../src/agent-executor/codex/driver';
import { codexPlanWindows } from '../../src/agent-executor/codex/limits';
import {
  CodexUnixSocketError,
  connectCodexUnixSocket,
} from '../../src/agent-executor/codex/unix-socket';
import { createWsFrameDecoder } from '../../src/agent-executor/codex/ws-frame';
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
});
