/**
 * The widget methods over a real grammY client with the outbound budget as its
 * one transformer. The `fetch` answers like Bot API and a manual clock paces
 * the budget, so each test sees what left, when, and how often.
 */
import { describe, expect, test } from 'bun:test';
import { Api, GrammyError, HttpError } from 'grammy';
import { ZodError } from 'zod';
import {
  classifyTelegramSendFailure,
  TELEGRAM_WIDGET_LIMITS,
  TelegramNotDispatchedError,
} from '../src/entrypoints/telegram';
import { telegramWidgetApi } from '../src/entrypoints/telegram/grammy';
import { createManualClock } from '../src/entrypoints/testing';
import { type BotApiAnswer, botClient } from './support/telegram-bot-client';
import { manualBudget } from './support/telegram-budget-clock';

const WIDGET_MESSAGE = {
  message_id: 7,
  date: 1_794_547_507,
  chat: { id: 42, type: 'private', first_name: 'Fixture' },
  widget: { html: '<p>ok</p>', chat_data: '' },
  a_field_telegram_adds_later: { kept: true },
};

function ok(result: unknown): BotApiAnswer {
  return { status: 200, body: { ok: true, result } };
}

function refused(status: number, description: string): BotApiAnswer {
  return { status, body: { ok: false, error_code: status, description } };
}

/** A widget client whose Bot API answers each method with `answers[method]`. */
function widgetClient(answers: Record<string, BotApiAnswer> = {}) {
  const clock = createManualClock();
  const { budget } = manualBudget(clock, { messagesPerSecond: 10 });
  const defaults: Record<string, BotApiAnswer> = {
    sendWidget: ok(WIDGET_MESSAGE),
    editMessageWidgetData: ok(true),
    answerWidgetQuery: ok(true),
    sendMessage: ok({ message_id: 1 }),
  };
  const { api, calls } = botClient(
    clock,
    budget,
    (_call, method) => answers[method] ?? defaults[method] ?? ok(true),
  );
  return { clock, budget, api, calls, widgets: telegramWidgetApi(api) };
}

/** A string of exactly `bytes` UTF-8 bytes made of `unit` and ASCII padding. */
function textOfBytes(bytes: number, unit: string): string {
  const unitBytes = new TextEncoder().encode(unit).length;
  const count = Math.floor(bytes / unitBytes);
  return unit.repeat(count) + 'x'.repeat(bytes - count * unitBytes);
}

/** Text that zlib cannot shrink: printable bytes from a fixed pseudo-random sequence. */
function incompressible(bytes: number): string {
  let seed = 1;
  let text = '';
  for (let index = 0; index < bytes; index += 1) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    text += String.fromCharCode(33 + (seed % 94));
  }
  return text;
}

describe('sendWidget', () => {
  test('sends the Bot API parameters as given and parses the widget message', async () => {
    const { widgets, calls, budget } = widgetClient();
    const message = await widgets.sendWidget({
      chat_id: 42,
      message_thread_id: 3,
      html: '<p>ok</p>',
      chat_data: '',
      public_data: undefined,
      allow_queries: true,
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]] },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('sendWidget');
    expect(calls[0]?.payload).toEqual({
      chat_id: 42,
      message_thread_id: 3,
      html: '<p>ok</p>',
      chat_data: '',
      allow_queries: true,
      reply_parameters: { message_id: 5, allow_sending_without_reply: true },
      reply_markup: { inline_keyboard: [[{ text: 'Open', url: 'https://example.com' }]] },
    });
    expect(Object.keys(Object(calls[0]?.payload))).not.toContain('public_data');
    expect(message.message_id).toBe(7);
    expect(message.widget.chat_data).toBe('');
    expect(Reflect.get(message, 'a_field_telegram_adds_later')).toEqual({ kept: true });
    expect(budget.stats()).toMatchObject({ granted: 1, messages: 1, queued: 0 });
  });

  test('spends exactly one slot of the shared token schedule', async () => {
    const { widgets, api, calls, clock, budget } = widgetClient();
    await api.sendMessage(1, 'first');
    const widget = widgets.sendWidget({ chat_id: 2, html: '<b>w</b>' });
    const after = api.sendMessage(3, 'after');
    await clock.advance(99);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
    await clock.advance(1);
    await widget;
    await clock.advance(100);
    await after;
    expect(calls.map((call) => [call.method, call.at])).toEqual([
      ['sendMessage', 0],
      ['sendWidget', 100],
      ['sendMessage', 200],
    ]);
    expect(budget.stats()).toMatchObject({ granted: 3, messages: 3 });
    expect(clock.pending()).toBe(0);
  });

  test('a send whose outcome is unknown is sent once and not marked as never sent', async () => {
    const { widgets, calls } = widgetClient({
      sendWidget: refused(502, 'Bad Gateway'),
    });
    const failure = await widgets
      .sendWidget({ chat_id: 2, html: '<b>w</b>' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GrammyError);
    expect(calls).toHaveLength(1);
    expect(classifyTelegramSendFailure(failure).reason).not.toBe('not-dispatched');
  });

  test('a successful answer that is not a widget message is an unknown outcome, not a refusal', async () => {
    const { widgets, calls } = widgetClient({ sendWidget: ok(true) });
    const failure = await widgets
      .sendWidget({ chat_id: 2, html: '<b>w</b>' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ZodError);
    expect(failure).not.toBeInstanceOf(TelegramNotDispatchedError);
    expect(Reflect.get(Object(failure), 'cause')).toBeInstanceOf(ZodError);
    expect(String(Reflect.get(Object(failure), 'message'))).toContain('outcome is unknown');
    expect(calls).toHaveLength(1);
  });
});

describe('editMessageWidgetData', () => {
  test('spends one slot, sends an empty chat_data as a removal and omits what is undefined', async () => {
    const { widgets, calls, budget, clock } = widgetClient();
    await widgets.editMessageWidgetData({ chat_id: 42, message_id: 7, chat_data: '' });
    const inline = widgets.editMessageWidgetData({
      inline_message_id: 'inline-1',
      public_data: '{}',
    });
    await clock.advance(99);
    expect(calls).toHaveLength(1);
    await clock.advance(1);
    await inline;
    expect(calls.map((call) => call.payload)).toEqual([
      { chat_id: 42, message_id: 7, chat_data: '' },
      { inline_message_id: 'inline-1', public_data: '{}' },
    ]);
    expect(budget.stats()).toMatchObject({ granted: 2, messages: 2 });
  });

  test('message is not modified is success; another refusal is the caller’s', async () => {
    const same = widgetClient({
      editMessageWidgetData: refused(
        400,
        'Bad Request: message is not modified: specified new message content and reply markup are exactly the same',
      ),
    });
    await same.widgets.editMessageWidgetData({ chat_id: 42, message_id: 7, chat_data: 'x' });
    expect(same.calls).toHaveLength(1);

    const gone = widgetClient({
      editMessageWidgetData: refused(400, 'Bad Request: message to edit not found'),
    });
    const failure = await gone.widgets
      .editMessageWidgetData({ chat_id: 42, message_id: 7, chat_data: 'x' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GrammyError);
  });

  test('a malformed success is refused by its schema as an unknown outcome', async () => {
    const { widgets, calls } = widgetClient({ editMessageWidgetData: ok({ edited: 'yes' }) });
    const failure = await widgets
      .editMessageWidgetData({ chat_id: 42, message_id: 7, chat_data: 'x' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ZodError);
    expect(Reflect.get(Object(failure), 'cause')).toBeInstanceOf(ZodError);
    expect(calls).toHaveLength(1);
  });
});

describe('answerWidgetQuery', () => {
  test('passes while the token is paused and spends no message', async () => {
    const { widgets, api, calls, budget, clock } = widgetClient();
    budget.pause(60_000);
    const held = api.sendMessage(1, 'held');
    await widgets.answerWidgetQuery({ widget_query_id: 'q-1', data: '{"v":1}' });
    await widgets.answerWidgetQuery({ widget_query_id: 'q-2' });
    expect(calls.map((call) => [call.method, call.payload])).toEqual([
      ['answerWidgetQuery', { widget_query_id: 'q-1', data: '{"v":1}' }],
      ['answerWidgetQuery', { widget_query_id: 'q-2' }],
    ]);
    expect(budget.stats()).toMatchObject({ messages: 0 });
    await clock.advance(60_000);
    await held;
    expect(calls.at(-1)?.method).toBe('sendMessage');
  });
});

describe('what is sent and what comes back', () => {
  test('an answer that Telegram does not confirm is an unknown outcome', async () => {
    const { widgets, calls } = widgetClient({ answerWidgetQuery: ok(false) });
    const failure = await widgets
      .answerWidgetQuery({ widget_query_id: 'q' })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(ZodError);
    expect(Reflect.get(Object(failure), 'cause')).toBeInstanceOf(ZodError);
    expect(calls).toHaveLength(1);
  });

  test('the payload handed to the client has no undefined field and keeps empty strings', async () => {
    // A transformer sees the payload object before grammY serialises it, and
    // grammY's JSON would drop an `undefined` on its own.
    const payloads: unknown[] = [];
    const api = new Api('123456:fixture-token', {
      fetch: Object.assign(async () => Response.json({ ok: true, result: true }), {
        preconnect: () => undefined,
      }),
    });
    api.config.use((previous, method, payload, signal) => {
      payloads.push(payload);
      return previous(method, payload, signal);
    });
    const widgets = telegramWidgetApi(api);
    await widgets.editMessageWidgetData({
      chat_id: 1,
      message_id: 2,
      chat_data: '',
      public_data: undefined,
    });
    await widgets.answerWidgetQuery({ widget_query_id: 'q', data: undefined });
    expect(payloads).toEqual([
      { chat_id: 1, message_id: 2, chat_data: '' },
      { widget_query_id: 'q' },
    ]);
    expect(payloads.map((payload) => Object.keys(Object(payload)))).toEqual([
      ['chat_id', 'message_id', 'chat_data'],
      ['widget_query_id'],
    ]);
  });
});

describe('cancellation', () => {
  test('an aborted signal before the call is not dispatched, and nothing leaves', async () => {
    const { widgets, calls } = widgetClient();
    const controller = new AbortController();
    const reason = new Error('the caller stopped');
    controller.abort(reason);
    for (const call of [
      () =>
        widgets.sendWidget({ chat_id: 1, html: '<b>w</b>' }, { signal: controller.signal }),
      () =>
        widgets.editMessageWidgetData(
          { chat_id: 1, message_id: 2, chat_data: '' },
          { signal: controller.signal },
        ),
      () => widgets.answerWidgetQuery({ widget_query_id: 'q' }, { signal: controller.signal }),
    ]) {
      const failure = await call().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TelegramNotDispatchedError);
      expect(Reflect.get(Object(failure), 'cause')).toBe(reason);
      expect(classifyTelegramSendFailure(failure).reason).toBe('not-dispatched');
    }
    expect(calls).toHaveLength(0);
  });

  test('an edit cancelled with a not-modified reason is not dispatched, not a success', async () => {
    const { widgets, calls } = widgetClient();
    const controller = new AbortController();
    controller.abort(new Error('Bad Request: message is not modified'));
    const failure = await widgets
      .editMessageWidgetData(
        { chat_id: 1, message_id: 2, chat_data: 'x' },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramNotDispatchedError);
    expect(calls).toHaveLength(0);
  });

  test('without a budget transformer an aborted signal is still not dispatched', async () => {
    let requests = 0;
    const api = new Api('123456:fixture-token', {
      fetch: Object.assign(
        async () => {
          requests += 1;
          return Response.json({ ok: true, result: true });
        },
        { preconnect: () => undefined },
      ),
    });
    const controller = new AbortController();
    controller.abort(new Error('stopped'));
    const failure = await telegramWidgetApi(api)
      .answerWidgetQuery({ widget_query_id: 'q' }, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TelegramNotDispatchedError);
    expect(requests).toBe(0);
  });

  test('cancelled while waiting for its slot, a send is not dispatched', async () => {
    const { widgets, api, calls, clock } = widgetClient();
    await api.sendMessage(1, 'first');
    const controller = new AbortController();
    const waiting = widgets
      .sendWidget({ chat_id: 2, html: '<b>w</b>' }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await clock.advance(50);
    controller.abort(new Error('gave up'));
    expect(await waiting).toBeInstanceOf(TelegramNotDispatchedError);
    expect(calls.map((call) => call.method)).toEqual(['sendMessage']);
  });

  test('cancelled after the request left, a send is an unknown outcome', async () => {
    const { widgets, calls } = widgetClient({ sendWidget: 'hang' });
    const controller = new AbortController();
    const inFlight = widgets
      .sendWidget({ chat_id: 2, html: '<b>w</b>' }, { signal: controller.signal })
      .catch((error: unknown) => error);
    await Promise.resolve();
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort(new Error('too late'));
    const failure = await inFlight;
    expect(failure).toBeInstanceOf(HttpError);
    expect(failure).not.toBeInstanceOf(TelegramNotDispatchedError);
    expect(classifyTelegramSendFailure(failure).reason).not.toBe('not-dispatched');
    expect(calls).toHaveLength(1);
  });
});

describe('input refused before the network', () => {
  const html = (value: string) => ({ chat_id: 1, html: value });
  const cases: {
    name: string;
    run: (w: ReturnType<typeof widgetClient>['widgets']) => Promise<unknown>;
  }[] = [
    { name: 'empty HTML', run: (w) => w.sendWidget(html('')) },
    {
      name: 'HTML one byte over',
      run: (w) => w.sendWidget(html(textOfBytes(TELEGRAM_WIDGET_LIMITS.htmlBytes + 1, 'я'))),
    },
    {
      name: 'HTML that compresses past 4096 bytes',
      run: (w) => w.sendWidget(html(incompressible(6_000))),
    },
    { name: 'HTML with NUL', run: (w) => w.sendWidget(html('<b>\0</b>')) },
    { name: 'HTML with a lone surrogate', run: (w) => w.sendWidget(html('<b>\uD83D</b>')) },
    {
      name: 'chat_data one byte over in emoji',
      run: (w) =>
        w.sendWidget({
          ...html('<b>w</b>'),
          chat_data: textOfBytes(TELEGRAM_WIDGET_LIMITS.dataBytes + 1, '😀'),
        }),
    },
    {
      name: 'public_data one byte over in Cyrillic',
      run: (w) =>
        w.editMessageWidgetData({
          chat_id: 1,
          message_id: 2,
          public_data: textOfBytes(TELEGRAM_WIDGET_LIMITS.dataBytes + 1, 'я'),
        }),
    },
    {
      name: 'public_data one byte over on a send',
      run: (w) => w.sendWidget({ ...html('<b>w</b>'), public_data: 'x'.repeat(1_025) }),
    },
    {
      name: 'chat_data one byte over on an edit',
      run: (w) =>
        w.editMessageWidgetData({ chat_id: 1, message_id: 2, chat_data: 'x'.repeat(1_025) }),
    },
    { name: 'an empty chat_id', run: (w) => w.sendWidget({ chat_id: '', html: '<b>w</b>' }) },
    {
      name: 'an answer one byte over',
      run: (w) => w.answerWidgetQuery({ widget_query_id: 'q', data: 'x'.repeat(1_025) }),
    },
    {
      name: 'an answer with NUL',
      run: (w) => w.answerWidgetQuery({ widget_query_id: 'q', data: '\0' }),
    },
    { name: 'an empty query id', run: (w) => w.answerWidgetQuery({ widget_query_id: '' }) },
    {
      name: 'an edit with nothing to change',
      run: (w) => Reflect.apply(w.editMessageWidgetData, w, [{ chat_id: 1, message_id: 2 }]),
    },
    {
      name: 'an edit naming both a chat message and an inline one',
      run: (w) =>
        Reflect.apply(w.editMessageWidgetData, w, [
          { chat_id: 1, message_id: 2, inline_message_id: 'i', chat_data: '' },
        ]),
    },
  ];

  for (const { name, run } of cases) {
    test(`${name}: ZodError, nothing sent, nothing spent`, async () => {
      const { widgets, calls, budget } = widgetClient();
      const failure = await run(widgets).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ZodError);
      expect(calls).toHaveLength(0);
      expect(budget.stats()).toMatchObject({ granted: 0, messages: 0 });
    });
  }

  test('values exactly at the limits pass, in RU and emoji', async () => {
    const { widgets, calls } = widgetClient();
    const ru = textOfBytes(TELEGRAM_WIDGET_LIMITS.dataBytes, 'я');
    const emoji = textOfBytes(TELEGRAM_WIDGET_LIMITS.dataBytes, '😀');
    await widgets.sendWidget({
      chat_id: 1,
      html: `<p>${'я'.repeat(4_000)}</p>`,
      chat_data: ru,
    });
    await widgets.answerWidgetQuery({ widget_query_id: 'q', data: emoji });
    expect(new TextEncoder().encode(ru).length).toBe(1_024);
    expect(new TextEncoder().encode(emoji).length).toBe(1_024);
    expect(calls.map((call) => call.method)).toEqual(['sendWidget', 'answerWidgetQuery']);
  });
});
