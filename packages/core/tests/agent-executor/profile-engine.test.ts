/**
 * A profile names its engine, and a driver of another engine refuses it before it reads a file or
 * starts a process: its home lives under that engine's variable, so the engine would run on the
 * executor's own account and `status` would answer for that account.
 */
import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createAcpDriver } from '../../src/agent-executor/acp/v1-driver';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { claudeFakeScenarios } from '../../src/agent-executor/claude/scenarios';
import { createClaudeSdkDriver } from '../../src/agent-executor/claude-sdk/driver';
import { createCodexDriver } from '../../src/agent-executor/codex/driver';
import type { AgentEngineDriver } from '../../src/agent-executor/engine';
import type { ExecutorEngine } from '../../src/agent-executor/hello';
import type { ExecutorProfileConfig } from '../../src/agent-executor/profile';
import { fakeClaudeQuery } from '../fixtures/fake-claude-sdk';
import {
  ambientIn,
  FAKE_ACP,
  FAKE_CLAUDE,
  FAKE_CODEX,
  inScratch,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

/** Every driver method that takes a profile, called with `profile`. */
function profileCalls(driver: AgentEngineDriver, profile: ExecutorProfileConfig, cwd: string) {
  const calls: [string, () => Promise<unknown>][] = [
    ['status', () => driver.status(profile)],
    ['open', () => driver.open({ profile, cwd })],
  ];
  const { findInput } = driver;
  if (findInput !== undefined)
    calls.push([
      'findInput',
      () => findInput({ profile, cwd, nativeThreadId: 'thread', clientId: 'client' }),
    ]);
  if ('sessions' in driver && typeof driver.sessions === 'function') {
    const sessions = driver.sessions.bind(driver);
    calls.push(['sessions', () => sessions({ profile, cwd })]);
  }
  return calls;
}

test(
  'a driver refuses a profile of another engine before it starts the engine',
  () =>
    inScratch('profile-engine', async (root) => {
      const ambient = ambientIn(root);
      let queries = 0;
      const drivers: [AgentEngineDriver, ExecutorEngine][] = [
        [
          createClaudeCliDriver({
            executable: process.execPath,
            prefixArgs: [FAKE_CLAUDE],
            ambient,
          }),
          'codex',
        ],
        [
          createCodexDriver({
            executable: process.execPath,
            prefixArgs: [FAKE_CODEX],
            ambient,
          }),
          'claude-cli',
        ],
        [
          createAcpDriver({ executable: process.execPath, args: [FAKE_ACP], ambient }),
          'codex',
        ],
        [
          createClaudeSdkDriver({
            query: fakeClaudeQuery(claudeFakeScenarios.text('x'), () => {
              queries += 1;
            }),
            sdkVersion: '0.0.0',
            ambient,
          }),
          'claude-cli',
        ],
      ];
      const scenario = await writeScenario(root, claudeFakeScenarios.text('x').steps);
      const pidFiles: string[] = [];
      for (const [driver, foreign] of drivers) {
        const pidFile = trackedPidFile(root, driver.engine);
        pidFiles.push(pidFile);
        const home = join(root, `home-${driver.engine}`);
        const profile: ExecutorProfileConfig = {
          profileId: `for-${foreign}`,
          engine: foreign,
          home,
          env: {
            FAKE_ENGINE_SCENARIO: scenario,
            FAKE_ENGINE_PID_FILE: pidFile,
            FAKE_ACP_HOME: home,
          },
        };
        for (const [method, call] of profileCalls(driver, profile, root)) {
          const refused = await call().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(refused, `${driver.engine} ${method}`).toBeInstanceOf(TypeError);
          expect(String(refused), `${driver.engine} ${method}`).toContain(
            `this driver runs ${driver.engine}`,
          );
        }
      }
      // An engine started before the refusal writes its pid well within this wait.
      await Bun.sleep(500);
      for (const pidFile of pidFiles) expect(existsSync(pidFile), pidFile).toBe(false);
      expect(queries).toBe(0);
    }),
  30_000,
);

test(
  'a profile of the driver own engine still runs',
  () =>
    inScratch('profile-engine-own', async (root) => {
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: ambientIn(root),
      });
      const status = await driver.status({
        profileId: 'own',
        engine: 'codex',
        home: join(root, 'home'),
        env: { FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'own') },
      });
      expect(status.login).toEqual({ state: 'signed-in' });
    }),
  30_000,
);
