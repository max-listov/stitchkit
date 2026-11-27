/** The Agent SDK leaf against a scripted `query`, through the conformance kit, on Claude's scenarios. */
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { forkSession, query } from '@anthropic-ai/claude-agent-sdk';
import { claudeFakeScenarios } from '../../src/agent-executor/claude/scenarios';
import { claudeTranscriptPath } from '../../src/agent-executor/claude/transcript';
import {
  type ClaudeSdkForkSession,
  type ClaudeSdkQuery,
  createClaudeSdkDriver,
} from '../../src/agent-executor/claude-sdk/driver';
import { runAgentEngineConformance } from '../../src/agent-executor/testing/conformance';
import { fakeClaudeQuery } from '../fixtures/fake-claude-sdk';
import { recordedLines } from '../support/engine-driver-harness';

// The SDK's own `query` and `forkSession` fit the injected types as they are: checked by `tsc`.
export function sdkQueryFits(sdk: typeof query): ClaudeSdkQuery {
  return sdk;
}
export function sdkForkSessionFits(sdkFork: typeof forkSession): ClaudeSdkForkSession {
  return sdkFork;
}

test('the Agent SDK leaf passes the engine conformance kit', async () => {
  await runAgentEngineConformance({
    scenarios: claudeFakeScenarios,
    async open(scenario) {
      const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-sdk-fake-'));
      const profile = {
        profileId: 'fake',
        engine: 'claude-sdk' as const,
        home: join(root, 'home'),
      };
      return {
        driver: createClaudeSdkDriver({
          query: fakeClaudeQuery(scenario),
          sdkVersion: '0.3.330',
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
        // The SDK names its permission by the tool call it guards, which the request carries.
        async answered(request) {
          return (await recordedLines(join(profile.home, 'permissions.jsonl'))).some(
            (line) => Reflect.get(Object(line), 'toolUseId') === request.callId,
          );
        },
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  });
  expect(true).toBe(true);
}, 60_000);

test('the leaf passes its model, permission mode and the profile environment to the query, and reports its SDK version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-sdk-options-'));
  try {
    const seen: unknown[] = [];
    const driver = createClaudeSdkDriver({
      query: fakeClaudeQuery(claudeFakeScenarios.text('x'), (options) => seen.push(options)),
      sdkVersion: '0.3.330',
      model: 'model-under-test',
      permissionMode: 'plan',
      ambient: { PATH: process.env.PATH, HOME: root, ANTHROPIC_API_KEY: 'sentinel-key' },
    });
    expect((await driver.info()).version).toBe('0.3.330');
    const session = await driver.open({
      profile: { profileId: 'p', engine: 'claude-sdk', home: join(root, 'home') },
      cwd: root,
    });
    const turn = await session.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: [{ type: 'text', text: 'hi' }],
    });
    for await (const _ of turn.deltas) {
      // Drained: the query was opened with its options.
    }
    await session.close();
    expect(seen[0]).toMatchObject({
      model: 'model-under-test',
      permissionMode: 'plan',
      cwd: root,
      env: { CLAUDE_CONFIG_DIR: join(root, 'home') },
    });
    expect(JSON.stringify(seen[0])).not.toContain('sentinel-key');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupt denies a permission the SDK still waits on', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-sdk-interrupt-'));
  try {
    const answers: unknown[] = [];
    const driver = createClaudeSdkDriver({
      sdkVersion: '0.3.330',
      ambient: { PATH: process.env.PATH, HOME: root },
      query: ({ options }) => {
        const stop = Promise.withResolvers<void>();
        async function* run(): AsyncGenerator<unknown> {
          answers.push(
            await options?.canUseTool?.(
              'Write',
              { path: 'x' },
              { signal: new AbortController().signal, toolUseID: 'u', requestId: 'r' },
            ),
          );
          await stop.promise;
          yield {
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            terminal_reason: 'aborted_streaming',
          };
        }
        const records = run();
        return {
          [Symbol.asyncIterator]: () => records,
          interrupt: async () => {
            stop.resolve();
          },
        };
      },
    });
    const session = await driver.open({
      profile: { profileId: 'p', engine: 'claude-sdk', home: join(root, 'home') },
      cwd: root,
    });
    const turn = await session.startTurn({
      turnId: 't',
      clientId: crypto.randomUUID(),
      input: [{ type: 'text', text: 'hi' }],
    });
    const ends: string[] = [];
    for await (const delta of turn.deltas) {
      if (delta.type === 'request') await turn.interrupt();
      if (delta.type === 'turn-end') ends.push(delta.outcome);
    }
    await session.close();
    expect(answers).toEqual([
      { behavior: 'deny', message: 'The turn was interrupted', interrupt: true },
    ]);
    expect(ends).toEqual(['interrupted']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const persisted of [true, false])
  test(`a query that breaks fails its turn, and the next turn ${persisted ? 'resumes the session it wrote' : 'starts afresh when it wrote nothing'}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'stitchkit-claude-sdk-reopen-'));
    try {
      const home = join(root, 'home');
      const opened: { resume?: string; sessionId?: string }[] = [];
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.3.330',
        ambient: { PATH: process.env.PATH, HOME: root },
        query: ({ prompt, options }) => {
          opened.push({
            ...(options?.resume !== undefined && { resume: options.resume }),
            ...(options?.sessionId !== undefined && { sessionId: options.sessionId }),
          });
          const first = opened.length === 1;
          async function* run(): AsyncGenerator<unknown> {
            for await (const message of prompt) {
              if (first) {
                // Claude Code persists the user message before it works on it — or dies first.
                const sessionId = options?.sessionId ?? '';
                if (persisted) {
                  const transcript = claudeTranscriptPath({ home, cwd: root, sessionId });
                  await mkdir(dirname(transcript), { recursive: true });
                  await writeFile(transcript, `${JSON.stringify({ type: 'user' })}\n`);
                }
                throw new Error('Claude Code process exited with code 137');
              }
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 's',
                result: 'back',
                uuid: message.uuid,
              };
            }
          }
          const records = run();
          return { [Symbol.asyncIterator]: () => records, interrupt: async () => undefined };
        },
      });
      const session = await driver.open({
        profile: { profileId: 'p', engine: 'claude-sdk', home },
        cwd: root,
      });
      const broken = await session.startTurn({
        turnId: 't1',
        clientId: crypto.randomUUID(),
        input: [{ type: 'text', text: 'one' }],
      });
      await expect(
        (async () => {
          for await (const _ of broken.deltas) {
            // Drained until the break.
          }
        })(),
      ).rejects.toThrow('code 137');
      const next = await session.startTurn({
        turnId: 't2',
        clientId: crypto.randomUUID(),
        input: [{ type: 'text', text: 'two' }],
      });
      const ends: string[] = [];
      for await (const delta of next.deltas)
        if (delta.type === 'turn-end') ends.push(delta.outcome);
      await session.close();
      expect(ends).toEqual(['completed']);
      // Resuming a conversation Claude Code never wrote fails every later query ("No conversation
      // found"), so the second query resumes only when the transcript exists.
      expect(opened).toEqual([
        { sessionId: session.nativeThreadId },
        persisted ? { resume: session.nativeThreadId } : { sessionId: session.nativeThreadId },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
