/**
 * Claude `findInput` regressions across both public drivers (`createClaudeCliDriver` and
 * `createClaudeSdkDriver`): full history past 64 MiB, user-only UUID matching, large image
 * turns (~7 MiB), empty lines, EOF without trailing LF, and fail-closed refusal on corrupt
 * or overlong lines when absence cannot be proven.
 */
import { describe, expect, test } from 'bun:test';
import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { claudeTranscriptPath } from '../../src/agent-executor/claude/transcript';
import { createLocalStepDurability } from '../../src/durability/engine';
import { dispatchTurn } from '../../src/entrypoints/agent-executor';
import { createClaudeCliDriver } from '../../src/entrypoints/agent-executor/claude';
import { createClaudeSdkDriver } from '../../src/entrypoints/agent-executor/claude-sdk';
import { createMemoryAgentRuntimeStore } from '../../src/entrypoints/agent-runtime';
import { EffectUnresolvedError } from '../../src/entrypoints/tools';
import { ambientIn, inScratch } from '../support/engine-driver-harness';

function writeTranscript(
  root: string,
  cwd: string,
  sessionId: string,
  lines: string[],
): string {
  const path = claudeTranscriptPath({ home: root, cwd, sessionId });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  return path;
}

const unusedSdkQuery = () => {
  throw new Error('findInput must not start an SDK query');
};

describe('Claude findInput full user history', () => {
  test(
    'finds old and new user UUIDs past 64 MiB and ignores assistant UUID in the same transcript',
    () =>
      inScratch('claude-find-64m', async (root) => {
        const cwd = '/probe';
        const sessionId = 'session';
        const transcript = claudeTranscriptPath({ home: root, cwd, sessionId });
        mkdirSync(dirname(transcript), { recursive: true });
        const fd = openSync(transcript, 'w');
        try {
          writeSync(
            fd,
            `${JSON.stringify({ type: 'user', uuid: 'old', message: { content: 'hi' } })}\n`,
          );
          const pad = 'a'.repeat(1024 * 1024);
          const filler = `${JSON.stringify({ type: 'assistant', uuid: 'pad', message: { content: pad } })}\n`;
          for (let i = 0; i < 65; i += 1) writeSync(fd, filler);
          writeSync(
            fd,
            `${JSON.stringify({ type: 'user', uuid: 'new', message: { content: 'later' } })}\n`,
          );
          writeSync(
            fd,
            `${JSON.stringify({ type: 'assistant', uuid: 'assistant', message: { content: 'reply' } })}\n`,
          );
        } finally {
          closeSync(fd);
        }

        const cli = createClaudeCliDriver({ ambient: ambientIn(root) });
        const sdk = createClaudeSdkDriver({ query: unusedSdkQuery, sdkVersion: '0.0.0-test' });
        for (const driver of [cli, sdk]) {
          const engine =
            driver.engine === 'claude-cli' ? ('claude-cli' as const) : ('claude-sdk' as const);
          const profile = { profileId: 'probe', engine, home: root };
          expect(
            await driver.findInput?.({
              profile,
              cwd,
              nativeThreadId: sessionId,
              clientId: 'old',
            }),
          ).toBe(true);
          expect(
            await driver.findInput?.({
              profile,
              cwd,
              nativeThreadId: sessionId,
              clientId: 'new',
            }),
          ).toBe(true);
          expect(
            await driver.findInput?.({
              profile,
              cwd,
              nativeThreadId: sessionId,
              clientId: 'assistant',
            }),
          ).toBe(false);
          expect(
            await driver.findInput?.({
              profile,
              cwd,
              nativeThreadId: sessionId,
              clientId: 'absent',
            }),
          ).toBe(false);
        }
      }),
    30_000,
  );

  test('accepts empty separator lines, CRLF, final record without LF, and ~7 MiB image user lines', () =>
    inScratch('claude-find-shapes', async (root) => {
      const cwd = '/probe';
      const sessionId = 'shapes';
      const bigBase64 = 'A'.repeat(7 * 1024 * 1024);
      writeTranscript(root, cwd, sessionId, [
        '',
        `${JSON.stringify({ type: 'user', uuid: 'img-user', message: { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigBase64 } }] } })}\r`,
        '',
        JSON.stringify({ type: 'user', uuid: 'tail-no-lf', message: { content: 'last' } }),
      ]);
      const sdk = createClaudeSdkDriver({ query: unusedSdkQuery, sdkVersion: '0.0.0-test' });
      const profile = { profileId: 'p', engine: 'claude-sdk' as const, home: root };
      expect(
        await sdk.findInput?.({
          profile,
          cwd,
          nativeThreadId: sessionId,
          clientId: 'img-user',
        }),
      ).toBe(true);
      expect(
        await sdk.findInput?.({
          profile,
          cwd,
          nativeThreadId: sessionId,
          clientId: 'tail-no-lf',
        }),
      ).toBe(true);
      expect(
        await sdk.findInput?.({ profile, cwd, nativeThreadId: sessionId, clientId: 'none' }),
      ).toBe(false);
    }));

  test(
    'missing transcript returns false, while corrupt JSON, user without uuid, or >16 MiB line refuses absence',
    () =>
      inScratch('claude-find-corrupt', async (root) => {
        const cwd = '/probe';
        const sdk = createClaudeSdkDriver({ query: unusedSdkQuery, sdkVersion: '0.0.0-test' });
        const profile = { profileId: 'p', engine: 'claude-sdk' as const, home: root };

        // Missing file -> false
        expect(
          await sdk.findInput?.({ profile, cwd, nativeThreadId: 'missing', clientId: 'any' }),
        ).toBe(false);

        // Corrupt JSON: match after corrupt still returns true, absent throws
        writeTranscript(root, cwd, 'corrupt', [
          '{"type":"user", broken',
          JSON.stringify({ type: 'user', uuid: 'present' }),
        ]);
        expect(
          await sdk.findInput?.({
            profile,
            cwd,
            nativeThreadId: 'corrupt',
            clientId: 'present',
          }),
        ).toBe(true);
        await expect(
          sdk.findInput?.({ profile, cwd, nativeThreadId: 'corrupt', clientId: 'absent' }),
        ).rejects.toThrow(/could not prove absence/i);

        // User record without string uuid -> throws on absent
        writeTranscript(root, cwd, 'no-uuid', [
          JSON.stringify({ type: 'user', message: { content: 'no id' } }),
        ]);
        await expect(
          sdk.findInput?.({ profile, cwd, nativeThreadId: 'no-uuid', clientId: 'absent' }),
        ).rejects.toThrow(/could not prove absence/i);

        // Overlong line (>16 MiB) -> match on another line returns true, absent throws
        const overlongPath = claudeTranscriptPath({ home: root, cwd, sessionId: 'overlong' });
        mkdirSync(dirname(overlongPath), { recursive: true });
        const fd = openSync(overlongPath, 'w');
        try {
          writeSync(fd, '{"type":"assistant","pad":"');
          const mb = 'b'.repeat(1024 * 1024);
          for (let i = 0; i < 17; i += 1) writeSync(fd, mb);
          writeSync(fd, '"}\n');
          writeSync(fd, `${JSON.stringify({ type: 'user', uuid: 'after-overlong' })}\n`);
        } finally {
          closeSync(fd);
        }
        expect(
          await sdk.findInput?.({
            profile,
            cwd,
            nativeThreadId: 'overlong',
            clientId: 'after-overlong',
          }),
        ).toBe(true);
        await expect(
          sdk.findInput?.({ profile, cwd, nativeThreadId: 'overlong', clientId: 'absent' }),
        ).rejects.toThrow(/16777216|record limit/i);

        // Multi-byte UTF-8 character straddling a 64 KiB read chunk boundary decodes cleanly
        const utf8Path = claudeTranscriptPath({ home: root, cwd, sessionId: 'utf8-boundary' });
        mkdirSync(dirname(utf8Path), { recursive: true });
        const prefix = '{"type":"assistant","pad":"';
        const padBytes = 65_535 - Buffer.byteLength(prefix); // puts a 4-byte emoji right across byte 65536
        const utf8Line = `${prefix}${'x'.repeat(padBytes)}🚀"}\n${JSON.stringify({ type: 'user', uuid: 'after-utf8-split' })}\n`;
        writeFileSync(utf8Path, utf8Line);
        expect(
          await sdk.findInput?.({
            profile,
            cwd,
            nativeThreadId: 'utf8-boundary',
            clientId: 'after-utf8-split',
          }),
        ).toBe(true);

        // Invalid UTF-8 bytes fail closed when absent, while a later valid user record still returns true
        const badUtf8Path = claudeTranscriptPath({ home: root, cwd, sessionId: 'bad-utf8' });
        mkdirSync(dirname(badUtf8Path), { recursive: true });
        writeFileSync(
          badUtf8Path,
          Buffer.concat([
            Buffer.from([0xff, 0xfe, 0x0a]),
            Buffer.from(`${JSON.stringify({ type: 'user', uuid: 'after-bad-utf8' })}\n`),
          ]),
        );
        expect(
          await sdk.findInput?.({
            profile,
            cwd,
            nativeThreadId: 'bad-utf8',
            clientId: 'after-bad-utf8',
          }),
        ).toBe(true);
        await expect(
          sdk.findInput?.({ profile, cwd, nativeThreadId: 'bad-utf8', clientId: 'absent' }),
        ).rejects.toThrow(/UTF-8|corrupt|invalid/i);
      }),
    30_000,
  );

  test('dispatchTurn never resends startTurn when transcript absence is unproven or false after restart', () =>
    inScratch('claude-dispatch-no-resend', async (root) => {
      const cwd = '/probe';
      const sessionId = 'dispatch-s';
      writeTranscript(root, cwd, sessionId, ['{"broken":']);
      const sdk = createClaudeSdkDriver({ query: unusedSdkQuery, sdkVersion: '0.0.0-test' });
      const profile = { profileId: 'p', engine: 'claude-sdk' as const, home: root };
      const store = createMemoryAgentRuntimeStore();
      // First attempt records intent, then crashes before completion.
      const beforeRestart = createLocalStepDurability({
        store,
        conversationId: 'conv-1',
        runId: 'run-1',
      });
      await expect(
        dispatchTurn({
          durability: beforeRestart,
          driver: sdk,
          session: {
            nativeThreadId: sessionId,
            async startTurn() {
              throw new Error('simulated crash mid-dispatch');
            },
            async close() {
              // no-op
            },
          },
          profile,
          cwd,
          turnId: 't1',
          input: [{ type: 'text', text: 'hello' }],
        }),
      ).rejects.toThrow(/simulated crash|unresolved/i);

      // Restarted executor reconciles against corrupt transcript -> EffectUnresolvedError, zero resend.
      const afterRestart = createLocalStepDurability({
        store,
        conversationId: 'conv-1',
        runId: 'run-1',
      });
      let started = 0;
      const outcome = await dispatchTurn({
        durability: afterRestart,
        driver: sdk,
        session: {
          nativeThreadId: sessionId,
          async startTurn() {
            started += 1;
            throw new Error('startTurn must not be called');
          },
          async close() {
            // no-op
          },
        },
        profile,
        cwd,
        turnId: 't1',
        input: [{ type: 'text', text: 'hello' }],
      }).catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(EffectUnresolvedError);
      expect(started).toBe(0);
    }));
});
