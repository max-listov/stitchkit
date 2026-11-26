/**
 * An engine connection: options checked before anything is spawned, a failed stop that hides
 * nothing, and a reader that fails in the background with nothing left unhandled.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acpFakeScenarios } from '../../src/agent-executor/acp/scenarios';
import { createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
import { openAcpSession } from '../../src/agent-executor/acp/v1-session';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { claudeFakeScenarios } from '../../src/agent-executor/claude/scenarios';
import { createCodexDriver } from '../../src/agent-executor/codex/driver';
import { codexFakeScenarios } from '../../src/agent-executor/codex/scenarios';
import { stopConnection } from '../../src/agent-executor/session-primitives';
import { NativeCommandError } from '../../src/entrypoints/process';
import { MAX_TIMER_MS } from '../../src/internal/timers';
import {
  ambientIn,
  countedSignal,
  drain,
  FAKE_CLAUDE,
  FAKE_CODEX,
  inScratch,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_ACP = fileURLToPath(new URL('../fixtures/fake-acp-agent.ts', import.meta.url));

test('an ACP option out of range is refused before the agent is spawned', async () => {
  for (const requestTimeoutMs of [0, 2.5, Number.NaN, MAX_TIMER_MS + 1]) {
    expect(() =>
      createAcpDriver({ executable: process.execPath, args: [FAKE_ACP], requestTimeoutMs }),
    ).toThrow(RangeError);
  }
  for (const bytes of [0, 1.5, Number.NaN]) {
    expect(() =>
      createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        maxFrameBytes: bytes,
      }),
    ).toThrow(TypeError);
    expect(() =>
      createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        maxImageBytes: bytes,
      }),
    ).toThrow(TypeError);
  }
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-acp-options-'));
  try {
    for (const requestTimeoutMs of [0, 2.5]) {
      const pidFile = join(root, `agent-${requestTimeoutMs}.pid`);
      trackPidFile(pidFile);
      await expect(
        openAcpSession(
          {
            executable: process.execPath,
            args: [FAKE_ACP],
            ambient: { PATH: process.env.PATH, HOME: root },
            requestTimeoutMs,
          },
          {
            profile: {
              profileId: 'p',
              engine: 'acp',
              home: join(root, 'home'),
              env: { FAKE_ENGINE_PID_FILE: pidFile },
            },
            cwd: root,
          },
        ),
      ).rejects.toThrow(RangeError);
      // An agent spawned before the refusal writes its pid well within this wait.
      await Bun.sleep(500);
      expect(existsSync(pidFile), `requestTimeoutMs ${requestTimeoutMs}`).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

/** Refuse every process-group kill, as a cleanup the system denies; `restore` kills what was refused. */
function refuseGroupKills() {
  const originalKill = process.kill;
  const refused = new Set<number>();
  const refusing: typeof process.kill = (pid, signal) => {
    if (pid < 0) {
      refused.add(-pid);
      throw Object.assign(new Error('group-cleanup-refused'), { code: 'EACCES' });
    }
    return originalKill(pid, signal);
  };
  process.kill = refusing;
  return {
    restore() {
      process.kill = originalKill;
      for (const group of refused) {
        try {
          originalKill(-group, 'SIGKILL');
        } catch {
          // Already gone.
        }
      }
    },
  };
}

test('a stop that fails keeps the failure that made the caller stop, and a probe keeps its answer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-acp-stop-'));
  const pidFile = join(root, 'agent.pid');
  trackPidFile(pidFile);
  const driver = createAcpDriver({
    executable: process.execPath,
    args: [FAKE_ACP],
    ambient: { PATH: process.env.PATH, HOME: root },
  });
  const kills = refuseGroupKills();
  try {
    const failed = await driver
      .open({
        profile: {
          profileId: 'p',
          engine: 'acp',
          home: join(root, 'home'),
          env: { FAKE_ACP_PROTOCOL: '0', FAKE_ENGINE_PID_FILE: pidFile },
        },
        cwd: root,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failed).toBeInstanceOf(AggregateError);
    expect(failed instanceof Error ? failed.cause : undefined).toMatchObject({
      message: expect.stringContaining('speaks protocol 0'),
    });
    const [, cleanup] = failed instanceof AggregateError ? failed.errors : [];
    expect(cleanup).toBeInstanceOf(NativeCommandError);
    expect(cleanup instanceof NativeCommandError ? cleanup.code : undefined).toBe(
      'COMMAND_CLEANUP',
    );
    // The probe's answer arrived before the stop failed: it is the answer.
    expect((await driver.info()).version).toBe('9.9.9');
  } finally {
    kills.restore();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

/** An engine that reads its first line and then writes a broken one, as each dialect speaks. */
const BROKEN_AFTER_START = {
  'claude-cli': `
    rl.once('line', () => process.stdout.write('{broken-json\\n'));
  `,
  codex: `
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const reply = (result) => process.stdout.write(JSON.stringify({ id: msg.id, result }) + '\\n');
      if (msg.method === 'initialize') reply({ userAgent: 'x' });
      else if (msg.method === 'thread/start') reply({ thread: { id: 'th-1' } });
      else if (msg.method === 'turn/start') {
        reply({ turn: { id: 'tu-1', status: 'inProgress', items: [] } });
        process.stdout.write('{broken-json\\n');
      }
    });
  `,
  acp: `
    rl.on('line', (line) => {
      const msg = JSON.parse(line);
      const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
      if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
      else if (msg.method === 'session/new') reply({ sessionId: 's-1' });
      else if (msg.method === 'session/prompt') process.stdout.write('{broken-json\\n');
    });
  `,
} as const;

function openBrokenEngine(
  name: keyof typeof BROKEN_AFTER_START,
  script: string,
  root: string,
) {
  const ambient = { PATH: process.env.PATH, HOME: root };
  const home = join(root, `home-${name}`);
  switch (name) {
    case 'claude-cli':
      return createClaudeCliDriver({
        executable: process.execPath,
        prefixArgs: [script],
        ambient,
      }).open({ profile: { profileId: 'p', engine: 'claude-cli', home }, cwd: root });
    case 'codex':
      return createCodexDriver({
        executable: process.execPath,
        prefixArgs: [script],
        ambient,
      }).open({
        profile: { profileId: 'p', engine: 'codex', home },
        cwd: root,
      });
    case 'acp':
      return createAcpDriver({ executable: process.execPath, args: [script], ambient }).open({
        profile: { profileId: 'p', engine: 'acp', home },
        cwd: root,
      });
  }
}

describe.each(['claude-cli', 'codex', 'acp'] as const)(
  '%s: the reader fails while a stop cannot clean up',
  (name) => {
    const unhandled: unknown[] = [];
    let turnFailed = false;
    let closeError: unknown;

    beforeAll(async () => {
      const root = await mkdtemp(join(tmpdir(), `stitchkit-cleanup-unhandled-${name}-`));
      const pidFile = join(root, `${name}.pid`);
      trackPidFile(pidFile);
      const script = join(root, `${name}-engine.cjs`);
      await writeFile(
        script,
        `const { writeFileSync } = require('node:fs');\n` +
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
          'setInterval(() => {}, 30000);\n' +
          `const rl = require('node:readline').createInterface({ input: process.stdin });\n` +
          BROKEN_AFTER_START[name],
      );
      const onUnhandled = (reason: unknown) => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      let kills: ReturnType<typeof refuseGroupKills> | undefined;
      try {
        const session = await openBrokenEngine(name, script, root);
        kills = refuseGroupKills();
        const turn = await session.startTurn({
          turnId: `t-${name}`,
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'hi' }],
        });
        turnFailed = await (async () => {
          for await (const _ of turn.deltas);
        })().then(
          () => false,
          () => true,
        );
        await Bun.sleep(150);
        closeError = await session.close().then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        kills?.restore();
        process.off('unhandledRejection', onUnhandled);
        await rm(root, { recursive: true, force: true });
      }
    }, 20_000);

    test('the turn fails and no rejection goes unhandled', () => {
      expect(turnFailed).toBe(true);
      expect(unhandled).toEqual([]);
    });

    test('close() surfaces the failed cleanup as COMMAND_CLEANUP', () => {
      expect(closeError).toBeInstanceOf(NativeCommandError);
      expect(closeError instanceof NativeCommandError ? closeError.code : undefined).toBe(
        'COMMAND_CLEANUP',
      );
    });
  },
);

describe('stopping a connection', () => {
  /** A connection whose stop settles at once, `stopped` or refused, and whose reader ends when told. */
  function connection(stop: () => Promise<void>) {
    const reader = Promise.withResolvers<void>();
    let read = false;
    return {
      connection: {
        engine: { stop },
        reading: reader.promise.then(() => {
          read = true;
        }),
      },
      endReader: () => reader.resolve(),
      read: () => read,
    };
  }

  test('waits for the reader after a stop that worked and after one that failed', async () => {
    for (const stop of [
      () => Promise.resolve(),
      () => Promise.reject(new Error('the group survived')),
    ]) {
      const { connection: stopping, endReader, read } = connection(stop);
      let settled = false;
      const stopped = stopConnection(stopping).then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Bun.sleep(20);
      expect(settled).toBe(false);
      endReader();
      await stopped;
      expect(read()).toBe(true);
    }
  });
});

describe('an engine that dies on its own', () => {
  const drivers = (root: string) => [
    {
      name: 'Claude CLI',
      driver: createClaudeCliDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CLAUDE],
        ambient: ambientIn(root),
      }),
      engine: 'claude-cli' as const,
      steps: claudeFakeScenarios.crash().steps,
    },
    {
      name: 'Codex',
      driver: createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: ambientIn(root),
      }),
      engine: 'codex' as const,
      steps: codexFakeScenarios.crash().steps,
    },
    {
      name: 'ACP',
      driver: createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        ambient: ambientIn(root),
      }),
      engine: 'acp' as const,
      steps: acpFakeScenarios.crash().steps,
    },
  ];

  test(
    'fails its turn and leaves no listener on the caller signal before close()',
    () =>
      inScratch('engine-died', async (root) => {
        for (const { name, driver, engine, steps } of drivers(root)) {
          const caller = countedSignal();
          const home = join(root, `home-${engine}`);
          const session = await driver.open({
            profile: {
              profileId: engine,
              engine,
              home,
              env: {
                FAKE_ENGINE_SCENARIO: await writeScenario(root, steps),
                FAKE_ENGINE_PID_FILE: trackedPidFile(root, engine),
                FAKE_ACP_HOME: home,
              },
            },
            cwd: root,
            signal: caller.signal,
          });
          try {
            const turn = await session.startTurn({
              turnId: 't',
              clientId: crypto.randomUUID(),
              input: [{ type: 'text', text: 'go' }],
            });
            await expect(drain(turn), name).rejects.toBeDefined();
            expect(caller.listeners(), name).toBe(0);
          } finally {
            await session.close();
          }
        }
      }),
    30_000,
  );
});
