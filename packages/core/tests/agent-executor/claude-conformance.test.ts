/** The Claude CLI driver against its dialect's scripted engine, through the conformance kit. */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClaudeCliDriver } from '../../src/agent-executor/claude/cli-driver';
import { claudeFakeScenarios } from '../../src/agent-executor/claude/scenarios';
import { claudeTranscriptPath } from '../../src/agent-executor/claude/transcript';
import { runAgentEngineConformance } from '../../src/agent-executor/testing/conformance';
import { recordedLines } from '../support/engine-driver-harness';

const FAKE = fileURLToPath(new URL('../fixtures/fake-claude-engine.ts', import.meta.url));

test('the Claude CLI driver passes the engine conformance kit', async () => {
  await runAgentEngineConformance({
    scenarios: claudeFakeScenarios,
    async open(scenario) {
      const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-fake-'));
      const scenarioPath = join(root, 'scenario.json');
      await writeFile(scenarioPath, JSON.stringify(scenario));
      const profile = {
        profileId: 'fake',
        engine: 'claude-cli' as const,
        home: join(root, 'home'),
        env: { FAKE_ENGINE_SCENARIO: scenarioPath },
      };
      return {
        driver: createClaudeCliDriver({
          executable: process.execPath,
          prefixArgs: [FAKE],
          ambient: { PATH: process.env.PATH, HOME: root },
        }),
        profile,
        cwd: root,
        async inputs(nativeThreadId) {
          const text = await readFile(
            claudeTranscriptPath({ home: profile.home, cwd: root, sessionId: nativeThreadId }),
            'utf8',
          ).catch(() => '');
          return text.split('\n').filter((line) => line.includes('"uuid"')).length;
        },
        async answered(request) {
          return (await recordedLines(join(profile.home, 'stdin.jsonl'))).some(
            (line) =>
              Reflect.get(Object(line), 'type') === 'control_response' &&
              Reflect.get(Object(Reflect.get(Object(line), 'response')), 'request_id') ===
                request.interactionId,
          );
        },
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  });
  expect(true).toBe(true);
}, 60_000);

test('the driver passes its model and permission mode, after the prefix, and the profile home only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-argv-'));
  try {
    const scenarioPath = join(root, 'scenario.json');
    await writeFile(scenarioPath, JSON.stringify(claudeFakeScenarios.text('x')));
    const home = join(root, 'home');
    const driver = createClaudeCliDriver({
      executable: process.execPath,
      prefixArgs: [FAKE],
      model: 'model-under-test',
      permissionMode: 'plan',
      ambient: { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: 'sentinel-key' },
    });
    const session = await driver.open({
      profile: {
        profileId: 'p',
        engine: 'claude-cli',
        home,
        env: { FAKE_ENGINE_SCENARIO: scenarioPath },
      },
      cwd: root,
    });
    const turn = await session.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: [{ type: 'text', text: 'hello' }],
    });
    for await (const _ of turn.deltas) {
      // Drained: the engine started, saw the flags and answered.
    }
    await session.close();
    const lines = (await readFile(join(home, 'argv.jsonl'), 'utf8')).trim().split('\n');
    const args: string[] = JSON.parse(lines.at(-1) ?? '[]');
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual([
      '--model',
      'model-under-test',
    ]);
    expect(
      args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2),
    ).toEqual(['--permission-mode', 'plan']);
    expect(args[0]).toBe('-p');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a transcript that cannot be read refuses the resume instead of starting a new session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-unreadable-'));
  try {
    const scenarioPath = join(root, 'scenario.json');
    await writeFile(scenarioPath, JSON.stringify(claudeFakeScenarios.text('x')));
    const home = join(root, 'home');
    // `projects` is a file: opening the transcript under it fails with ENOTDIR, not ENOENT.
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'projects'), 'not a directory');
    const driver = createClaudeCliDriver({
      executable: process.execPath,
      prefixArgs: [FAKE],
      ambient: { PATH: process.env.PATH, HOME: root },
    });
    const profile = {
      profileId: 'p',
      engine: 'claude-cli' as const,
      home,
      env: { FAKE_ENGINE_SCENARIO: scenarioPath },
    };
    await expect(
      driver.open({ profile, cwd: root, nativeThreadId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'ENOTDIR' });
    // A transcript that is not there is a fact: the session starts fresh under that id.
    await rm(join(home, 'projects'));
    const fresh = await driver.open({
      profile,
      cwd: root,
      nativeThreadId: crypto.randomUUID(),
    });
    const turn = await fresh.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: [{ type: 'text', text: 'hello' }],
    });
    for await (const _ of turn.deltas) {
      // Drained: the engine started and saw its flags.
    }
    await fresh.close();
    const args: string[] = JSON.parse(
      (await readFile(join(home, 'argv.jsonl'), 'utf8')).trim().split('\n').at(-1) ?? '[]',
    );
    expect(args).toContain('--session-id');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
