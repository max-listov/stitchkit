import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { createTelegramLocalFiles, createTelegramOperatorChannel } from 'stitchkit/telegram';
import { z } from 'zod';
import { createBotApplication } from '../src/application';
import { createLog } from '../src/log';

/*
 * The bot's whole life against a stand-in for Telegram: it starts in graph
 * order, publishes its menu, answers, and stops cleanly — confirming exactly
 * the updates it handled.
 */

const Poll = z.object({ offset: z.number().optional(), timeout: z.number().optional() });

function fakeTelegram() {
  let queue: number[] = [];
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const offsets: number[] = [];
  let wake: (() => void) | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const method = new URL(request.url).pathname.split('/').pop() ?? '';
      const body = z
        .record(z.string(), z.unknown())
        .parse(await request.json().catch(() => ({})));
      calls.push({ method, body });
      if (method === 'getMe') {
        return Response.json({
          ok: true,
          result: { id: 1, is_bot: true, first_name: 'Bot', username: 'template_bot' },
        });
      }
      if (method !== 'getUpdates') return Response.json({ ok: true, result: true });
      const { offset = 0, timeout } = Poll.parse(body);
      offsets.push(offset);
      queue = queue.filter((id) => id >= offset);
      if (queue.length === 0 && timeout !== undefined) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          request.signal.addEventListener('abort', () => resolve());
          setTimeout(resolve, 200);
        });
      }
      const batch = timeout === undefined ? [] : [...queue];
      return Response.json({
        ok: true,
        result: batch.map((update_id) => ({
          update_id,
          message: {
            message_id: update_id,
            date: 0,
            chat: { id: 7, type: 'private', first_name: 'Ada' },
            from: { id: 7, is_bot: false, first_name: 'Ada' },
            text: '/start',
            entities: [{ type: 'bot_command', offset: 0, length: 6 }],
          },
        })),
      });
    },
  });
  return {
    origin: server.url.origin,
    calls,
    offsets,
    push(id: number) {
      queue.push(id);
      wake?.();
    },
    stop: () => server.stop(true),
  };
}

const servers: { stop(): void }[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt += 1) await Bun.sleep(5);
  expect(check()).toBe(true);
}

describe('the bot application', () => {
  test('starts in graph order, answers /start and stops cleanly', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const ended: unknown[] = [];
    const bot = new Bot('1:template', { client: { apiRoot: telegram.origin } });
    const app = createBotApplication({
      bot,
      databasePath: ':memory:',
      log: createLog({ LOG_LEVEL: 'info' }),
      onPollingEnded: (end) => void ended.push(end),
      shutdown: { gracePeriodMs: 2_000, forceTimeoutMs: 200 },
    });

    const snapshot = await app.start();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.resources.map((resource) => resource.id)).toEqual([
      'database',
      'telegram-configuration',
      'telegram-polling',
    ]);
    expect(telegram.calls.map((call) => call.method)).toContain('setMyCommands');

    telegram.push(5);
    await until(() => telegram.calls.some((call) => call.method === 'sendMessage'));
    expect(telegram.calls.find((call) => call.method === 'sendMessage')?.body).toMatchObject({
      chat_id: 7,
      text: 'Hello, Ada!',
    });

    const result = await app.shutdown();
    expect(result.outcome).toBe('clean');
    expect(Math.max(...telegram.offsets)).toBe(6);
    expect(ended).toEqual([]);
  });

  test('starts with an operators chat and local Bot API files, and the channel drains on the way down', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const root = await mkdtemp(join(tmpdir(), 'template-bot-files-'));
    directories.push(root);
    await mkdir(join(root, '1:template'));
    const bot = new Bot('1:template', { client: { apiRoot: telegram.origin } });
    const posted: string[] = [];
    const operators = createTelegramOperatorChannel<'users' | 'errors'>({
      chatId: -100,
      minIntervalMs: 1,
      send: async (message) => void posted.push(message.text),
    });
    const app = createBotApplication({
      bot,
      databasePath: ':memory:',
      log: createLog({ LOG_LEVEL: 'info' }),
      operators,
      files: createTelegramLocalFiles({ root, token: '1:template' }),
      onPollingEnded: () => undefined,
      shutdown: { gracePeriodMs: 2_000, forceTimeoutMs: 200 },
    });

    const snapshot = await app.start();
    expect(snapshot.ready).toBe(true);
    expect(snapshot.resources.map((resource) => resource.id)).toEqual([
      'database',
      'operator-channel',
      'telegram-files',
      'telegram-configuration',
      'telegram-polling',
    ]);
    // The bot waits for what it cannot answer without, never for the chat.
    expect(
      snapshot.resources.find((resource) => resource.id === 'telegram-configuration')
        ?.dependsOn,
    ).toEqual(['database', 'telegram-files']);
    telegram.push(8);
    await until(() => posted.length > 0);
    expect(posted).toEqual(['New user 7']);
    expect((await app.shutdown()).outcome).toBe('clean');
  });
});
