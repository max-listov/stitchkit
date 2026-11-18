/**
 * What the chat and its record hold after a display that Telegram refused:
 * the report of the failure, and each branch that keeps the record true.
 */
import { describe, expect, test } from 'bun:test';
import { Bot, MemorySessionStorage } from 'grammy';
import {
  createScreenTestChat,
  link,
  type ScreenChatState,
  type ScreenHandlerResult,
  type ScreenOutcomeBuilders,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

const refused = 'Bad Request: failed to get HTTP URL content';
const CHAT = 'screens:1000';

function strictBot(): Bot {
  const bot = new Bot('0:test');
  bot.catch((error) => {
    throw error.error;
  });
  return bot;
}

/** One screen whose action turns its text view into a rich one. */
function pager(onError: (c: ScreenOutcomeBuilders) => ScreenHandlerResult) {
  const tg = telegramScreens();
  const storage = new MemorySessionStorage<ScreenChatState>();
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
  const bot = strictBot();
  const screens = tg.create({
    screens: [screen],
    storage,
    onError: (_error, c) => onError(c),
  });
  bot.use(screens);
  bot.command('start', (ctx) => screens.open(ctx, screen));
  return { chat: createScreenTestChat(bot), storage };
}

describe('telegram screens: the report of a refused display', () => {
  test('a late toast is a remark of the screen and leaves with the next view', async () => {
    const { chat, storage } = pager((c) => c.toast('Failed'));
    await chat.send('/start');
    for (let attempt = 0; attempt < 3; attempt++) {
      chat.failNext('sendRichMessage', refused);
      await chat.press('Next');
      const said = chat.messages.filter((m) => m.text === 'Failed');
      expect(said).toHaveLength(1);
      expect((await storage.read(CHAT))?.expiring.map((remark) => remark.id)).toEqual([
        said[0]?.id ?? 0,
      ]);
    }
    await chat.press('Next');
    expect(chat.messages.filter((m) => m.from === 'bot').map((m) => m.kind)).toEqual(['rich']);
    expect((await storage.read(CHAT))?.expiring).toEqual([]);
  });

  for (const [name, onError, said] of [
    ['stay()', (c: ScreenOutcomeBuilders) => c.stay(), []],
    ['a notice', (c: ScreenOutcomeBuilders) => c.notice('Failed'), ['Failed']],
    ['a toast', (c: ScreenOutcomeBuilders) => c.toast('Failed'), ['Failed']],
  ] as const) {
    test(`${name} from onError does not draw the refused view again`, async () => {
      const { chat } = pager(onError);
      await chat.send('/start');
      const menu = chat.messages.at(-1);
      chat.clearCalls();
      chat.failNext('sendRichMessage', refused);
      await chat.press('Next');
      const methods = chat.calls.map((call) => call.method);
      expect(methods.filter((method) => method === 'sendRichMessage')).toHaveLength(1);
      expect(methods).not.toContain('deleteMessage');
      expect(chat.messages.find((m) => m.id === menu?.id)).toEqual(menu);
      expect(chat.messages.filter((m) => m.id !== menu?.id && m.from === 'bot')).toHaveLength(
        said.length,
      );
      expect(chat.messages.filter((m) => m.text === 'Failed')).toHaveLength(said.length);
    });
  }

  test('a handler that threw still has its screen loaded and drawn anew', async () => {
    const tg = telegramScreens();
    let count = 0;
    const screen = tg
      .screen('/')
      .action('add', () => {
        count++;
        throw new Error('after the write');
      })
      .view(({ act }) => ({ text: `Count ${count}`, keyboard: [[act.add('Add')]] }));
    const bot = strictBot();
    const screens = tg.create({
      screens: [screen],
      storage: new MemorySessionStorage<ScreenChatState>(),
      onError: (_error, c) => c.toast('Failed'),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, screen));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.press('Add');
    expect(chat.answers).toEqual(['Failed']);
    expect(chat.messages.at(-1)?.text).toBe('Count 1');
  });
});

describe('telegram screens: the record after a plan stopped halfway', () => {
  const longSlug = (set: string, index = 0) => set.repeat(85) + index;

  test('a button on a message drawn before the failure is understood', async () => {
    const tg = telegramScreens();
    const item = tg
      .screen('/item/:slug')
      .load(() => ({}))
      .view(() => ({ text: 'Item' }));
    const next = tg
      .screen('/next')
      .view(() => [
        { text: 'Top', keyboard: [[link('Open', item, { slug: longSlug('n') })]] },
        { rich: { markdown: 'Card' } },
      ]);
    const home = tg
      .screen('/')
      .view(() => ({ text: 'Menu', keyboard: [[link('Next', next)]] }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [home, next, item], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    chat.failNext('sendRichMessage', refused);
    await expect(chat.press('Next')).rejects.toThrow(refused);
    expect(Object.keys((await storage.read(CHAT))?.view?.tokens ?? {})).toHaveLength(1);
    await chat.press('Open');
    expect(chat.messages.some((m) => m.text === 'Item')).toBe(true);
  });

  test('tokens of a keyboard no message shows any more leave the record', async () => {
    const tg = telegramScreens();
    const item = tg
      .screen('/item/:slug')
      .load(() => ({}))
      .view(() => ({ text: 'Item' }));
    const next = tg.screen('/next').view(() => [
      {
        key: 'main',
        text: 'Top',
        keyboard: [[link('Open', item, { slug: longSlug('n') })]],
      },
      { key: 'tail', rich: { markdown: 'Card' } },
    ]);
    const home = tg.screen('/').view(() => ({
      text: 'Menu',
      keyboard: [[link('Open', item, { slug: longSlug('h') })], [link('Next', next)]],
    }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [home, next, item], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const before = Object.keys((await storage.read(CHAT))?.view?.tokens ?? {});
    expect(before).toHaveLength(1);
    chat.failNext('sendRichMessage', refused);
    await expect(chat.press('Next')).rejects.toThrow(refused);
    const after = Object.keys((await storage.read(CHAT))?.view?.tokens ?? {});
    expect(after).toHaveLength(1);
    expect(after).not.toEqual(before);
  });

  test('a view whose tokens the record cannot add is sent before anything is edited', async () => {
    const tg = telegramScreens();
    const item = tg
      .screen('/item/:slug')
      .load(() => ({}))
      .view(() => ({ text: 'Item' }));
    const buttons = (set: string) =>
      Array.from({ length: 100 }, (_, i) => [link('Open', item, { slug: longSlug(set, i) })]);
    const card = (set: string) => () => [
      { key: 'top', text: `Top ${set}`, keyboard: buttons(set) },
      { key: 'main', rich: { markdown: set } },
    ];
    const b = tg.screen('/b').view(card('b'));
    const c = tg.screen('/c').view(card('c'));
    const home = tg.screen('/').view(() => [
      { key: 'top', text: 'Top a', keyboard: buttons('a') },
      { key: 'main', text: 'Menu', keyboard: [[link('To B', b)], [link('To C', c)]] },
    ]);
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [home, b, c, item], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    chat.failNext('sendRichMessage', refused);
    await expect(chat.press('To B')).rejects.toThrow(refused);
    const full = await storage.read(CHAT);
    expect(Object.keys(full?.view?.tokens ?? {})).toHaveLength(200);
    expect(chat.messages.some((m) => m.text === 'Top b')).toBe(true);

    chat.clearCalls();
    chat.failNext('sendRichMessage', refused);
    await expect(chat.press('To C')).rejects.toThrow(refused);
    expect(chat.calls.map((call) => call.method)).not.toContain('editMessageText');
    expect(await storage.read(CHAT)).toEqual(full);
    expect(chat.messages.some((m) => m.text === 'Top b')).toBe(true);
    expect(chat.messages.some((m) => m.text === 'Top c')).toBe(false);

    await chat.press('To C');
    const view = (await storage.read(CHAT))?.view;
    expect(view?.screen).toBe(c.definition.id);
    expect(Object.keys(view?.tokens ?? {})).toHaveLength(100);
  });

  test('a press outside a record that is full sends the view instead of adopting the message', async () => {
    const tg = telegramScreens();
    const next = tg.screen('/next').view(() => ({ text: 'Next' }));
    const home = tg
      .screen('/')
      .view(() => ({ text: 'Menu', keyboard: [[link('Next', next)]] }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [home, next], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await storage.write(CHAT, {
      version: 1,
      expiring: [],
      view: {
        screen: home.definition.id,
        params: {},
        tokens: {},
        messages: Array.from({ length: 201 }, (_, i) => ({
          key: `k${i}`,
          id: 5000 + i,
          kind: 'text' as const,
          fingerprint: null,
        })),
      },
    });
    chat.clearCalls();
    chat.failNext('editMessageText', 'Internal Server Error', 500);
    await chat.press('Next');
    expect(chat.calls.map((call) => call.method)).not.toContain('editMessageText');
    expect(chat.messages.at(-1)?.text).toBe('Next');
    expect((await storage.read(CHAT))?.view?.messages).toHaveLength(1);
  });

  test('a message pressed outside the record is recorded with the view that replaces it', async () => {
    const tg = telegramScreens();
    const next = tg
      .screen('/next')
      .view(() => [{ text: 'Top' }, { rich: { markdown: 'Card' } }]);
    const home = tg
      .screen('/')
      .view(() => ({ text: 'Menu', keyboard: [[link('Next', next)]] }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [home, next], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const outside = chat.messages.at(-1);
    await chat.send('/start');
    const recorded = chat.messages.at(-1);
    const data = (message: typeof outside) => {
      const button = message?.markup?.inline_keyboard[0]?.[0];
      if (!message || !button || !('callback_data' in button)) throw new Error('No button');
      return [message.id, button.callback_data] as const;
    };
    chat.failNext('sendRichMessage', refused);
    await expect(chat.pressData(...data(outside))).rejects.toThrow(refused);
    expect((await storage.read(CHAT))?.view?.messages.map((m) => m.id)).toContain(
      outside?.id ?? 0,
    );
    await chat.pressData(...data(recorded));
    expect(chat.messages.filter((m) => m.from === 'bot').map((m) => m.kind)).toEqual([
      'text',
      'rich',
    ]);
  });

  test('a message the user deleted leaves the record when its view cannot be sent anew', async () => {
    const tg = telegramScreens();
    let round = 0;
    const screen = tg
      .screen('/')
      .on('text', () => {
        round++;
      })
      .view(() => [{ text: `Top ${round}` }, { rich: { markdown: `Card ${round}` } }]);
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [screen], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, screen));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const [top, card] = (await storage.read(CHAT))?.view?.messages ?? [];
    if (!top || !card) throw new Error('No view');
    chat.deleteByUser(top.id);
    chat.failNext('sendRichMessage', refused);
    await expect(chat.send('again')).rejects.toThrow(refused);
    const ids = (await storage.read(CHAT))?.view?.messages.map((m) => m.id) ?? [];
    expect(ids).toHaveLength(2);
    expect(ids).toContain(card.id);
    expect(ids).not.toContain(top.id);
  });

  test('a view of which nothing is left is recorded as no view', async () => {
    const tg = telegramScreens();
    let round = 0;
    const screen = tg
      .screen('/')
      .on('text', () => {
        round++;
      })
      .view(() => ({ text: `Menu ${round}` }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    const bot = strictBot();
    const screens = tg.create({ screens: [screen], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, screen));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const menu = chat.messages.at(-1);
    if (!menu) throw new Error('No menu');
    chat.deleteByUser(menu.id);
    chat.failNext('sendMessage', refused);
    await expect(chat.send('again')).rejects.toThrow(refused);
    expect((await storage.read(CHAT))?.view ?? null).toBeNull();
  });
});
