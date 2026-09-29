/**
 * Telegram screens: what happens when the chat and the Bot API disagree with
 * the plan, and every configuration option doing what it says.
 *
 * Each test drives a real `Bot` through `createScreenTestChat`, so the calls
 * asserted here are the calls a live bot makes, in the order it makes them.
 */
import { describe, expect, test } from 'bun:test';
import { Bot, type Context, MemorySessionStorage } from 'grammy';
import {
  back,
  createScreenTestChat,
  html,
  link,
  type ScreenChatState,
  type ScreenEvent,
  ScreenOutcome,
  type ScreenStaleReason,
  type TelegramScreensConfig,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

const NOT_MODIFIED =
  'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message';

/** A home screen, a detail screen with one message and a two-message screen under it. */
function menu(config: Partial<TelegramScreensConfig<Context>> = {}) {
  const tg = telegramScreens<Context>();
  const storage = new MemorySessionStorage<ScreenChatState>();
  const events: ScreenEvent[] = [];
  const errors: unknown[] = [];
  let failNextAction = false;

  const home = tg.screen('/').view(() => ({
    text: html`<b>Home</b>`,
    keyboard: [[link('Item', item, { itemId: 'a' })]],
  }));
  const item = tg
    .screen('/item/:itemId')
    .load((c) =>
      c.params.itemId === 'a' ? { name: 'Item A' } : c.go(home).toast('No such item'),
    )
    .action('explode', () => {
      if (failNextAction) throw new Error('storage is down');
    })
    .view(({ data, params, act }) => ({
      text: html`<b>${data.name}</b>`,
      keyboard: [[link('Parts', parts, params)], [act.explode('Explode')], [back('« Back')]],
    }));
  const parts = tg
    .screen('/item/:itemId/parts')
    .load(() => ({ count: 2 }))
    .view(({ data }) => [
      { key: 'header', text: html`<b>Parts ↓</b>` },
      { text: `${data.count} parts`, keyboard: [[back('« Back')]] },
    ]);

  const makeBot = () => {
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home, item, parts],
      storage,
      onEvent: (event) => events.push(event),
      ...config,
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.command('fresh', (ctx) => screens.open(ctx, home, undefined, { previous: 'delete' }));
    bot.catch((error) => {
      errors.push(error.error);
    });
    return { bot, screens };
  };
  return {
    tg,
    storage,
    events,
    errors,
    makeBot,
    screens: { home, item, parts },
    failAction: () => {
      failNextAction = true;
    },
  };
}

const botTexts = (chat: ReturnType<typeof createScreenTestChat>) =>
  chat.messages.filter((message) => message.from === 'bot').map((message) => message.text);

const methods = (chat: ReturnType<typeof createScreenTestChat>) =>
  chat.calls.map((call) => call.method);

function transitions(events: readonly ScreenEvent[]) {
  return events.flatMap((event) => (event.type === 'transition' ? [event] : []));
}

describe('telegram screens: when Telegram refuses a step', () => {
  test('an edit answered "not modified" is success: nothing is resent', async () => {
    const { makeBot, events } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    chat.clearCalls();
    chat.failNext('editMessageText', NOT_MODIFIED);
    await chat.press('Item');
    expect(methods(chat)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(transitions(events).at(-1)?.report).toEqual({
      sent: 0,
      edited: 0,
      kept: 1,
      deleted: 0,
      undeleted: [],
    });
  });

  test('a message gone from the chat is sent again, with every message after it', async () => {
    const { makeBot } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Item');
    await chat.press('Parts');
    chat.clearCalls();
    chat.failNext('editMessageText', 'Bad Request: message to edit not found');
    await chat.press('« Back');
    expect(methods(chat)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'sendMessage',
      'deleteMessage',
      'deleteMessage',
    ]);
    expect(botTexts(chat)).toEqual(['<b>Item A</b>']);
  });

  test('a message Telegram will not delete loses its buttons and is reported', async () => {
    const { makeBot, events } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Item');
    await chat.press('Parts');
    const header = chat.messages.find((message) => message.text === '<b>Parts ↓</b>');
    chat.clearCalls();
    chat.failNext('deleteMessage', "Bad Request: message can't be deleted");
    await chat.press('« Back');
    expect(methods(chat)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'deleteMessage',
      'editMessageReplyMarkup',
    ]);
    expect(events.filter((event) => event.type === 'message-kept')).toEqual([
      { type: 'message-kept', chat: 'screens:1000', messageIds: [header?.id ?? -1] },
    ]);
    expect(transitions(events).at(-1)?.report.undeleted).toEqual([header?.id ?? -1]);
  });

  test('a plan stopped halfway is recorded as far as it went; the next press repairs it', async () => {
    const { makeBot, errors } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Item');
    chat.failNext('sendMessage', 'Too Many Requests: retry after 5', 429);
    await chat.press('Parts');
    expect(errors).toHaveLength(1);
    // Nothing was drawn: the item screen is still there, still live.
    expect(botTexts(chat)).toEqual(['<b>Item A</b>']);
    await chat.press('Parts');
    expect(botTexts(chat)).toEqual(['<b>Parts ↓</b>', '2 parts']);
    await chat.press('« Back');
    expect(botTexts(chat)).toEqual(['<b>Item A</b>']);
  });
});

describe('telegram screens: presses on messages the record does not know', () => {
  test('a one-message screen takes the pressed message over; the newer view goes', async () => {
    const { makeBot } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.send('/start');
    const [upper, lower] = chat.messages.filter((message) => message.from === 'bot');
    const button = upper?.markup?.inline_keyboard[0]?.[0];
    const data = button && 'callback_data' in button ? button.callback_data : '';
    chat.clearCalls();
    await chat.pressData(upper?.id ?? 0, data);
    expect(methods(chat)).toEqual(['answerCallbackQuery', 'editMessageText', 'deleteMessage']);
    const shown = chat.messages.filter((message) => message.from === 'bot');
    expect(shown.map((message) => [message.id, message.text])).toEqual([
      [upper?.id ?? -1, '<b>Item A</b>'],
    ]);
    expect(shown.some((message) => message.id === lower?.id)).toBe(false);
  });

  test('a longer screen is sent below; the pressed message and the old view go', async () => {
    const { makeBot } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Item');
    const detail = chat.messages.at(-1);
    await chat.send('/start');
    const button = detail?.markup?.inline_keyboard[0]?.[0];
    const data = button && 'callback_data' in button ? button.callback_data : '';
    await chat.pressData(detail?.id ?? 0, data);
    expect(botTexts(chat)).toEqual(['<b>Parts ↓</b>', '2 parts']);
  });

  test('open keeps the previous view by default, and deletes it when asked', async () => {
    const { makeBot } = menu();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.send('/start');
    expect(botTexts(chat)).toEqual(['<b>Home</b>', '<b>Home</b>']);
    const [upper, lower] = chat.messages.filter((message) => message.from === 'bot');
    await chat.send('/fresh');
    const ids = chat.messages
      .filter((message) => message.from === 'bot')
      .map((message) => message.id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(upper?.id ?? -1);
    expect(ids).not.toContain(lower?.id ?? -1);
  });
});

describe('telegram screens: the application decides', () => {
  test('onStale gets the reason and its outcome is shown', async () => {
    const reasons: ScreenStaleReason[] = [];
    const fixture = menu({
      onStale: (c) => {
        reasons.push(c.reason);
        return c.go(fixture.screens.home).toast('This menu is out of date');
      },
    });
    const { bot } = fixture.makeBot();
    const chat = createScreenTestChat(bot);
    await bot.api.sendMessage(1_000, 'old menu', {
      reply_markup: { inline_keyboard: [[{ text: 'Old', callback_data: '~zz' }]] },
    });
    await chat.press('Old');
    expect(reasons).toEqual(['unknown-screen']);
    expect(chat.answers).toEqual(['This menu is out of date']);
    expect(chat.messages.at(-1)?.text).toBe('<b>Home</b>');
  });

  test('a stale press without onStale is answered silently and changes nothing', async () => {
    const { makeBot } = menu();
    const { bot } = makeBot();
    const chat = createScreenTestChat(bot);
    await bot.api.sendMessage(1_000, 'old menu', {
      reply_markup: { inline_keyboard: [[{ text: 'Old', callback_data: '~zz' }]] },
    });
    chat.clearCalls();
    await chat.press('Old');
    expect(methods(chat)).toEqual(['answerCallbackQuery']);
    expect(chat.answers).toEqual(['']);
  });

  test('onError turns a thrown action into the outcome it answers', async () => {
    const fixture = menu({ onError: (_error, c) => c.toast(`Failed (${c.trigger})`) });
    const chat = createScreenTestChat(fixture.makeBot().bot);
    await chat.send('/start');
    await chat.press('Item');
    fixture.failAction();
    await chat.press('Explode');
    expect(chat.answers.at(-1)).toBe('Failed (press)');
    expect(fixture.errors).toEqual([]);
  });

  test('without onError the press is answered once, silently, and the error reaches bot.catch', async () => {
    const fixture = menu();
    const chat = createScreenTestChat(fixture.makeBot().bot);
    await chat.send('/start');
    await chat.press('Item');
    fixture.failAction();
    chat.clearCalls();
    await chat.press('Explode');
    expect(chat.answers).toEqual(['']);
    expect(
      fixture.errors.map((error) => (error instanceof Error ? error.message : '')),
    ).toEqual(['storage is down']);
  });

  test('a load that answers with an outcome redirects, and says why', async () => {
    const { makeBot, screens: declared } = menu();
    const { bot, screens } = makeBot();
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const missing = screens.button(link('Missing', declared.item, { itemId: 'zz' }));
    await bot.api.sendMessage(1_000, 'notification', {
      reply_markup: { inline_keyboard: [[missing]] },
    });
    await chat.press('Missing');
    expect(chat.answers.at(-1)).toBe('No such item');
    expect(chat.messages.at(-1)?.text).toBe('<b>Home</b>');
  });

  test('loads that keep redirecting are stopped', async () => {
    const tg = telegramScreens<Context>();
    // The child sends the chat back up; the parent sends it down again.
    const b = tg
      .screen('/a/b')
      .load((c) => c.back())
      .view(() => ({ text: 'b' }));
    const a = tg
      .screen('/a')
      .load((c) => c.go(b))
      .view(() => ({ text: 'a' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [a, b],
      storage: new MemorySessionStorage<ScreenChatState>(),
    });
    bot.use(screens);
    const errors: unknown[] = [];
    bot.command('start', (ctx) => screens.open(ctx, a));
    bot.catch((error) => {
      errors.push(error.error);
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    expect(String(errors[0])).toContain('redirected more than 4 times');
  });

  test('a handler may open a screen in its own chat without waiting on itself', async () => {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = new Bot<Context>('0:test');
    const home = tg
      .screen('/')
      .action('again', async (c) => {
        await screens.open(c.ctx, other);
        return c.toast('Opened');
      })
      .view(({ act }) => ({ text: 'home', keyboard: [[act.again('Again')]] }));
    const other = tg.screen('/other').view(() => ({ text: 'other' }));
    const screens = tg.create({ screens: [home, other], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.press('Again');
    expect(chat.answers).toEqual(['Opened']);
    expect(botTexts(chat)).toContain('other');
  });
});

describe('telegram screens: input options', () => {
  test('keepMessage leaves the message and sends the view below it', async () => {
    const tg = telegramScreens<Context>();
    const received: string[] = [];
    const notes = tg
      .screen('/')
      .on(
        'text',
        (c) => {
          received.push(c.text);
        },
        { keepMessage: true },
      )
      .view(() => ({ text: `Notes: ${received.length}` }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [notes],
      storage: new MemorySessionStorage<ScreenChatState>(),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, notes));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.send('first note');
    expect(chat.messages.map((message) => [message.from, message.text])).toEqual([
      ['user', '/start'],
      ['user', 'first note'],
      ['bot', 'Notes: 1'],
    ]);
  });

  test('a message kind the screen does not take goes to the next handler', async () => {
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .on('photo', () => undefined)
      .view(() => ({ text: 'Send a photo' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home],
      storage: new MemorySessionStorage<ScreenChatState>(),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.on('message:text', (ctx) => ctx.reply('fallthrough'));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.send('words');
    expect(chat.messages.at(-1)?.text).toBe('fallthrough');
  });
});

describe('telegram screens: configuration', () => {
  test('callbackPrefix marks every screen button, and other prefixes pass through', async () => {
    const { makeBot } = menu({ callbackPrefix: 'scr:' });
    const { bot } = makeBot();
    let foreign = 0;
    bot.callbackQuery('other', async (ctx) => {
      foreign += 1;
      await ctx.answerCallbackQuery();
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const button = chat.messages.at(-1)?.markup?.inline_keyboard[0]?.[0];
    expect(button && 'callback_data' in button ? button.callback_data : '').toStartWith(
      'scr:',
    );
    await bot.api.sendMessage(1_000, 'x', {
      reply_markup: { inline_keyboard: [[{ text: 'Other', callback_data: 'other' }]] },
    });
    await chat.press('Other');
    expect(foreign).toBe(1);
    expect(() => menu({ callbackPrefix: 'a#' }).makeBot()).toThrow(/callbackPrefix/);
  });

  test('chatKey names where the record is stored', async () => {
    const { makeBot, storage } = menu({ chatKey: (ctx) => `menu/${ctx.chat?.id}` });
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    expect((await storage.read('menu/1000'))?.view?.messages).toHaveLength(1);
    expect(await storage.read('screens:1000')).toBeUndefined();
  });

  test("chats: 'all' answers presses in a group", async () => {
    const { makeBot } = menu({ chats: 'all' });
    const chat = createScreenTestChat(makeBot().bot, { chatType: 'supergroup', chatId: -100 });
    await chat.send('/start');
    await chat.press('Item');
    expect(botTexts(chat)).toEqual(['<b>Item A</b>']);
  });

  test('a record from another schema is set aside and reported', async () => {
    const { makeBot, storage, events } = menu();
    await storage.write('screens:1000', JSON.parse('{"version":99}'));
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    expect(events[0]).toEqual({ type: 'state-discarded', chat: 'screens:1000' });
    expect(botTexts(chat)).toEqual(['<b>Home</b>']);
  });

  test('clock times the expiry of a remark; close() cancels pending sweeps', async () => {
    let now = 0;
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .on('text', (c) => c.notice('Too short', { expiresInMs: 60_000 }))
      .action('refresh', () => undefined)
      .view(({ act }) => ({ text: 'home', keyboard: [[act.refresh('Refresh')]] }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({ screens: [home], storage, clock: () => now });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.send('x');
    expect((await storage.read('screens:1000'))?.expiring[0]?.at).toBe(60_000);
    screens.close();
    // Nothing is sent by a refresh that changes nothing, so only the clock decides.
    now = 59_999;
    await chat.press('Refresh');
    expect(botTexts(chat)).toContain('Too short');
    now = 60_000;
    await chat.press('Refresh');
    expect(botTexts(chat)).not.toContain('Too short');
  });

  test('create refuses a screen whose params nothing checks, and a duplicate path', () => {
    const tg = telegramScreens<Context>();
    const loose = tg.screen('/user/:userId').view(() => ({ text: 'x' }));
    expect(() =>
      tg.create({ screens: [loose], storage: new MemorySessionStorage<ScreenChatState>() }),
    ).toThrow(/load/);
    const one = tg.screen('/').view(() => ({ text: '1' }));
    const two = tg.screen('/').view(() => ({ text: '2' }));
    expect(() =>
      tg.create({ screens: [one, two], storage: new MemorySessionStorage<ScreenChatState>() }),
    ).toThrow();
  });

  test('a toast longer than Telegram allows is refused where it is written', () => {
    expect(() => new ScreenOutcome().toast('x'.repeat(200))).not.toThrow();
    expect(() => new ScreenOutcome().toast('x'.repeat(201))).toThrow(RangeError);
    expect(() => new ScreenOutcome().notice('x', { expiresInMs: 0 })).toThrow(RangeError);
  });
});
