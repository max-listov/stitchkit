/**
 * Telegram screens: the chat's record says what the chat shows — whatever
 * Telegram refused, whichever handler opened what — and input that may be a
 * secret leaves the chat before any application code decides anything.
 *
 * Each test drives a real `Bot` through `createScreenTestChat` and then asks
 * the record itself, not only the chat: a record that drifted from the chat is
 * invisible until the next message is routed by it.
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
  type TelegramScreenStorage,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

const RATE_LIMIT = 'Too Many Requests: retry after 5';

const botTexts = (chat: ReturnType<typeof createScreenTestChat>) =>
  chat.messages.filter((message) => message.from === 'bot').map((message) => message.text);

/** Home with a text input, an editor screen that also takes text, and a two-message screen. */
function workshop(
  storage: TelegramScreenStorage = new MemorySessionStorage<ScreenChatState>(),
) {
  const tg = telegramScreens<Context>();
  const saved: string[] = [];
  const home = tg
    .screen('/')
    .on('text', (c) => {
      saved.push(`home:${c.text}`);
    })
    .view(() => ({
      text: html`<b>Home</b>`,
      keyboard: [[link('Edit', editor)], [link('Parts', parts)]],
    }));
  const editor = tg
    .screen('/edit')
    .on('text', (c) => {
      saved.push(`edit:${c.text}`);
    })
    .view(() => ({ text: html`<b>Editor</b>`, keyboard: [[back('« Back')]] }));
  let refreshed = 0;
  const board = tg
    .screen('/board')
    .action('refresh', () => {
      refreshed += 1;
    })
    .view(({ act }) => [
      { key: 'header', photo: 'board-file', caption: `Board ${refreshed}` },
      { text: 'board body', keyboard: [[act.refresh('Refresh')]] },
    ]);
  const gallery = tg
    .screen('/gallery')
    .view(() => [{ key: 'cover', photo: 'cover-file' }, { text: 'gallery body' }]);
  const parts = tg.screen('/parts').view(() => [
    { key: 'header', text: html`<b>Parts ↓</b>` },
    { text: 'two parts', keyboard: [[back('« Back')]] },
  ]);
  const errors: unknown[] = [];
  const bot = new Bot<Context>('0:test');
  const screens = tg.create({ screens: [home, editor, parts, board, gallery], storage });
  bot.use(screens);
  bot.command('start', (ctx) => screens.open(ctx, home));
  bot.command('menu', (ctx) => screens.open(ctx, parts));
  bot.command('board', (ctx) => screens.open(ctx, board));
  bot.command('gallery', (ctx) => screens.open(ctx, gallery));
  bot.catch((error) => {
    errors.push(error.error);
  });
  return { storage, saved, errors, chat: createScreenTestChat(bot) };
}

const recordOf = async (storage: TelegramScreenStorage) => storage.read('screens:1000');

describe('telegram screens: a plan Telegram stopped halfway', () => {
  test('leaves the chat on the screen it was on: its input still answers', async () => {
    const { chat, saved, errors, storage } = workshop();
    await chat.send('/start');
    const before = await recordOf(storage);
    chat.failNext('editMessageText', RATE_LIMIT, 429);
    await chat.press('Edit');
    expect(errors).toHaveLength(1);
    expect(botTexts(chat)).toEqual(['<b>Home</b>']);
    expect((await recordOf(storage))?.view?.screen).toBe(before?.view?.screen);
    await chat.send('hello');
    expect(saved).toEqual(['home:hello']);
  });

  test('a view that failed halfway below keeps the one above it tracked', async () => {
    const { chat, storage } = workshop();
    await chat.send('/start');
    const home = (await recordOf(storage))?.view?.messages.map((message) => message.id) ?? [];
    // The cover photo goes out; the body after it is refused.
    chat.failNext('sendMessage', RATE_LIMIT, 429);
    await chat.send('/gallery');
    const cover = chat.messages.find((message) => message.kind === 'photo');
    expect((await recordOf(storage))?.view?.messages.map((message) => message.id)).toEqual([
      ...home,
      cover?.id ?? -1,
    ]);
  });

  test('messages sent anew are recorded below the ones they replaced, and repair in order', async () => {
    const { chat } = workshop();
    await chat.send('/board');
    const header = chat.messages.find((message) => message.text === 'Board 0');
    chat.deleteByUser(header?.id ?? -1);
    // The header is resent at the bottom; sending the body after it is refused.
    chat.failNext('sendMessage', RATE_LIMIT, 429);
    await chat.press('Refresh');
    expect(botTexts(chat)).toEqual(['board body', 'Board 1']);
    await chat.press('Refresh');
    expect(botTexts(chat)).toEqual(['Board 2', 'board body']);
  });

  test('a remark Telegram refuses after the view is drawn still leaves the view recorded', async () => {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const home = tg
      .screen('/')
      .action('next', (c) => c.go(second).notice('hint', { expiresInMs: 60_000 }))
      .view(({ act }) => [
        { key: 'hdr', text: 'hdr' },
        { text: 'home', keyboard: [[act.next('Next')]] },
      ]);
    const second = tg.screen('/second').view(() => ({ text: 'second' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({ screens: [home, second], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.catch(() => undefined);
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    chat.clearCalls();
    // `second` takes the body over by editing it; the remark is the one send.
    chat.failNext('sendMessage', RATE_LIMIT, 429);
    await chat.press('Next');
    const shown = chat.messages.map((message) => message.id);
    const record = await recordOf(storage);
    expect(record?.view?.screen).toBe(second.definition.id);
    for (const message of record?.view?.messages ?? []) expect(shown).toContain(message.id);
  });
});

describe('telegram screens: open inside a handler', () => {
  function opener(answer: 'toast' | 'go' | 'notice') {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const errors: unknown[] = [];
    const home = tg
      .screen('/')
      .action('open', async (c) => {
        await screens.open(c.ctx, other);
        if (answer === 'go') return c.go(other);
        if (answer === 'notice') return c.notice('opened');
        return c.toast('Opened');
      })
      .view(({ act }) => ({ text: 'home', keyboard: [[act.open('Open')]] }));
    const other = tg.screen('/other').view(() => ({ text: 'other' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({ screens: [home, other], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.catch((error) => {
      errors.push(error.error);
    });
    return { chat: createScreenTestChat(bot), storage, errors, other };
  }

  test('the opened screen stands: the record follows it, the press gets its toast', async () => {
    const { chat, storage, other } = opener('toast');
    await chat.send('/start');
    await chat.press('Open');
    const shown = chat.messages.find((message) => message.text === 'other');
    expect(chat.answers).toEqual(['Opened']);
    expect((await recordOf(storage))?.view?.screen).toBe(other.definition.id);
    expect((await recordOf(storage))?.view?.messages.map((message) => message.id)).toEqual([
      shown?.id ?? -1,
    ]);
  });

  test('navigating or posting after open is refused, not silently dropped', async () => {
    for (const answer of ['go', 'notice'] as const) {
      const { chat, errors } = opener(answer);
      await chat.send('/start');
      await chat.press('Open');
      expect(String(errors[0])).toContain('open()');
    }
  });
});

describe('telegram screens: input that may be a secret', () => {
  function vault(load: 'redirect' | 'throw') {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const received: string[] = [];
    let gone = false;
    const home = tg
      .screen('/')
      .view(() => ({ text: 'home', keyboard: [[link('Token', token, { botId: 'b1' })]] }));
    const token = tg
      .group('/bot/:botId')
      .load((c) => {
        if (!gone) return { bot: c.params.botId };
        if (load === 'throw') throw new Error('database is down');
        return c.go(home);
      })
      .screen('/token')
      .on('text', (c) => {
        received.push(c.text);
      })
      .view(() => ({ text: 'Send the token' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({ screens: [home, token], storage });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.catch(() => undefined);
    const chat = createScreenTestChat(bot);
    return {
      chat,
      received,
      remove: () => {
        gone = true;
      },
    };
  }

  test('leaves the chat before a load that redirects, and before a load that throws', async () => {
    for (const load of ['redirect', 'throw'] as const) {
      const { chat, received, remove } = vault(load);
      await chat.send('/start');
      await chat.press('Token');
      remove();
      await chat.send('123456:SECRET');
      expect(chat.messages.map((message) => message.text)).not.toContain('123456:SECRET');
      expect(received).toEqual([]);
    }
  });

  test('a storage that cannot answer fails the message instead of passing it on', async () => {
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
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .on('text', () => undefined)
      .view(() => ({ text: 'home' }));
    const bot = new Bot<Context>('0:test');
    const handled: string[] = [];
    const screens = tg.create({
      screens: [home],
      storage,
      // With the storage down there is no record to show an outcome against.
      onError: (_error, c) => {
        handled.push(c.trigger);
      },
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const fellThrough: string[] = [];
    bot.on('message:text', (ctx) => {
      fellThrough.push(ctx.message.text);
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    broken = true;
    await chat.send('reply');
    expect(fellThrough).toEqual([]);
    expect(handled).toEqual(['input']);
  });
});

describe('telegram screens: what a load guards', () => {
  test('a param added below the last load is refused when the bot is composed', () => {
    const tg = telegramScreens<Context>();
    const owned = tg.group('/project/:projectId').load(() => ({ allowed: true }));
    const rule = owned.screen('/rule/:ruleId').view(() => ({ text: 'rule' }));
    const checked = owned
      .screen('/member/:memberId')
      .load(() => ({ member: true }))
      .view(() => ({ text: 'member' }));
    const storage = new MemorySessionStorage<ScreenChatState>();
    expect(() => tg.create({ screens: [rule], storage })).toThrow(/load/);
    expect(() => tg.create({ screens: [checked], storage })).not.toThrow();
  });
});

describe('telegram screens: remarks', () => {
  test('a chat keeps at most a hundred remarks; the oldest goes to make room', async () => {
    const tg = telegramScreens<Context>();
    const storage = new MemorySessionStorage<ScreenChatState>();
    const events: ScreenEvent[] = [];
    const home = tg
      .screen('/')
      .on('text', (c) => c.notice(`bad ${c.text}`, { expiresInMs: 60_000 }))
      .view(() => ({ text: 'home' }));
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home],
      storage,
      onEvent: (event) => events.push(event),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    for (let index = 0; index < 103; index += 1) await chat.send(String(index));
    const remarks = botTexts(chat).filter((text) => text.startsWith('bad '));
    expect(remarks).toHaveLength(100);
    expect(remarks[0]).toBe('bad 3');
    expect((await recordOf(storage))?.expiring).toHaveLength(100);
    screens.close();
  });
});
