import { describe, expect, test } from 'bun:test';
import { Bot, type Context, MemorySessionStorage } from 'grammy';
import { z } from 'zod';
import {
  createScreenTestChat,
  link,
  type ScreenChatState,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

const refused = 'Bad Request: failed to get HTTP URL content';
const retry = 'Try <again> & retry';

function menu(chatType: 'private' | 'group' = 'private') {
  const tg = telegramScreens<Context>();
  const storage = new MemorySessionStorage<ScreenChatState>();
  const slug = 'long-collection-name-'.repeat(5);
  const card = tg
    .screen('/card/:slug')
    .load(() => ({}))
    .action('select', z.object({ name: z.string() }), () => undefined)
    .view(({ act }) => ({
      rich: { blocks: [{ type: 'photo', photo: { type: 'photo', media: 'catalog-photo' } }] },
      keyboard: [[act.select('Select', { name: slug })]],
    }));
  const home = tg.screen('/').view(() => ({
    text: 'Collections',
    keyboard: [[link('Photo sessions', card, { slug })]],
  }));
  const atError: (ScreenChatState | undefined)[] = [];
  const screens = tg.create({
    screens: [home, card],
    storage,
    chats: 'all',
    onError: async (error, c) => {
      expect(String(error)).toContain(refused);
      atError.push(await storage.read('screens:1000'));
      return c.toast(retry, { alert: true });
    },
  });
  const bot = new Bot<Context>('0:test');
  bot.use(screens);
  bot.command('start', (ctx) => screens.open(ctx, home));
  return { chat: createScreenTestChat(bot, { chatType, userId: 42_001 }), storage, atError };
}

describe('telegram screens: a refused rich screen', () => {
  test('the original menu, its token and its message survive a refused send', async () => {
    const { chat, storage, atError } = menu();
    await chat.send('/start');
    const before = await storage.read('screens:1000');
    const message = chat.messages.at(-1);
    const button = message?.markup?.inline_keyboard[0]?.[0];
    if (!message || !button || !('callback_data' in button)) throw new Error('No menu button');
    expect(Object.keys(before?.view?.tokens ?? {})).toHaveLength(1);
    chat.clearCalls();
    chat.failNext('sendRichMessage', refused, 400);
    await chat.pressData(message.id, button.callback_data);
    expect(atError).toEqual([before]);
    const after = await storage.read('screens:1000');
    expect(after?.view).toEqual(before?.view);
    expect(after?.expiring.map((remark) => remark.id)).toEqual([
      chat.messages.at(-1)?.id ?? 0,
    ]);
    expect(chat.messages.find((m) => m.id === message.id)).toEqual(message);
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendRichMessage',
      'sendMessage',
    ]);
    expect(chat.messages.at(-1)?.text).toBe('Try &lt;again&gt; &amp; retry');
    expect(chat.messages.some((m) => m.kind === 'rich')).toBe(false);
    chat.clearCalls();
    await chat.pressData(message.id, button.callback_data);
    expect(chat.messages.filter((m) => m.from === 'bot').map((m) => m.kind)).toEqual(['rich']);
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'deleteMessage',
      'sendRichMessage',
      'deleteMessage',
    ]);
  });

  test('in a group only the user who pressed receives the late error', async () => {
    const { chat } = menu('group');
    await chat.send('/start');
    chat.clearCalls();
    chat.failNext('sendRichMessage', refused);
    await chat.press('Photo sessions');
    const ack = chat.calls.filter((call) => call.method === 'answerCallbackQuery');
    expect(ack).toHaveLength(1);
    expect(chat.calls.find((call) => call.method === 'sendMessage')?.payload).toMatchObject({
      text: 'Try &lt;again&gt; &amp; retry',
      ephemeral_message_parameters: {
        receiver_user_id: 42_001,
        callback_query_id: ack[0]?.payload.callback_query_id,
      },
    });
  });

  test('records a confirmed edit and leaves only the edit with a lost reply uncertain', async () => {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const next = tg
      .screen('/next')
      .view(() => [
        { photo: 'cover', caption: 'New cover' },
        { text: 'New body' },
        { text: 'New footer' },
      ]);
    const home = tg
      .screen('/')
      .view(() => [
        { photo: 'cover', caption: 'Cover' },
        { text: 'Body' },
        { text: 'Footer', keyboard: [[link('Next', next)]] },
      ]);
    const bot = new Bot('0:test');
    bot.catch((error) => {
      throw error.error;
    });
    const screens = tg.create({ screens: [home, next], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const before = (await storage.read('screens:1000'))?.view;
    chat.failNext('editMessageText', 'Internal Server Error', 500);
    await expect(chat.press('Next')).rejects.toThrow('Internal Server Error');
    const after = (await storage.read('screens:1000'))?.view;
    expect(after?.screen).toBe(before?.screen);
    expect(after?.messages.map((m) => m.id)).toEqual(before?.messages.map((m) => m.id));
    expect(after?.messages[0]?.fingerprint?.content).not.toBe(
      before?.messages[0]?.fingerprint?.content,
    );
    expect(after?.messages[1]?.fingerprint).toBeNull();
    expect(after?.messages[2]).toEqual(before?.messages[2]);
    expect(chat.messages.some((m) => m.text === 'New cover')).toBe(true);
    await chat.press('Next');
    expect((await storage.read('screens:1000'))?.view?.screen).toBe(next.definition.id);
  });

  test('a full menu and the visible part of its replacement survive together', async () => {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const home = tg
      .screen('/')
      .view(() => Array.from({ length: 100 }, (_, i) => ({ text: String(i) })));
    const photos = Array.from({ length: 99 }, (_, i) => ({ photo: `cover-${i}` }));
    const next = tg.screen('/next').view(() => [...photos, { rich: { markdown: 'Card' } }]);
    const bot = new Bot('0:test');
    bot.catch((error) => {
      throw error.error;
    });
    const screens = tg.create({ screens: [home, next], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.command('next', (ctx) => screens.open(ctx, next, {}, { previous: 'delete' }));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const before = (await storage.read('screens:1000'))?.view;
    chat.failNext('sendRichMessage', refused);
    await expect(chat.send('/next')).rejects.toThrow(refused);
    const partial = (await storage.read('screens:1000'))?.view;
    expect(partial?.messages).toHaveLength(199);
    expect(partial?.messages.slice(0, 100)).toEqual(before?.messages);
    expect(partial?.messages.at(-1)?.id).toBe(chat.messages.at(-1)?.id);
    chat.failNext('sendRichMessage', refused);
    await expect(chat.send('/next')).rejects.toThrow(refused);
    expect((await storage.read('screens:1000'))?.view).toEqual(partial);
    expect(chat.messages.filter((m) => m.from === 'bot')).toHaveLength(199);
    await chat.send('/next');
    expect(chat.messages.filter((m) => m.from === 'bot')).toHaveLength(100);
    expect(chat.messages.at(-1)?.kind).toBe('rich');
    expect((await storage.read('screens:1000'))?.view?.screen).toBe(next.definition.id);
  });

  test('a toast reports a failed render without retrying the same action inside the press', async () => {
    const tg = telegramScreens();
    let page = 0;
    const screen = tg
      .screen('/')
      .action('next', () => {
        page++;
      })
      .view(({ act }) => ({
        ...(page ? { rich: { markdown: String(page) } } : { text: 'Menu' }),
        keyboard: [[act.next('Next')]],
      }));
    const bot = new Bot('0:test');
    const screens = tg.create({
      screens: [screen],
      storage: new MemorySessionStorage<ScreenChatState>(),
      onError: (_error, c) => c.stay().toast('Failed'),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, screen));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const menuId = chat.messages.at(-1)?.id;
    chat.clearCalls();
    chat.failNext('sendRichMessage', refused);
    await chat.press('Next');
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendRichMessage',
      'sendMessage',
    ]);
    expect(chat.messages.find((m) => m.id === menuId)?.buttons).toEqual([['Next']]);
    expect(chat.messages.at(-1)?.text).toBe('Failed');
    await chat.press('Next');
    expect(chat.messages.at(-1)?.kind).toBe('rich');
  });

  test('a failed open inside a press reports the error once and stops the action', async () => {
    const tg = telegramScreens();
    const card = tg.screen('/card').view(() => ({ rich: { markdown: 'Card' } }));
    const home = tg
      .screen('/')
      .action('open', async (c) => {
        await screens.open(c.ctx, card);
        return c.toast('Opened');
      })
      .view(({ act }) => ({ text: 'Menu', keyboard: [[act.open('Open')]] }));
    const screens = tg.create({
      screens: [home, card],
      storage: new MemorySessionStorage<ScreenChatState>(),
      onError: (_error, c) => c.toast('Failed'),
    });
    const bot = new Bot('0:test');
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const original = chat.messages.at(-1);
    chat.clearCalls();
    chat.failNext('sendRichMessage', refused);
    await chat.press('Open');
    expect(chat.answers).toEqual(['Failed']);
    expect(chat.messages.at(-1)).toEqual(original);
    await chat.press('Open');
    expect(chat.answers).toEqual(['Failed', 'Opened']);
    expect(chat.messages.at(-1)?.kind).toBe('rich');
  });

  test('only keyboards reached before the failure contribute new spilled tokens', async () => {
    const tg = telegramScreens();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const target = tg
      .screen('/item/:slug')
      .load(() => ({}))
      .view(() => ({ text: 'Item' }));
    const buttons = (set: string, n: number) =>
      Array.from({ length: n }, (_, i) => [
        link('Open', target, { slug: set.repeat(85) + i }),
      ]);
    const home = tg.screen('/').view(() => ({ text: 'Menu', keyboard: buttons('a', 100) }));
    const next = tg
      .screen('/next')
      .view(() => [
        { photo: 'cover' },
        { rich: { markdown: 'Card' }, keyboard: buttons('b', 100) },
      ]);
    const third = tg
      .screen('/third')
      .view(() => ({ text: 'Third', keyboard: buttons('c', 1) }));
    const bot = new Bot('0:test');
    bot.catch((error) => {
      throw error.error;
    });
    const screens = tg.create({ screens: [home, next, third, target], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.command('next', (ctx) => screens.open(ctx, next, {}, { previous: 'delete' }));
    bot.command('third', (ctx) => screens.open(ctx, third, {}, { previous: 'delete' }));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const tokens = (await storage.read('screens:1000'))?.view?.tokens;
    expect(Object.keys(tokens ?? {})).toHaveLength(100);
    chat.failNext('sendRichMessage', refused);
    await expect(chat.send('/next')).rejects.toThrow(refused);
    expect((await storage.read('screens:1000'))?.view?.tokens).toEqual(tokens);
    await chat.send('/third');
    expect(chat.messages.at(-1)?.text).toBe('Third');
    expect(Object.keys((await storage.read('screens:1000'))?.view?.tokens ?? {})).toHaveLength(
      1,
    );
  });
});
