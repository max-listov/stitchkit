import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineProcessCommandSpec } from '../../src/entrypoints/agent-executor';
import { createAcpDriver } from '../../src/entrypoints/agent-executor/acp';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import {
  createProcessSandbox,
  SandboxError,
} from '../../src/entrypoints/agent-runtime/sandbox';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_ACP = fileURLToPath(new URL('../fixtures/fake-acp-agent.ts', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../fixtures/fake-codex-engine.ts', import.meta.url));

const bwrapSupported =
  process.platform === 'linux' &&
  spawnSync('/usr/bin/bwrap', [
    '--unshare-all',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind-try',
    '/lib64',
    '/lib64',
    '--',
    '/usr/bin/true',
  ]).status === 0;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('agent-executor wrapCommand hook', () => {
  test('AcpDriverConfig.wrapCommand wraps process startup, preserves onProviderPid and clean close(), and fails closed on SANDBOX_UNAVAILABLE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-acp-wrap-'));
    try {
      const scenarioPath = join(root, 'scenario.json');
      const home = join(root, 'home');
      await mkdir(home, { recursive: true });
      await writeFile(
        scenarioPath,
        JSON.stringify({
          steps: [{ do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } }],
        }),
      );

      const seenCommands: EngineProcessCommandSpec[] = [];
      const pids: number[] = [];

      const driver = createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        ambient: { PATH: process.env.PATH, HOME: root },
        onProviderPid: (pid) => pids.push(pid),
        wrapCommand: async (command) => {
          seenCommands.push(command);
          return {
            ...command,
            env: { ...command.env, STITCHKIT_WRAPPED_MARKER: 'acp-wrapped' },
          };
        },
      });

      const session = await driver.open({
        profile: {
          profileId: 'p',
          engine: 'acp',
          home,
          env: { FAKE_ENGINE_SCENARIO: scenarioPath, FAKE_ACP_HOME: home },
        },
        cwd: root,
      });

      expect(seenCommands).toHaveLength(1);
      expect(seenCommands[0]?.executable).toBe(process.execPath);
      expect(pids).toHaveLength(1);
      expect(pids[0]).toBeGreaterThan(0);

      const turn = await session.startTurn({
        turnId: 't-1',
        clientId: crypto.randomUUID(),
        input: [{ type: 'text', text: 'hello' }],
      });
      const types: string[] = [];
      for await (const delta of turn.deltas) types.push(delta.type);
      expect(types).toContain('turn-end');

      await session.close();
      expect(isProcessAlive(pids[0] ?? -1)).toBe(false);

      // Fail-closed: unavailable sandbox prevents spawn cleanly.
      const failingSandbox = createProcessSandbox(
        {
          profile: 'workspace-strict',
          workspace: root,
          bwrapExecutable: '/nonexistent/missing-bwrap',
        },
        { platform: 'linux' },
      );
      const failingDriver = createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        wrapCommand: failingSandbox.wrapCommand,
      });
      let openError: unknown;
      try {
        await failingDriver.open({
          profile: { profileId: 'p', engine: 'acp', home },
          cwd: root,
        });
      } catch (error) {
        openError = error;
      }
      expect(openError).toBeInstanceOf(SandboxError);
      expect((openError as SandboxError).code).toBe('SANDBOX_UNAVAILABLE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('CodexDriverConfig.wrapCommand wraps app-server startup, preserves providerPid and clean close(), and fails closed when wrapCommand rejects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-codex-wrap-'));
    try {
      const scenarioPath = join(root, 'scenario.json');
      const home = join(root, 'home');
      await mkdir(home, { recursive: true });
      await writeFile(
        scenarioPath,
        JSON.stringify({
          steps: [
            {
              do: 'emit',
              record: {
                method: 'turn/completed',
                params: {
                  threadId: 'fake-thread',
                  turn: { id: 'fake-turn', status: 'completed', items: [] },
                },
              },
            },
          ],
        }),
      );

      const seenCommands: EngineProcessCommandSpec[] = [];
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: { PATH: process.env.PATH, HOME: root },
        wrapCommand: (command) => {
          seenCommands.push(command);
          return command;
        },
      });

      const session = await driver.open({
        profile: {
          profileId: 'p',
          engine: 'codex',
          home,
          env: { FAKE_ENGINE_SCENARIO: scenarioPath },
        },
        cwd: root,
      });

      expect(seenCommands).toHaveLength(1);
      expect(seenCommands[0]?.args).toContain('app-server');
      expect(session.providerPid).toBeGreaterThan(0);

      const turn = await session.startTurn({
        turnId: 't-1',
        clientId: crypto.randomUUID(),
        input: [{ type: 'text', text: 'hello' }],
      });
      const types: string[] = [];
      for await (const delta of turn.deltas) types.push(delta.type);
      expect(types).toContain('turn-end');

      const pid = session.providerPid ?? -1;
      await session.close();
      expect(isProcessAlive(pid)).toBe(false);

      const failingDriver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        wrapCommand: () => {
          throw new SandboxError('SANDBOX_UNAVAILABLE', 'sandbox denied');
        },
      });
      let openError: unknown;
      try {
        await failingDriver.open({
          profile: { profileId: 'p', engine: 'codex', home },
          cwd: root,
        });
      } catch (error) {
        openError = error;
      }
      expect(openError).toBeInstanceOf(SandboxError);
      expect((openError as SandboxError).code).toBe('SANDBOX_UNAVAILABLE');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(!bwrapSupported)(
    'createProcessSandbox.wrapCommand runs real Linux Bubblewrap around ACP and Codex drivers end-to-end',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'sk-exec-bwrap-'));
      try {
        const workspace = join(root, 'workspace');
        const binDir = join(root, 'bin');
        const acpHome = join(root, 'acp-home');
        const codexHome = join(root, 'codex-home');
        await mkdir(workspace, { recursive: true });
        await mkdir(binDir, { recursive: true });
        await mkdir(acpHome, { recursive: true });
        await mkdir(codexHome, { recursive: true });

        // Bundle fake engines into a self-contained read-only bin dir owned by the current user
        // so bwrap does not depend on traversing the host repository tree.
        const built = await Bun.build({
          entrypoints: [FAKE_ACP, FAKE_CODEX],
          outdir: binDir,
          target: 'bun',
        });
        expect(built.success).toBe(true);
        const bundledAcp = join(binDir, 'fake-acp-agent.js');
        const bundledCodex = join(binDir, 'fake-codex-engine.js');

        const acpScenario = join(workspace, 'acp-scenario.json');
        await writeFile(
          acpScenario,
          JSON.stringify({
            steps: [{ do: 'emit', record: { answerPrompt: { stopReason: 'end_turn' } } }],
          }),
        );
        const codexScenario = join(workspace, 'codex-scenario.json');
        await writeFile(
          codexScenario,
          JSON.stringify({
            steps: [
              {
                do: 'emit',
                record: {
                  method: 'turn/completed',
                  params: {
                    threadId: 'fake-thread',
                    turn: { id: 'fake-turn', status: 'completed', items: [] },
                  },
                },
              },
            ],
          }),
        );

        const sandbox = createProcessSandbox({
          profile: 'workspace-strict',
          workspace,
          writableDirs: [acpHome, codexHome],
          readOnlyPaths: [dirname(process.execPath), binDir],
          network: 'deny',
        });

        const acpPids: number[] = [];
        const acp = createAcpDriver({
          executable: process.execPath,
          args: [bundledAcp],
          ambient: { PATH: '/usr/bin:/bin', HOME: acpHome },
          onProviderPid: (pid) => acpPids.push(pid),
          wrapCommand: sandbox.wrapCommand,
        });
        const acpSession = await acp.open({
          profile: {
            profileId: 'acp-bwrap',
            engine: 'acp',
            home: acpHome,
            env: { FAKE_ENGINE_SCENARIO: acpScenario, FAKE_ACP_HOME: acpHome },
          },
          cwd: workspace,
        });
        const acpTurn = await acpSession.startTurn({
          turnId: 't-acp',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'inside bwrap' }],
        });
        const acpTypes: string[] = [];
        for await (const delta of acpTurn.deltas) acpTypes.push(delta.type);
        expect(acpTypes).toContain('turn-end');
        expect(acpPids[0]).toBeGreaterThan(0);
        await acpSession.close();
        expect(isProcessAlive(acpPids[0] ?? -1)).toBe(false);

        const codex = createCodexDriver({
          executable: process.execPath,
          prefixArgs: [bundledCodex],
          ambient: { PATH: '/usr/bin:/bin', HOME: codexHome },
          wrapCommand: sandbox.wrapCommand,
        });
        // Regression: info() and status() succeed under bwrap even when process.cwd() is outside workspace.
        expect(process.cwd()).not.toBe(workspace);
        const codexInfo = await codex.info();
        expect(codexInfo.version).toBe('9.9.9');
        const codexStatus = await codex.status({
          profileId: 'codex-bwrap',
          engine: 'codex',
          home: codexHome,
          env: { FAKE_ENGINE_SCENARIO: codexScenario },
        });
        expect(codexStatus.login.state).toBe('signed-in');
        expect(codexStatus.effectiveCredential).toBe('subscription');
        expect(codexStatus.planLimits?.answer).toBe('known');

        const codexSession = await codex.open({
          profile: {
            profileId: 'codex-bwrap',
            engine: 'codex',
            home: codexHome,
            env: { FAKE_ENGINE_SCENARIO: codexScenario },
          },
          cwd: workspace,
        });
        expect(codexSession.providerPid).toBeGreaterThan(0);
        const codexTurn = await codexSession.startTurn({
          turnId: 't-codex',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'inside bwrap' }],
        });
        const codexTypes: string[] = [];
        for await (const delta of codexTurn.deltas) codexTypes.push(delta.type);
        expect(codexTypes).toContain('turn-end');
        const codexPid = codexSession.providerPid ?? -1;
        await codexSession.close();
        expect(isProcessAlive(codexPid)).toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('open({ signal }) forwards signal into wrapCommand and aborts pending wrapping promptly for ACP and Codex', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sk-wrap-abort-'));
    try {
      const home = join(root, 'home');
      await mkdir(home, { recursive: true });

      const seenSignals: (AbortSignal | undefined)[] = [];
      const hangingWrap = async (command: EngineProcessCommandSpec) => {
        seenSignals.push(command.signal);
        return await new Promise<EngineProcessCommandSpec>((_resolve, reject) => {
          command.signal?.addEventListener('abort', () => reject(command.signal?.reason), {
            once: true,
          });
        });
      };

      const acpController = new AbortController();
      const acpDriver = createAcpDriver({
        executable: process.execPath,
        args: [FAKE_ACP],
        wrapCommand: hangingWrap,
      });
      const acpReason = new Error('acp-open-cancelled');
      const acpOpen = acpDriver.open({
        profile: { profileId: 'p', engine: 'acp', home },
        cwd: root,
        signal: acpController.signal,
      });
      acpController.abort(acpReason);
      await expect(acpOpen).rejects.toBe(acpReason);

      const codexController = new AbortController();
      const codexDriver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        wrapCommand: hangingWrap,
      });
      const codexReason = new Error('codex-open-cancelled');
      const codexOpen = codexDriver.open({
        profile: { profileId: 'p', engine: 'codex', home },
        cwd: root,
        signal: codexController.signal,
      });
      codexController.abort(codexReason);
      await expect(codexOpen).rejects.toBe(codexReason);

      expect(seenSignals).toHaveLength(2);
      expect(
        seenSignals.every((signal) => signal instanceof AbortSignal && signal.aborted),
      ).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
