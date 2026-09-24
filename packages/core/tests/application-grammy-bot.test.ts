import { afterEach, describe, expect, test } from 'bun:test';
import { Bot, type BotConfig, type Context } from 'grammy';
import { z } from 'zod';
import {
  grammyBotResources,
  TELEGRAM_CONFIGURATION_RESOURCE_ID,
  TELEGRAM_POLLING_RESOURCE_ID,
} from '../src/application/grammy-bot';
import { createApplication } from '../src/application/kernel';
import type { ApplicationHandle } from '../src/application/kernel-contract';
import {
  defineManagedResource,
  type ManagedResourceContext,
} from '../src/application/resource';

/*
 * The real grammY polling loop — its offset, its sequential batches, its stop —
 * with only Telegram's HTTP endpoint replaced. The question every test asks is
 * the one a lost update answers badly: which offset did the process confirm?
 */

const botInfo: NonNullable<BotConfig<Context>['botInfo']> = {
  id: 1,
  is_bot: true,
  first_name: 'Fixture bot',
  username: 'fixture_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const PollRequest = z.object({
  offset: z.number().optional(),
  timeout: z.number().optional(),
});

interface Poll {
  readonly offset: number;
  readonly longPoll: boolean;
}

/** A Bot API that answers long polls from a queue the test fills. */
function fakeTelegram() {
  let queue: number[] = [];
  const polls: Poll[] = [];
  const methods: string[] = [];
  let waiting: (() => void) | undefined;
  let refuse: { status: number; description: string } | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const method = new URL(request.url).pathname.split('/').pop() ?? '';
      methods.push(method);
      if (method !== 'getUpdates') return Response.json({ ok: true, result: true });
      if (refuse) {
        return Response.json({
          ok: false,
          error_code: refuse.status,
          description: refuse.description,
        });
      }
      const { offset = 0, timeout } = PollRequest.parse(await request.json());
      polls.push({ offset, longPoll: timeout !== undefined });
      queue = queue.filter((id) => id >= offset);
      if (queue.length === 0 && timeout !== undefined) {
        await new Promise<void>((resolve) => {
          waiting = resolve;
          request.signal.addEventListener('abort', () => resolve());
          setTimeout(resolve, 200);
        });
        waiting = undefined;
      }
      const batch = timeout === undefined ? queue.slice(0, 1) : [...queue];
      return Response.json({
        ok: true,
        result: batch.map((update_id) => ({
          update_id,
          message: {
            message_id: update_id,
            date: 0,
            chat: { id: 7, type: 'private', first_name: 'Reader' },
            from: { id: 7, is_bot: false, first_name: 'Reader' },
            text: `update ${update_id}`,
          },
        })),
      });
    },
  });
  return {
    origin: server.url.origin,
    polls,
    methods,
    push(...ids: number[]) {
      queue.push(...ids);
      waiting?.();
    },
    refuse(status: number, description: string) {
      refuse = { status, description };
      waiting?.();
    },
    /** The highest offset any request confirmed — everything below it is gone from Telegram. */
    confirmed(): number {
      return Math.max(0, ...polls.map((poll) => poll.offset));
    },
    stop: () => server.stop(true),
  };
}

const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** One process of a bot: its own grammY instance over the shared fake Telegram. */
function botProcess(
  telegram: ReturnType<typeof fakeTelegram>,
  handle?: (id: number) => Promise<void>,
) {
  const bot = new Bot<Context>('1:fixture', { botInfo, client: { apiRoot: telegram.origin } });
  const handled: number[] = [];
  bot.on('message', async (ctx) => {
    await handle?.(ctx.update.update_id);
    handled.push(ctx.update.update_id);
  });
  let reportHealth: ManagedResourceContext['reportHealth'] = () => undefined;
  const database = defineManagedResource({
    id: 'database',
    start(context) {
      reportHealth = context.reportHealth;
    },
  });
  const ended: unknown[] = [];
  const errors: unknown[] = [];
  const telegramBot = grammyBotResources({
    bot,
    dependsOn: [database],
    polling: { timeout: 1 },
    onError: (error) => void errors.push(error),
    onEnded: (end) => void ended.push(end),
  });
  const app: ApplicationHandle = createApplication({
    id: 'fixture-bot',
    resources: [database, ...telegramBot.resources],
    shutdown: { gracePeriodMs: 2_000, forceTimeoutMs: 200 },
  });
  return {
    app,
    handled,
    ended,
    errors,
    degrade: () => reportHealth('unhealthy'),
    recover: () => reportHealth('healthy'),
  };
}

describe('grammyBotResources', () => {
  test('a poller that ended is one completion failure, and the shutdown onEnded starts is clean', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const bot = new Bot<Context>('1:fixture', {
      botInfo,
      client: { apiRoot: telegram.origin },
    });
    const failures: string[] = [];
    let stopped: Promise<{ outcome: string }> | undefined;
    const resources = grammyBotResources({
      bot,
      polling: { timeout: 1 },
      onEnded: () => {
        stopped = app.shutdown();
      },
    });
    const app: ApplicationHandle = createApplication({
      id: 'bot',
      resources: resources.resources,
      onResourceFailure: ({ resourceId, phase }) =>
        void failures.push(`${resourceId}:${phase}`),
    });
    await app.start();
    await until(() => telegram.polls.some((poll) => poll.longPoll), 'the first long poll');
    telegram.refuse(401, 'Unauthorized');
    await until(() => stopped !== undefined, 'onEnded');
    expect((await stopped)?.outcome).toBe('clean');
    expect(failures).toEqual(['telegram-polling:completion']);
  });

  test('stable resource ids, configuration before polling, both after the bot dependencies', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const bot = new Bot<Context>('1:fixture', {
      botInfo,
      client: { apiRoot: telegram.origin },
    });
    const order: string[] = [];
    const queues = defineManagedResource({
      id: 'queues',
      start: () => void order.push('queues'),
    });
    const http = defineManagedResource({
      id: 'http',
      dependsOn: [queues],
      start: () => void order.push('http'),
    });
    const resources = grammyBotResources({
      bot,
      dependsOn: [http],
      polling: { timeout: 1 },
      configure: async () => {
        order.push('configure');
        await bot.api.setMyCommands([{ command: 'start', description: 'Start' }]);
      },
      onStart: () => void order.push('polling'),
    });
    expect(resources.resources.map((resource) => resource.id)).toEqual([
      TELEGRAM_CONFIGURATION_RESOURCE_ID,
      TELEGRAM_POLLING_RESOURCE_ID,
    ]);
    const app = createApplication({
      id: 'bot',
      resources: [queues, http, ...resources.resources],
    });
    await app.start();
    expect(order).toEqual(['queues', 'http', 'configure', 'polling']);
    expect(telegram.methods).toContain('setMyCommands');
    const snapshot = app.getSnapshot();
    expect(snapshot.resources.find((r) => r.id === 'telegram-polling')?.dependsOn).toEqual([
      'telegram-configuration',
    ]);
    expect(
      snapshot.resources.find((r) => r.id === 'telegram-configuration')?.dependsOn,
    ).toEqual(['http']);
    expect((await app.shutdown()).outcome).toBe('clean');
  });

  test('a batch that arrives while the application is degraded is not confirmed, and the next process gets it', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const first = botProcess(telegram);
    await first.app.start();
    await until(() => telegram.polls.some((poll) => poll.longPoll), 'the first long poll');

    first.degrade();
    telegram.push(10);
    await Bun.sleep(50);
    expect(first.handled).toEqual([]);

    const result = await first.app.shutdown();
    expect(result.outcome).toBe('clean');
    expect(first.handled).toEqual([]);
    expect(telegram.confirmed()).toBeLessThanOrEqual(10);

    const next = botProcess(telegram);
    await next.app.start();
    await until(() => next.handled.length > 0, 'the next process to handle update 10');
    expect(next.handled).toEqual([10]);
    await next.app.shutdown();
  });

  test('no batch is fetched while degraded; recovery delivers what waited', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const bot = botProcess(telegram);
    await bot.app.start();
    await until(() => telegram.polls.length > 0, 'the first poll');
    bot.degrade();
    // Let the poll in flight finish empty; no new one may start while degraded.
    await Bun.sleep(250);
    const pollsWhileDegraded = telegram.polls.length;
    telegram.push(20);
    await Bun.sleep(100);
    expect(telegram.polls.length).toBe(pollsWhileDegraded);
    expect(bot.handled).toEqual([]);

    bot.recover();
    await until(() => bot.handled.length > 0, 'update 20 after recovery');
    expect(bot.handled).toEqual([20]);
    await bot.app.shutdown();
  });

  test('a batch admitted before shutdown is finished, and stop confirms all of it', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const gate = deferred();
    const started: number[] = [];
    const bot = botProcess(telegram, async (id) => {
      started.push(id);
      if (id === 30) await gate.promise;
    });
    await bot.app.start();
    await until(() => telegram.polls.some((poll) => poll.longPoll), 'the first long poll');
    telegram.push(30, 31);
    await until(() => started.includes(30), 'update 30 in its handler');

    const stopping = bot.app.shutdown();
    await Bun.sleep(30);
    // Admission is closed, and the batch in hand still holds its lease.
    expect(bot.app.getSnapshot().admission.pending).toBe(1);
    gate.resolve();
    const result = await stopping;

    expect(result.outcome).toBe('clean');
    expect(bot.handled).toEqual([30, 31]);
    expect(telegram.confirmed()).toBe(32);
  });

  test('polling that ends on its own after readiness is reported once to onEnded and onError; a requested stop is not', async () => {
    const telegram = fakeTelegram();
    servers.push(telegram);
    const bot = botProcess(telegram);
    await bot.app.start();
    await until(() => telegram.polls.some((poll) => poll.longPoll), 'the first long poll');
    telegram.refuse(409, 'Conflict: terminated by other getUpdates request');
    await until(() => bot.ended.length > 0, 'the end of polling');
    expect(bot.ended).toHaveLength(1);
    expect(bot.ended[0]).toMatchObject({ error: { error_code: 409 } });
    expect(bot.errors).toEqual([expect.objectContaining({ error_code: 409 })]);
    expect(bot.app.getSnapshot().ready).toBe(false);
    await bot.app.shutdown();
    expect(bot.ended).toHaveLength(1);

    const calm = fakeTelegram();
    servers.push(calm);
    const stopped = botProcess(calm);
    await stopped.app.start();
    await stopped.app.shutdown();
    expect(stopped.ended).toEqual([]);
  });
});
