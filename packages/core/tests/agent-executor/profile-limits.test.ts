/** An engine sees the allowlist and its profile's declarations only; limits keep three answers. */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { claudePlanWindows } from '../../src/agent-executor/claude/limits';
import { codexPlanWindows } from '../../src/agent-executor/codex/limits';
import {
  mergeRateLimitEvent,
  planLimitsDue,
  planLimitsReadFailed,
  planWindowExpired,
} from '../../src/agent-executor/plan-limits';
import {
  CREDENTIAL_VARIABLES,
  engineEnvironment,
  helloProfile,
} from '../../src/agent-executor/profile';
import { isTerminalTurnPhase } from '../../src/agent-executor/turn-phases';
import { ExecutorHelloSchema } from '../../src/entrypoints/agent-executor';
import { runNativeCommand } from '../../src/entrypoints/process';
import { reapAfterEachTest, trackGroupLeader, trackPidFile } from '../support/process-reaper';

reapAfterEachTest();

const FAKE_CLAUDE = fileURLToPath(
  new URL('../fixtures/fake-claude-engine.ts', import.meta.url),
);

const sentinels = Object.fromEntries(
  CREDENTIAL_VARIABLES.map((name) => [name, `sentinel-${name}`]),
);

describe('the engine environment', () => {
  test('a spawned engine prints no credential of the executor, and gets its profile home', async () => {
    const env = engineEnvironment(
      { profileId: 'p', engine: 'claude-cli', home: '/profiles/p' },
      {
        PATH: process.env.PATH,
        HOME: '/home/someone',
        LC_ALL: 'C',
        SECRET_OTHER: 'x',
        ...sentinels,
      },
    );
    const result = await runNativeCommand({
      executable: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      env,
      envPolicy: 'declared-only',
      capture: true,
      maxOutputBytes: 1 << 20,
      timeoutMs: 10_000,
      onLeaderStarted: trackGroupLeader,
    });
    const seen = new TextDecoder().decode(result.stdout);
    for (const value of Object.values(sentinels)) expect(seen).not.toContain(value);
    expect(seen).not.toContain('SECRET_OTHER');
    expect(JSON.parse(seen)).toMatchObject({ CLAUDE_CONFIG_DIR: '/profiles/p', LC_ALL: 'C' });
  });

  test('a hello of a profile whose home holds a token carries no token, no path and no value', async () => {
    const home = await mkdtemp(join(tmpdir(), 'stitchkit-profile-'));
    try {
      await writeFile(
        join(home, '.credentials.json'),
        JSON.stringify({ token: 'sentinel-token-in-file' }),
      );
      const profile = helloProfile({
        profile: { profileId: 'p', engine: 'claude-cli', home, accountLabel: 'Work' },
        status: { login: { state: 'signed-in' }, effectiveCredential: 'subscription' },
        ambient: { ANTHROPIC_API_KEY: 'sentinel-ambient-key' },
      });
      const text = JSON.stringify(
        ExecutorHelloSchema.parse({
          protocol: 1,
          instance: 'i',
          executorId: 'e',
          engines: [],
          profiles: [profile],
          resumable: [],
        }),
      );
      expect(text).not.toContain('sentinel');
      expect(text).not.toContain(home);
      expect(profile.accountLabel).toBe('Work');
      expect(profile.ownCredentials).toEqual(['ANTHROPIC_API_KEY']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('plan limits', () => {
  const now = new Date('2026-11-24T00:00:00.000Z');
  test('known, unpublished and a failed read are three answers, not one', () => {
    const known = mergeRateLimitEvent({
      windows: claudePlanWindows({
        rateLimitType: 'seven_day',
        unifiedWindows: { seven_day: { utilization: 0.78, resetsAt: 1796032800 } },
      }),
      now,
    });
    expect(known).toMatchObject({
      answer: 'known',
      windows: [{ name: 'seven_day', usedPercent: 78 }],
    });
    expect(mergeRateLimitEvent({ windows: claudePlanWindows({}), now }).answer).toBe(
      'unpublished',
    );
    const failed = planLimitsReadFailed({ previous: known, error: 'read timed out', now });
    expect(failed).toMatchObject({
      answer: 'known',
      error: 'read timed out',
      windows: known.windows,
    });
    expect(planLimitsReadFailed({ error: 'no answer', now })).toMatchObject({
      answer: 'unpublished',
    });
  });

  test('planWindowExpired and planLimitsDue check reset timestamps, age bounds, and reject invalid maxAgeMs', () => {
    expect(planWindowExpired({ name: 'five_hour', usedPercent: 50 }, now)).toBe(false);
    expect(
      planWindowExpired(
        { name: 'five_hour', usedPercent: 50, resetsAt: '2026-11-23T23:59:59.000Z' },
        now,
      ),
    ).toBe(true);
    expect(
      planWindowExpired(
        { name: 'five_hour', usedPercent: 50, resetsAt: '2026-11-24T00:00:00.000Z' },
        now,
      ),
    ).toBe(true);
    expect(
      planWindowExpired(
        { name: 'five_hour', usedPercent: 50, resetsAt: '2026-11-24T01:00:00.000Z' },
        now,
      ),
    ).toBe(false);

    expect(planLimitsDue({ now, maxAgeMs: 60_000 })).toBe(true);
    const fresh = mergeRateLimitEvent({
      windows: [{ name: 'five_hour', usedPercent: 10, resetsAt: '2026-11-24T05:00:00.000Z' }],
      now,
    });
    expect(
      planLimitsDue({
        limits: fresh,
        now: new Date(now.getTime() + 30_000),
        maxAgeMs: 60_000,
      }),
    ).toBe(false);
    expect(
      planLimitsDue({
        limits: fresh,
        now: new Date(now.getTime() + 60_000),
        maxAgeMs: 60_000,
      }),
    ).toBe(true);
    expect(planLimitsDue({ limits: fresh, now, maxAgeMs: 0 })).toBe(true);
    const expired = mergeRateLimitEvent({
      windows: [{ name: 'five_hour', usedPercent: 10, resetsAt: '2026-11-23T23:00:00.000Z' }],
      now,
    });
    expect(planLimitsDue({ limits: expired, now, maxAgeMs: 3_600_000 })).toBe(true);

    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => planLimitsDue({ limits: fresh, now, maxAgeMs: bad })).toThrow(RangeError);
    }
  });

  test('isTerminalTurnPhase classifies every turn phase accurately', () => {
    for (const active of ['leased', 'dispatching', 'delivered'] as const) {
      expect(isTerminalTurnPhase(active)).toBe(false);
    }
    for (const terminal of [
      'completed',
      'interrupted',
      'failed',
      'unknown',
      'unknown_after_restart',
    ] as const) {
      expect(isTerminalTurnPhase(terminal)).toBe(true);
    }
  });

  test('out-of-range resetsAt (1e16) is omitted safely and loginExpiresAt is read only as the ISO time the CLI writes', async () => {
    expect(
      claudePlanWindows({ unifiedWindows: { weekly: { utilization: 0.4, resetsAt: 1e16 } } }),
    ).toEqual([{ name: 'weekly', usedPercent: 40 }]);
    expect(codexPlanWindows({ primary: { usedPercent: 15, resetsAt: 1e16 } })).toEqual([
      { name: 'primary', usedPercent: 15 },
    ]);

    const root = await mkdtemp(join(tmpdir(), 'stitchkit-login-expiry-'));
    try {
      const driver = createClaudeCliDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CLAUDE],
        ambient: { PATH: process.env.PATH, HOME: root },
      });
      const trackedPidFile = (name: string) => {
        const pidFile = join(root, `${name}.pid`);
        trackPidFile(pidFile);
        return pidFile;
      };
      const state = async (name: string, loginExpiresAt: unknown) =>
        (
          await driver.status({
            profileId: 'p',
            engine: 'claude-cli',
            home: join(root, name),
            env: {
              FAKE_ENGINE_PID_FILE: trackedPidFile(name),
              FAKE_CLAUDE_AUTH_STATUS: JSON.stringify({
                loggedIn: true,
                authMethod: 'claude.ai',
                loginExpiresAt,
              }),
            },
          })
        ).login.state;
      // The form Claude Code 2.1.331 writes: an ISO time in UTC with milliseconds.
      expect(await state('future', new Date(Date.now() + 3_600_000).toISOString())).toBe(
        'signed-in',
      );
      expect(await state('past', new Date(Date.now() - 3_600_000).toISOString())).toBe(
        'expired',
      );
      expect(await state('none', null)).toBe('signed-in');
      // A form the CLI was not seen to write is not guessed at: epoch seconds or milliseconds.
      expect(await state('seconds', Math.floor(Date.now() / 1000) + 3600)).toBe('unknown');
      expect(await state('milliseconds', Date.now() + 3_600_000)).toBe('unknown');
      expect(await state('date-only', '2999-01-01')).toBe('unknown');
      expect(await state('invalid', 'invalid-date-string')).toBe('unknown');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
