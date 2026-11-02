/**
 * A 429 names a chat: Telegram words a group's limit and the bot's own limit
 * alike, and only the addressee tells them apart. So one chat's refusal holds
 * that chat, several at once hold the token, and a call may refuse to queue
 * past a stated wait. The loopback case sends through grammY and a real socket.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Api } from 'grammy';
import {
  classifyTelegramSendFailure,
  telegramOutboundBudget,
} from '../src/entrypoints/telegram';
import { telegramBudgetTransformer } from '../src/entrypoints/telegram/grammy';
import { createManualClock } from '../src/entrypoints/testing';
import { manualBudget, refusal } from './support/telegram-budget-clock';

const limited = (seconds: number) =>
  refusal(429, `Too Many Requests: retry after ${seconds}`, seconds);

const refuse =
  (seconds: number): (() => Promise<never>) =>
  async () => {
    throw limited(seconds);
  };

describe('Telegram outbound budget, chat scope', () => {
  test('one chat waits out its 429 while the others of the token go on', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    await budget
      .run('sendMessage', { chat_id: -100 }, undefined, refuse(40))
      .catch(() => undefined);
    expect(budget.stats()).toMatchObject({ pausedForMs: 0, pausedChats: 1 });

    const sent: string[] = [];
    const group = budget.run('sendMessage', { chat_id: -100 }, undefined, async () => {
      sent.push('group');
    });
    const person = budget.run('sendMessage', { chat_id: 7 }, undefined, async () => {
      sent.push('person');
    });
    const campaign = budget.run(
      'sendMessage',
      { chat_id: 8 },
      undefined,
      async () => {
        sent.push('campaign');
      },
      { lane: 'bulk' },
    );
    await clock.advance(1_000);
    expect(sent).toEqual(['person', 'campaign']);
    await clock.advance(39_000);
    await group;
    await Promise.all([person, campaign]);
    expect(sent).toEqual(['person', 'campaign', 'group']);
    expect(budget.stats().pausedChats).toBe(0);
  });

  test('a call arriving while the drain sleeps on a pause does not sleep with it', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    await budget
      .run('sendMessage', { chat_id: -100 }, undefined, refuse(40))
      .catch(() => undefined);
    void budget.run('sendMessage', { chat_id: -100 }, undefined, async () => undefined);
    await clock.advance(1_000);
    let answered = false;
    void budget.run('sendMessage', { chat_id: 7 }, undefined, async () => {
      answered = true;
    });
    await clock.advance(100);
    expect(answered).toBe(true);
  });

  test('refusals from several chats at once hold every sender of the token', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    for (const chat_id of [1, 2, 3]) {
      await clock.advance(100);
      await budget
        .run('sendMessage', { chat_id }, undefined, refuse(5))
        .catch(() => undefined);
    }
    expect(budget.stats().pausedForMs).toBe(5_000);
    let sent = false;
    const unrelated = budget.run('sendMessage', { chat_id: 9 }, undefined, async () => {
      sent = true;
    });
    await clock.advance(4_999);
    expect(sent).toBe(false);
    await clock.advance(1);
    await unrelated;
    expect(sent).toBe(true);
  });

  test("refusals spread wider than the window stay each chat's own", async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock, { tokenPauseChats: 2, tokenPauseWindowMs: 1_000 });
    await budget
      .run('sendMessage', { chat_id: 1 }, undefined, refuse(1))
      .catch(() => undefined);
    await clock.advance(1_001);
    await budget
      .run('sendMessage', { chat_id: 2 }, undefined, refuse(1))
      .catch(() => undefined);
    expect(budget.stats()).toMatchObject({ pausedForMs: 0, pausedChats: 1 });
    await clock.advance(100);
    await budget
      .run('sendMessage', { chat_id: 3 }, undefined, refuse(1))
      .catch(() => undefined);
    expect(budget.stats().pausedForMs).toBe(1_000);
  });

  test('a 429 with no chat in the payload still pauses the token', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    await budget.run('answerWebAppQuery', {}, undefined, refuse(2)).catch(() => undefined);
    expect(budget.stats().pausedForMs).toBe(2_000);
  });

  test('acquire, pauseAfter and waitUntilResumed take the chat by name', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pauseAfter(limited(3), { chatId: '@group' });
    expect(budget.stats()).toMatchObject({ pausedForMs: 0, pausedChats: 1 });
    await budget.waitUntilResumed();
    let granted = false;
    let resumed = false;
    const waiting = budget.acquire(1, undefined, { chatId: '@group' }).then(() => {
      granted = true;
    });
    const edit = budget.waitUntilResumed(undefined, { chatId: '@group' }).then(() => {
      resumed = true;
    });
    await clock.advance(2_999);
    expect([granted, resumed]).toEqual([false, false]);
    await clock.advance(1);
    await Promise.all([waiting, edit]);
  });

  test('maxWaitMs ends a queued call as not dispatched, and spends nothing', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pauseAfter(limited(40), { chatId: -100 });
    let called = false;
    const overdue = budget
      .run(
        'sendMessage',
        { chat_id: -100 },
        undefined,
        async () => {
          called = true;
        },
        { maxWaitMs: 1_000 },
      )
      .catch((error: unknown) => error);
    await clock.advance(999);
    expect(budget.stats().queued).toBe(1);
    await clock.advance(1);
    const failure = await overdue;
    expect(failure).toMatchObject({ stage: 'queue' });
    expect(classifyTelegramSendFailure(failure).reason).toBe('not-dispatched');
    expect(called).toBe(false);
    expect(budget.stats()).toMatchObject({ queued: 0, granted: 0 });
  });

  test('maxWaitMs that is not reached leaves the call to run, and a bad one is refused', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    let called = 0;
    await budget.run(
      'sendMessage',
      { chat_id: 1 },
      undefined,
      async () => {
        called += 1;
      },
      { maxWaitMs: 1_000 },
    );
    await clock.advance(2_000);
    expect(called).toBe(1);
    await expect(budget.acquire(1, undefined, { maxWaitMs: 0 })).rejects.toThrow(RangeError);
  });

  test('refusal: call keeps a 429 to itself, and both lanes go on', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    await budget
      .run('sendMessage', { chat_id: -100 }, undefined, refuse(40), { refusal: 'call' })
      .catch(() => undefined);
    expect(budget.stats()).toMatchObject({ pausedForMs: 0, pausedChats: 0 });
    const sent: string[] = [];
    const reply = budget.run('sendMessage', { chat_id: -100 }, undefined, async () => {
      sent.push('reply');
    });
    const campaign = budget.run(
      'sendMessage',
      { chat_id: 8 },
      undefined,
      async () => {
        sent.push('campaign');
      },
      { lane: 'bulk' },
    );
    await clock.advance(1_000);
    await Promise.all([reply, campaign]);
    expect(sent).toEqual(['reply', 'campaign']);
  });

  test('refusal: call still waits out a pause, spends the budget, and counts to no token pause', async () => {
    const clock = createManualClock();
    const { budget } = manualBudget(clock);
    budget.pause(1_000);
    let sent = false;
    const waiting = budget.run(
      'sendMessage',
      { chat_id: 1 },
      undefined,
      async () => {
        sent = true;
      },
      { refusal: 'call' },
    );
    await clock.advance(999);
    expect(sent).toBe(false);
    await clock.advance(1);
    await waiting;
    expect(budget.stats().messages).toBe(1);
    for (const chat_id of [2, 3, 4]) {
      await clock.advance(100);
      await budget
        .run('sendMessage', { chat_id }, undefined, refuse(5), { refusal: 'call' })
        .catch(() => undefined);
    }
    expect(budget.stats()).toMatchObject({ pausedChats: 0 });
  });

  test('a second holder of the token must agree on the escalation policy', () => {
    const clock = createManualClock();
    const { config } = manualBudget(clock, { tokenPauseChats: 2 });
    expect(() => telegramOutboundBudget({ ...config, tokenPauseChats: 3 })).toThrow(
      'different options',
    );
    expect(() => telegramOutboundBudget({ ...config, tokenPauseWindowMs: 9 })).toThrow(
      'different options',
    );
  });
});

describe('a group on its limit over a real socket', () => {
  const GROUP = -100123;
  const PERSON = 7;
  const RETRY_AFTER_SECONDS = 2;
  let groupRefused = false;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const body = (await request.json()) as { chat_id: number };
      if (body.chat_id === GROUP && !groupRefused) {
        groupRefused = true;
        return Response.json(
          {
            ok: false,
            error_code: 429,
            description: `Too Many Requests: retry after ${RETRY_AFTER_SECONDS}`,
            parameters: { retry_after: RETRY_AFTER_SECONDS },
          },
          { status: 429 },
        );
      }
      return Response.json({
        ok: true,
        result: {
          message_id: 1,
          date: 0,
          chat: { id: body.chat_id, type: 'private' },
          text: 'ok',
        },
      });
    },
  });
  afterAll(() => server.stop(true));

  test('the person and the campaign do not wait, the group does', async () => {
    const budget = telegramOutboundBudget({ token: `loopback-${crypto.randomUUID()}` });
    const apiRoot = `http://127.0.0.1:${server.port}`;
    const replies = new Api('1:loopback', { apiRoot });
    replies.config.use(telegramBudgetTransformer(budget));
    const campaign = new Api('1:loopback', { apiRoot });
    campaign.config.use(telegramBudgetTransformer(budget, { lane: 'bulk' }));

    await replies.sendMessage(GROUP, 'over the limit').catch(() => undefined);
    const started = performance.now();
    const group = replies.sendMessage(GROUP, 'after the pause').then(() => performance.now());
    await replies.sendMessage(PERSON, 'an answer');
    await campaign.sendMessage(PERSON + 1, 'a campaign');
    const othersMs = performance.now() - started;
    expect(othersMs).toBeLessThan(500);
    expect((await group) - started).toBeGreaterThanOrEqual(RETRY_AFTER_SECONDS * 1_000 - 100);
  });
});
