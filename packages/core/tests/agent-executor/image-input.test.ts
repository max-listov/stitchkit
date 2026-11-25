/**
 * Image attachment support across Claude CLI, Claude Agent SDK, and Codex drivers:
 * ordered text+image encoding, plain-text wire compatibility, pre-send refusal without
 * partial dispatch, privacy (no host path or bytes in errors), abort/close hygiene, and
 * eager `maxImageBytes` validation.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createClaudeCliDriver } from '../../src/entrypoints/agent-executor/claude';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import { createCodexDriver } from '../../src/entrypoints/agent-executor/codex';
import {
  ambientIn,
  countedSignal,
  drain,
  FAKE_CLAUDE,
  FAKE_CODEX,
  inScratch,
  readJsonLines,
  recordedLines,
  trackedPidFile,
  writeScenario,
} from '../support/engine-driver-harness';
import { reapAfterEachTest } from '../support/process-reaper';

reapAfterEachTest();

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = Buffer.from(PNG_BYTES).toString('base64');

describe('agent-executor image input: Claude CLI, Claude SDK and Codex', () => {
  test.each([Number.NaN, 0, -1, 1.5])(
    'eagerly refuses invalid maxImageBytes %p on Claude CLI, Claude SDK and Codex',
    (maxImageBytes) => {
      expect(() => createClaudeCliDriver({ maxImageBytes })).toThrow(TypeError);
      expect(() =>
        createClaudeSdkDriver({
          query: () => {
            throw new Error('must not run');
          },
          sdkVersion: '0.0.0',
          maxImageBytes,
        }),
      ).toThrow(TypeError);
      expect(() => createCodexDriver({ maxImageBytes })).toThrow(TypeError);
    },
  );

  test('Claude CLI encodes ordered text+image blocks, preserves plain-text string, and refuses before send', () =>
    inScratch('claude-cli-images', async (root) => {
      const scenario = await writeScenario(root, [
        { do: 'expect', type: 'user' },
        { do: 'emit', record: { type: 'result', subtype: 'success', is_error: false } },
        { do: 'expect', type: 'user' },
        { do: 'emit', record: { type: 'result', subtype: 'success', is_error: false } },
      ]);
      const home = join(root, 'home');
      const secretRef = '/private/host/path/secret-image.png';
      const files = new Map<string, Uint8Array>([
        ['img-1', PNG_BYTES],
        ['big', new Uint8Array(128)],
        ['empty', new Uint8Array(0)],
      ]);
      const driver = createClaudeCliDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CLAUDE],
        ambient: ambientIn(root),
        maxImageBytes: 64,
        resolveFile: async (ref) => {
          if (ref === secretRef) throw new Error(`ENOENT: open ${secretRef}`);
          const found = files.get(ref);
          if (!found) throw new Error(`missing ${ref}`);
          return found;
        },
      });
      const profile = {
        profileId: 'cli-img',
        engine: 'claude-cli' as const,
        home,
        env: {
          FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'cli-img'),
          FAKE_ENGINE_SCENARIO: scenario,
        },
      };
      const session = await driver.open({ profile, cwd: root });
      try {
        // Refusal on 2nd image sends zero stdin frames and leaks neither ref nor host path
        const err = await session
          .startTurn({
            turnId: 't-fail',
            clientId: crypto.randomUUID(),
            input: [
              { type: 'text', text: 'before' },
              { type: 'file', mediaType: 'image/png', reference: 'img-1' },
              { type: 'file', mediaType: 'image/png', reference: secretRef },
            ],
          })
          .catch((failure: unknown) => failure);
        expect(err).toBeInstanceOf(Error);
        expect(String(err)).not.toContain(secretRef);
        expect(err instanceof Error ? err.cause : undefined).toBeUndefined();
        expect(await recordedLines(join(home, 'stdin.jsonl'))).toHaveLength(0);

        // Refusals: empty bytes, over maxImageBytes, unsupported MIME
        await expect(
          session.startTurn({
            turnId: 't-empty',
            clientId: crypto.randomUUID(),
            input: [{ type: 'file', mediaType: 'image/png', reference: 'empty' }],
          }),
        ).rejects.toThrow(/empty/i);
        await expect(
          session.startTurn({
            turnId: 't-big',
            clientId: crypto.randomUUID(),
            input: [{ type: 'file', mediaType: 'image/png', reference: 'big' }],
          }),
        ).rejects.toThrow(/over maxImageBytes 64/);
        await expect(
          session.startTurn({
            turnId: 't-pdf',
            clientId: crypto.randomUUID(),
            input: [{ type: 'file', mediaType: 'application/pdf', reference: 'img-1' }],
          }),
        ).rejects.toThrow(TypeError);
        expect(await recordedLines(join(home, 'stdin.jsonl'))).toHaveLength(0);

        // Ordered [text, image, text]
        const turn = await session.startTurn({
          turnId: 't-ok',
          clientId: crypto.randomUUID(),
          input: [
            { type: 'text', text: 'look:' },
            { type: 'file', mediaType: 'image/png', reference: 'img-1' },
            { type: 'text', text: 'describe' },
          ],
        });
        await drain(turn);

        // Plain-text turn stays a string (no content array wrapping)
        const textTurn = await session.startTurn({
          turnId: 't-plain',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'plain only' }],
        });
        await drain(textTurn);
      } finally {
        await session.close();
      }
      const sent = await readJsonLines(join(home, 'stdin.jsonl'));
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'look:' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
            },
            { type: 'text', text: 'describe' },
          ],
        },
      });
      expect(sent[1]).toMatchObject({
        type: 'user',
        message: { role: 'user', content: 'plain only' },
      });
    }));

  test('Claude SDK validates UUID before resolveFile, encodes image blocks, and releases caller signal on close', () =>
    inScratch('claude-sdk-images', async (root) => {
      const sent: SDKUserMessage[] = [];
      let resolveCalls = 0;
      let releasePending!: () => void;
      const pendingResolve = new Promise<Uint8Array>((resolve) => {
        releasePending = () => resolve(PNG_BYTES);
      });
      const driver = createClaudeSdkDriver({
        sdkVersion: '0.0.0-test',
        maxImageBytes: 64,
        resolveFile: async (ref) => {
          resolveCalls += 1;
          if (ref === 'hang') return pendingResolve;
          if (ref === 'too-big') return new Uint8Array(65);
          return PNG_BYTES;
        },
        query({ prompt }) {
          return {
            async interrupt() {
              // no-op
            },
            close() {
              // no-op
            },
            async *[Symbol.asyncIterator]() {
              for await (const msg of prompt) {
                sent.push(msg);
                yield { type: 'result', subtype: 'success', is_error: false };
              }
            },
          };
        },
      });
      const caller = countedSignal();
      const session = await driver.open({
        profile: { profileId: 'sdk', engine: 'claude-sdk', home: join(root, 'home') },
        cwd: root,
        signal: caller.signal,
      });

      // Invalid UUID refused BEFORE calling resolveFile
      await expect(
        session.startTurn({
          turnId: 't-bad-id',
          clientId: 'not-a-uuid',
          input: [{ type: 'file', mediaType: 'image/png', reference: 'ok' }],
        }),
      ).rejects.toThrow(/UUID/);
      expect(resolveCalls).toBe(0);

      // Text-only sends string content without requiring resolveFile
      const textOnlyDriver = createClaudeSdkDriver({
        sdkVersion: '0.0.0-test',
        query({ prompt }) {
          return {
            async interrupt() {
              // no-op
            },
            async *[Symbol.asyncIterator]() {
              for await (const msg of prompt) {
                sent.push(msg);
                yield { type: 'result', subtype: 'success', is_error: false };
              }
            },
          };
        },
      });
      const textSession = await textOnlyDriver.open({
        profile: { profileId: 'sdk-t', engine: 'claude-sdk', home: join(root, 'home2') },
        cwd: root,
      });
      await expect(
        textSession.startTurn({
          turnId: 't-no-resolver',
          clientId: crypto.randomUUID(),
          input: [{ type: 'file', mediaType: 'image/png', reference: 'x' }],
        }),
      ).rejects.toThrow(/resolveFile/);
      await drain(
        await textSession.startTurn({
          turnId: 't-txt',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'plain' }],
        }),
      );
      await textSession.close();
      expect(sent[0]?.message.content).toBe('plain');

      // Ordered image turn on SDK
      await expect(
        session.startTurn({
          turnId: 't-too-big',
          clientId: crypto.randomUUID(),
          input: [{ type: 'file', mediaType: 'image/png', reference: 'too-big' }],
        }),
      ).rejects.toThrow(RangeError);
      expect(sent).toHaveLength(1);

      await drain(
        await session.startTurn({
          turnId: 't-img',
          clientId: crypto.randomUUID(),
          input: [
            { type: 'text', text: 'first' },
            { type: 'file', mediaType: 'image/png', reference: 'ok' },
          ],
        }),
      );
      expect(sent[1]?.message.content).toEqual([
        { type: 'text', text: 'first' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: PNG_BASE64 },
        },
      ]);

      // Close while resolveFile is pending aborts wait, dispatches nothing, and detaches caller signal
      const inFlight = session.startTurn({
        turnId: 't-hang',
        clientId: crypto.randomUUID(),
        input: [{ type: 'file', mediaType: 'image/png', reference: 'hang' }],
      });
      await Promise.resolve();
      // Concurrent startTurn while preparing is refused
      await expect(
        session.startTurn({
          turnId: 't-concurrent',
          clientId: crypto.randomUUID(),
          input: [{ type: 'text', text: 'second' }],
        }),
      ).rejects.toThrow(/already running/i);
      await session.close();
      await expect(inFlight).rejects.toThrow();
      releasePending();
      expect(caller.listeners()).toBe(0);
      expect(sent).toHaveLength(2);
    }));

  test('Codex encodes ordered text+image UserInput with data URL and refuses invalid parts before turn/start', () =>
    inScratch('codex-images', async (root) => {
      const scenario = await writeScenario(root, [
        {
          do: 'emit',
          record: {
            method: 'turn/completed',
            params: { turn: { id: 'fake-turn', status: 'completed', items: [] } },
          },
        },
      ]);
      const home = join(root, 'home');
      let resolveCalls = 0;
      const driver = createCodexDriver({
        executable: process.execPath,
        prefixArgs: [FAKE_CODEX],
        ambient: ambientIn(root),
        maxImageBytes: 64,
        resolveFile: async (ref) => {
          resolveCalls += 1;
          if (ref === 'ok') return PNG_BYTES;
          if (ref === 'too-big') return new Uint8Array(65);
          throw new Error(`secret path ${ref}`);
        },
      });
      const session = await driver.open({
        profile: {
          profileId: 'codex-img',
          engine: 'codex',
          home,
          env: {
            FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'codex-img'),
            FAKE_ENGINE_SCENARIO: scenario,
          },
        },
        cwd: root,
      });
      try {
        // Pre-pass refuses invalid 2nd part BEFORE calling resolveFile on 1st part
        await expect(
          session.startTurn({
            turnId: 't-prepass',
            clientId: crypto.randomUUID(),
            input: [
              { type: 'file', mediaType: 'image/png', reference: 'ok' },
              { type: 'file', mediaType: 'application/pdf', reference: 'bad' },
            ],
          }),
        ).rejects.toThrow(TypeError);
        expect(resolveCalls).toBe(0);
        expect(await recordedLines(join(home, 'turn-start.jsonl'))).toHaveLength(0);

        // Exceeding maxImageBytes refuses with RangeError before turn/start
        await expect(
          session.startTurn({
            turnId: 't-too-big',
            clientId: crypto.randomUUID(),
            input: [{ type: 'file', mediaType: 'image/png', reference: 'too-big' }],
          }),
        ).rejects.toThrow(RangeError);
        expect(await recordedLines(join(home, 'turn-start.jsonl'))).toHaveLength(0);

        const turn = await session.startTurn({
          turnId: 't-ok',
          clientId: crypto.randomUUID(),
          input: [
            { type: 'text', text: 'check this' },
            { type: 'file', mediaType: 'image/png', reference: 'ok' },
            { type: 'text', text: 'done' },
          ],
        });
        await drain(turn);
      } finally {
        await session.close();
      }
      const turns = await readJsonLines(join(home, 'turn-start.jsonl'));
      expect(turns).toHaveLength(1);
      expect(turns[0]).toMatchObject({
        input: [
          { type: 'text', text: 'check this', text_elements: [] },
          { type: 'image', url: `data:image/png;base64,${PNG_BASE64}` },
          { type: 'text', text: 'done', text_elements: [] },
        ],
      });
    }));

  test(
    'Claude CLI enforces outgoing 8 MiB stdin frame ceiling and reads >8 MiB echoed stdout lines under 16 MiB cap',
    () =>
      inScratch('claude-cli-frame-ceilings', async (root) => {
        const scenario = await writeScenario(root, [
          { do: 'expect', type: 'user' },
          {
            do: 'emit',
            record: {
              type: 'user',
              uuid: 'echo-big',
              message: { role: 'user', content: 'e'.repeat(9 * 1024 * 1024) },
            },
          },
          { do: 'emit', record: { type: 'result', subtype: 'success', is_error: false } },
        ]);
        const home = join(root, 'home');
        const chunk = new Uint8Array(3 * 1024 * 1024).fill(0x41); // 4 MiB base64 each -> 2 images = >8 MiB frame
        const driver = createClaudeCliDriver({
          executable: process.execPath,
          prefixArgs: [FAKE_CLAUDE],
          ambient: ambientIn(root),
          maxImageBytes: 4 * 1024 * 1024,
          resolveFile: async () => chunk,
        });
        const session = await driver.open({
          profile: {
            profileId: 'claude-ceil',
            engine: 'claude-cli',
            home,
            env: {
              FAKE_ENGINE_PID_FILE: trackedPidFile(root, 'claude-ceil'),
              FAKE_ENGINE_SCENARIO: scenario,
            },
          },
          cwd: root,
        });
        try {
          // Two 3 MiB images fit maxImageBytes individually but exceed the 8 MiB outgoing stdin frame cap
          await expect(
            session.startTurn({
              turnId: 't-frame-too-big',
              clientId: crypto.randomUUID(),
              input: [
                { type: 'file', mediaType: 'image/png', reference: 'a' },
                { type: 'file', mediaType: 'image/png', reference: 'b' },
              ],
            }),
          ).rejects.toThrow(/frame limit/i);
          expect(await recordedLines(join(home, 'stdin.jsonl'))).toHaveLength(0);

          // Echoed 9 MiB stdout line succeeds under CLAUDE_CLI_MAX_LINE_BYTES (16 MiB)
          const okTurn = await session.startTurn({
            turnId: 't-big-echo',
            clientId: crypto.randomUUID(),
            input: [{ type: 'text', text: 'hello' }],
          });
          await drain(okTurn);
        } finally {
          await session.close();
        }
        expect(await readJsonLines(join(home, 'stdin.jsonl'))).toHaveLength(1);
      }),
    20_000,
  );
});
