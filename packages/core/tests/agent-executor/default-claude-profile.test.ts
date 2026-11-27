import { expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CREDENTIAL_VARIABLES,
  ExecutorProfileConfigSchema,
  engineEnvironment,
} from '../../src/entrypoints/agent-executor';
import {
  claudeTranscriptPath,
  createClaudeCliDriver,
} from '../../src/entrypoints/agent-executor/claude';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import { createFakeClaudeSdkQuery } from '../../src/entrypoints/agent-executor/testing/claude-sdk';
import { ambientIn, inScratch, trackedPidFile } from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

test('default Claude sign-in reaches SDK queries and the CLI while the same explicit home stays selected', () =>
  inScratch('default-claude-profile', async (root) => {
    const home = join(root, '.claude');
    const ambient = {
      ...ambientIn(root),
      CLAUDE_CONFIG_DIR: join(root, 'other-account'),
      ...Object.fromEntries(CREDENTIAL_VARIABLES.map((name) => [name, 'ambient-sentinel'])),
    };
    const fake = createFakeClaudeSdkQuery();
    const sdkEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
    const sdk = createClaudeSdkDriver({
      sdkVersion: 'test',
      ambient,
      query(args) {
        if (!args.options?.env) throw new Error('SDK query lost its declared environment');
        sdkEnvs.push(args.options.env);
        return fake.query(args);
      },
    });
    const executable = join(root, 'auth-status.cjs');
    const report = join(root, 'environment.json');
    const pidFile = trackedPidFile(root, 'auth');
    await writeFile(
      executable,
      `const fs = require('node:fs');
      fs.writeFileSync(process.env.PID_FILE,String(process.pid));
      if(process.argv.slice(2).join(' ') !== 'auth status') process.exit(2);
      fs.writeFileSync(process.env.REPORT,JSON.stringify({dir:process.env.CLAUDE_CONFIG_DIR ?? null,
        credentials:${JSON.stringify(CREDENTIAL_VARIABLES)}.filter(name=>Object.hasOwn(process.env,name))}));
      console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai'}));`,
    );
    const cli = createClaudeCliDriver({
      executable: process.execPath,
      prefixArgs: [executable],
      ambient,
    });
    const sessionId = crypto.randomUUID();
    const transcript = claudeTranscriptPath({ home, cwd: root, sessionId });
    await mkdir(dirname(transcript), { recursive: true });
    await writeFile(
      transcript,
      `${JSON.stringify({ type: 'user', uuid: 'expected-input' })}\n`,
    );
    for (const mode of [{ claudeConfigDir: 'default' as const }, {}]) {
      const profile = {
        profileId: 'p',
        home,
        env: { REPORT: report, PID_FILE: pidFile },
        ...mode,
      };
      const expectedDir = 'claudeConfigDir' in mode ? undefined : home;
      await sdk.probeCapabilities({
        profile: { ...profile, engine: 'claude-sdk' },
        cwd: root,
      });
      const session = await sdk.open({
        profile: { ...profile, engine: 'claude-sdk' },
        cwd: root,
      });
      try {
        await session.accountInfo();
      } finally {
        await session.close();
      }
      expect(sdkEnvs).toHaveLength(2);
      for (const env of sdkEnvs.splice(0)) {
        expect(Object.hasOwn(env, 'CLAUDE_CONFIG_DIR')).toBe(expectedDir !== undefined);
        expect(env.CLAUDE_CONFIG_DIR).toBe(expectedDir);
        expect(CREDENTIAL_VARIABLES.filter((name) => Object.hasOwn(env, name))).toEqual([]);
      }
      expect((await cli.status({ ...profile, engine: 'claude-cli' })).login.state).toBe(
        'signed-in',
      );
      expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({
        dir: expectedDir ?? null,
        credentials: [],
      });
      for (const driver of [cli, sdk]) {
        expect(
          await driver.findInput?.({
            profile: { ...profile, engine: driver.engine },
            cwd: root,
            nativeThreadId: sessionId,
            clientId: 'expected-input',
          }),
        ).toBe(true);
        await expect(
          driver.findInput?.({
            profile: {
              ...profile,
              engine: driver.engine,
              claudeConfigDir: 'default',
              env: { HOME: join(root, 'different-user') },
            },
            cwd: root,
            nativeThreadId: sessionId,
            clientId: 'expected-input',
          }),
        ).rejects.toThrow(/profile home/);
      }
    }
  }));

test('the native Claude profile rejects competing directories and keeps Codex and ACP homes explicit', () => {
  const ambient = { HOME: '/users/signed-in', CLAUDE_CONFIG_DIR: '/other' };
  const config = {
    profileId: 'p',
    home: '/users/signed-in/.claude',
    claudeConfigDir: 'default' as const,
  };
  for (const engine of ['claude-cli', 'claude-sdk'] as const) {
    expect(() =>
      engineEnvironment({ ...config, engine, home: '.claude' }, { HOME: '.' }),
    ).toThrow(/profile home/);
    expect(
      engineEnvironment({ ...config, engine, home: join(homedir(), '.claude') }, {}),
    ).toEqual({ HOME: homedir() });
    for (const value of ['', config.home, '/other']) {
      expect(
        ExecutorProfileConfigSchema.safeParse({
          ...config,
          engine,
          env: { CLAUDE_CONFIG_DIR: value },
        }).success,
      ).toBe(false);
    }
    expect(() =>
      engineEnvironment({ ...config, engine, env: { HOME: '/other' } }, ambient),
    ).toThrow(/profile home/);
    expect(
      engineEnvironment(
        { ...config, engine, home: '/other/.claude', env: { HOME: '/other' } },
        ambient,
      ),
    ).toEqual({ HOME: '/other' });
  }
  for (const engine of ['codex', 'acp'] as const) {
    expect(ExecutorProfileConfigSchema.safeParse({ ...config, engine }).success).toBe(false);
    expect(
      engineEnvironment({ profileId: 'ordinary', engine, home: '/profiles/account' }, ambient),
    ).toEqual(
      engine === 'codex'
        ? { HOME: ambient.HOME, CODEX_HOME: '/profiles/account' }
        : { HOME: '/profiles/account' },
    );
  }
});
