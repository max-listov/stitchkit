/**
 * Telegram screens: what goes into a message — media, captions, link previews
 * — the limits a view and an outcome are held to before anything is sent, the
 * test chat refusing what Telegram refuses, and remarks on their timers.
 */
import { describe, expect, test } from 'bun:test';
import { Bot, type Context, MemorySessionStorage } from 'grammy';
import {
  createScreenTestChat,
  html,
  link,
  type ScreenChatState,
  type ScreenEvent,
  ScreenOutcome,
  type ScreenViewResult,
  TelegramHtml,
  type TelegramScreenStorage,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

describe('telegram screens: media, captions and previews', () => {
  test('text becomes a photo by editing its media; a new caption edits only the caption', async () => {
    const tg = telegramScreens<Context>();
    let shape: 'text' | 'photo' | 'recaptioned' = 'text';
    const home = tg
      .screen('/')
      .action('next', (c) => {
        shape = shape === 'text' ? 'photo' : 'recaptioned';
        return c.stay();
      })
      .view(({ act }) =>
        shape === 'text'
          ? { text: 'plain', linkPreview: false, keyboard: [[act.next('Next')]] }
          : {
              photo: 'photo-file',
              caption: shape === 'photo' ? 'first' : 'second',
              keyboard: [[act.next('Next')]],
            },
      );
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home],
      storage: new MemorySessionStorage<ScreenChatState>(),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    expect(chat.calls.find((call) => call.method === 'sendMessage')?.payload).toMatchObject({
      link_preview_options: { is_disabled: true },
    });
    chat.clearCalls();
    await chat.press('Next');
    await chat.press('Next');
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageMedia',
      'answerCallbackQuery',
      'editMessageCaption',
    ]);
    expect(chat.messages.at(-1)).toMatchObject({ kind: 'photo', text: 'second' });
  });
});

describe('telegram screens: the test chat refuses what Telegram refuses', () => {
  test('broken markup, text past the limit and button data past 64 bytes', async () => {
    const bot = new Bot<Context>('0:test');
    const chat = createScreenTestChat(bot);
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => 'sent',
        (error: unknown) => String(error),
      );
    expect(
      await refusal(bot.api.sendMessage(1000, '<b>open', { parse_mode: 'HTML' })),
    ).toContain("can't parse entities");
    expect(
      await refusal(bot.api.sendMessage(1000, 'a < b', { parse_mode: 'HTML' })),
    ).toContain("can't parse entities");
    expect(
      await refusal(bot.api.sendMessage(1000, 'x'.repeat(4_097), { parse_mode: 'HTML' })),
    ).toContain('message is too long');
    expect(
      await refusal(
        bot.api.sendMessage(1000, 'menu', {
          reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: 'd'.repeat(65) }]] },
        }),
      ),
    ).toContain('BUTTON_DATA_INVALID');
    expect(
      await refusal(
        bot.api.sendMessage(1000, '<b>fine</b> &amp; x'.repeat(2), { parse_mode: 'HTML' }),
      ),
    ).toBe('sent');
    expect(chat.messages).toHaveLength(1);
  });

  test('a view Telegram would refuse fails the update and records nothing it did not send', async () => {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const home = tg.screen('/').view(() => ({ text: html.raw('<blink>hi</blink>') }));
    const errors: unknown[] = [];
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({ screens: [home], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.catch((error) => {
      errors.push(error.error);
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    expect(String(errors[0])).toContain('Unsupported start tag');
    expect(await storage.read('screens:1000')).toBeUndefined();
  });
});

describe('telegram screens: limits held before anything is sent', () => {
  function refusing(view: () => ScreenViewResult) {
    const tg = telegramScreens<Context>();
    const home = tg.screen('/').view(view);
    const errors: unknown[] = [];
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home],
      storage: new MemorySessionStorage<ScreenChatState>(),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.catch((error) => {
      errors.push(error.error);
    });
    return { chat: createScreenTestChat(bot), errors };
  }

  test('a view of more messages than a record holds, or a key past its length', async () => {
    const many = refusing(() =>
      Array.from({ length: 101 }, (_, index) => ({ text: `m${index}` })),
    );
    await many.chat.send('/start');
    expect(String(many.errors[0])).toContain('a view holds 100');
    const long = refusing(() => ({ key: 'k'.repeat(65), text: 'x' }));
    await long.chat.send('/start');
    expect(String(long.errors[0])).toContain('a key has 1 to 64');
    for (const { chat } of [many, long]) {
      expect(chat.calls.filter((call) => call.method.startsWith('send'))).toEqual([]);
    }
  });

  test('a link outside a screen that does not fit in a button is refused where it is made', () => {
    const tg = telegramScreens<Context>();
    const item = tg
      .screen('/item/:itemId')
      .load(() => ({}))
      .view(() => ({ text: 'item' }));
    const screens = tg.create({
      screens: [item],
      storage: new MemorySessionStorage<ScreenChatState>(),
    });
    expect(() => screens.button(link('Item', item, { itemId: 'i'.repeat(40) }))).not.toThrow();
    expect(() => screens.button(link('Item', item, { itemId: 'i'.repeat(80) }))).toThrow(
      /Telegram allows 64/,
    );
  });

  test('a toast is counted in characters, an expiry is bounded by what a timer can wait', () => {
    expect(() => new ScreenOutcome().toast('😀'.repeat(200))).not.toThrow();
    expect(() => new ScreenOutcome().toast('😀'.repeat(201))).toThrow(RangeError);
    expect(() =>
      new ScreenOutcome().notice('x', { expiresInMs: 2_147_483_647 }),
    ).not.toThrow();
    expect(() => new ScreenOutcome().notice('x', { expiresInMs: 2_147_483_648 })).toThrow(
      RangeError,
    );
  });

  test('markup is made by html, never by constructing it', () => {
    expect(() => Reflect.construct(TelegramHtml, [Symbol('forged'), '<b>x</b>'])).toThrow(
      TypeError,
    );
    expect(String(html.raw('<b>x</b>'))).toBe('<b>x</b>');
  });
});

describe('telegram screens: remarks on their timers', () => {
  function remarking(storage: TelegramScreenStorage, events: ScreenEvent[]) {
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .on('text', (c) => c.notice('short-lived', { expiresInMs: 5 }))
      .view(() => ({ text: 'home' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home],
      storage,
      onEvent: (event) => events.push(event),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    return { screens, chat: createScreenTestChat(bot) };
  }
  const texts = (chat: ReturnType<typeof createScreenTestChat>) =>
    chat.messages.map((message) => message.text);

  test('a remark is swept on its timer, and close() cancels the timer', async () => {
    const swept = remarking(new MemorySessionStorage<ScreenChatState>(), []);
    await swept.chat.send('/start');
    await swept.chat.send('x');
    expect(texts(swept.chat)).toContain('short-lived');
    await Bun.sleep(40);
    expect(texts(swept.chat)).not.toContain('short-lived');
    const closed = remarking(new MemorySessionStorage<ScreenChatState>(), []);
    await closed.chat.send('/start');
    await closed.chat.send('x');
    closed.screens.close();
    await Bun.sleep(40);
    expect(texts(closed.chat)).toContain('short-lived');
  });

  test('a sweep that fails on its timer is reported, not swallowed', async () => {
    let broken = false;
    const inner = new MemorySessionStorage<ScreenChatState>();
    const storage: TelegramScreenStorage = {
      read: (key) => {
        if (broken) throw new Error('storage is down');
        return inner.read(key);
      },
      write: (key, value) => inner.write(key, value),
      delete: (key) => inner.delete(key),
    };
    const events: ScreenEvent[] = [];
    const { chat } = remarking(storage, events);
    await chat.send('/start');
    await chat.send('x');
    broken = true;
    await Bun.sleep(40);
    expect(events.find((event) => event.type === 'sweep-failed')).toMatchObject({
      type: 'sweep-failed',
      chat: 'screens:1000',
    });
  });

  test('input Telegram will not delete is reported as kept', async () => {
    const events: ScreenEvent[] = [];
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .on('text', () => undefined)
      .view(() => ({ text: 'home' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home],
      storage: new MemorySessionStorage<ScreenChatState>(),
      onEvent: (event) => events.push(event),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    chat.failNext('deleteMessage', "Bad Request: message can't be deleted");
    await chat.send('secret');
    const input = chat.messages.find((message) => message.text === 'secret');
    expect(events).toContainEqual({
      type: 'message-kept',
      chat: 'screens:1000',
      messageIds: [input?.id ?? -1],
    });
  });
});

describe('telegram screens: deleting what the user already deleted', () => {
  test('a message gone from the chat counts as deleted: no stripped buttons, nothing reported', async () => {
    const events: ScreenEvent[] = [];
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .view(() => ({ text: 'home', keyboard: [[link('Parts', parts)]] }));
    const parts = tg.screen('/parts').view(() => [
      { key: 'header', text: 'header' },
      { text: 'body', keyboard: [[link('Home', home)]] },
    ]);
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home, parts],
      storage: new MemorySessionStorage<ScreenChatState>(),
      onEvent: (event) => events.push(event),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.press('Parts');
    chat.deleteByUser(chat.messages.find((message) => message.text === 'header')?.id ?? -1);
    chat.clearCalls();
    await chat.press('Home');
    expect(chat.calls.map((call) => call.method)).not.toContain('editMessageReplyMarkup');
    expect(events.filter((event) => event.type === 'message-kept')).toEqual([]);
  });
});
