/**
 * Telegram screens: presses at the edges — why a press is stale, buttons whose
 * address is kept in the record, a chat pressing faster than Telegram answers,
 * screen ids across releases, and the options a screen and the test chat take.
 */
import { describe, expect, test } from 'bun:test';
import { Bot, type Context, MemorySessionStorage } from 'grammy';
import type { Update } from 'grammy/types';
import { z } from 'zod';
import {
  type AnyTelegramScreen,
  createScreenTestChat,
  link,
  type ScreenChatState,
  type ScreenStaleReason,
  type TelegramScreensConfig,
  type TelegramScreensRoot,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

type Declared = {
  readonly screens: TelegramScreensConfig<Context>['screens'];
  readonly start: AnyTelegramScreen;
};
type Build = (tg: TelegramScreensRoot<Context>) => Declared;

/** A bot over `storage`, its screens built by `build`, recording stale reasons and errors. */
function botOver(
  storage: MemorySessionStorage<ScreenChatState>,
  build: Build,
  config: Partial<TelegramScreensConfig<Context>> = {},
) {
  const tg = telegramScreens<Context>();
  const { screens: declared, start } = build(tg);
  const stale: ScreenStaleReason[] = [];
  const errors: unknown[] = [];
  const bot = new Bot<Context>('0:test');
  const screens = tg.create({
    screens: declared,
    storage,
    onStale: (c) => {
      stale.push(c.reason);
    },
    ...config,
  });
  bot.use(screens);
  bot.command('start', (ctx) => screens.open(ctx, start, {}));
  bot.catch((error) => {
    errors.push(error.error);
  });
  return { bot, stale, errors };
}

describe('telegram screens: why a press is stale', () => {
  test('a press no button carried is forged', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const { bot, stale } = botOver(storage, (tg) => {
      const home = tg.screen('/').view(() => ({ text: 'home' }));
      return { screens: [home], start: home };
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const home = chat.messages.find((message) => message.text === 'home');
    await chat.pressData(home?.id ?? -1, '~anything');
    expect(stale).toEqual(['forged']);
  });

  test('a press on a message Telegram no longer shows the bot is inaccessible', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const { bot, stale } = botOver(storage, (tg) => {
      const home = tg.screen('/').view(() => ({ text: 'home' }));
      return { screens: [home], start: home };
    });
    const chat = createScreenTestChat(bot);
    const update: Update = {
      update_id: 1,
      callback_query: {
        id: 'old',
        from: { id: 1000, is_bot: false, first_name: 'Test' },
        chat_instance: 'test',
        data: '~anything',
        message: {
          chat: { id: 1000, type: 'private', first_name: 'Test' },
          message_id: 1,
          date: 0,
        },
      },
    };
    await bot.handleUpdate(update);
    expect(stale).toEqual(['inaccessible']);
    expect(chat.answers).toEqual(['']);
  });

  test('a button of an action the new release dropped, or whose input it now refuses', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const before = botOver(storage, (tg) => {
      const home = tg
        .screen('/')
        .action('rename', z.object({ n: z.number() }), () => undefined)
        .action('drop', () => undefined)
        .view(({ act }) => ({
          text: 'home',
          keyboard: [[act.rename('Rename', { n: 1 })], [act.drop('Drop')]],
        }));
      return { screens: [home], start: home };
    });
    const chat = createScreenTestChat(before.bot);
    await chat.send('/start');
    const after = botOver(storage, (tg) => {
      const home = tg
        .screen('/')
        .action('rename', z.object({ n: z.string() }), () => undefined)
        .view(({ act }) => ({ text: 'home', keyboard: [[act.rename('Rename', { n: 'a' })]] }));
      return { screens: [home], start: home };
    });
    chat.restart(after.bot);
    await chat.press('Drop');
    await chat.press('Rename');
    expect(after.stale).toEqual(['unknown-action', 'invalid-input']);
  });

  test('an answer Telegram stopped waiting for is not a failure of the screen', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const { bot, errors } = botOver(storage, (tg) => {
      const home = tg
        .screen('/')
        .view(() => ({ text: 'home', keyboard: [[link('Next', next)]] }));
      const next = tg.screen('/next').view(() => ({ text: 'next' }));
      return { screens: [home, next], start: home };
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    chat.failNext(
      'answerCallbackQuery',
      'Bad Request: query is too old and response timeout expired or query ID is invalid',
    );
    await chat.press('Next');
    expect(errors).toEqual([]);
    expect(chat.messages.map((message) => message.text)).toContain('next');
  });

  test('a press in a chat the application keeps no record for is answered, not left spinning', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const { bot, errors } = botOver(
      storage,
      (tg) => {
        const home = tg.screen('/').view(() => ({ text: 'home' }));
        return { screens: [home], start: home };
      },
      { chatKey: () => undefined },
    );
    const chat = createScreenTestChat(bot);
    await bot.api.sendMessage(1000, 'menu', {
      reply_markup: { inline_keyboard: [[{ text: 'Go', callback_data: '~x' }]] },
    });
    await chat.press('Go');
    expect(chat.answers).toEqual(['']);
    expect(errors).toEqual([]);
  });
});

describe('telegram screens: buttons whose address is kept in the record', () => {
  test('a button too long for Telegram works through a token, and an unchanged keyboard is left alone', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const renamed: string[] = [];
    const { bot } = botOver(storage, (tg) => {
      const home = tg
        .screen('/')
        .action('rename', z.object({ name: z.string() }), (c) => {
          renamed.push(c.input.name);
        })
        .view(({ act }) => ({
          text: 'home',
          keyboard: [[act.rename('Rename', { name: 'n'.repeat(80) })]],
        }));
      return { screens: [home], start: home };
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const data = chat.messages[1]?.markup?.inline_keyboard[0]?.[0];
    expect(data && 'callback_data' in data ? data.callback_data.startsWith('~#') : false).toBe(
      true,
    );
    chat.clearCalls();
    await chat.press('Rename');
    await chat.press('Rename');
    expect(renamed).toEqual(['n'.repeat(80), 'n'.repeat(80)]);
    // The same button renders the same token: nothing to edit.
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'answerCallbackQuery',
    ]);
  });
});

describe('telegram screens: a chat pressing faster than Telegram answers', () => {
  test('at most sixteen updates of one chat wait; the rest are answered and refused', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bot, errors } = botOver(storage, (tg) => {
      const home = tg
        .screen('/')
        .action('wait', () => gate)
        .view(({ act }) => ({ text: 'home', keyboard: [[act.wait('Wait')]] }));
      return { screens: [home], start: home };
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const presses = Array.from({ length: 18 }, () => chat.press('Wait'));
    await Bun.sleep(10);
    release();
    await Promise.all(presses);
    expect(errors.map(String)).toEqual([
      'Error: Mutation queue capacity exceeded',
      'Error: Mutation queue capacity exceeded',
    ]);
    expect(chat.answers).toHaveLength(18);
  });
});

describe('telegram screens: screen ids', () => {
  test('an explicit id keeps sent buttons working after the path is renamed; a derived one does not', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const before = botOver(storage, (tg) => {
      const kept = tg.screen('/items', { id: 'items' }).view(() => ({ text: 'items' }));
      const lost = tg.screen('/parts').view(() => ({ text: 'parts' }));
      const home = tg.screen('/').view(() => ({
        text: 'home',
        keyboard: [[link('Items', kept)], [link('Parts', lost)]],
      }));
      return { screens: [home, kept, lost], start: home };
    });
    const chat = createScreenTestChat(before.bot);
    await chat.send('/start');
    const after = botOver(storage, (tg) => {
      const kept = tg
        .screen('/catalogue', { id: 'items' })
        .view(() => ({ text: 'catalogue' }));
      const lost = tg.screen('/pieces').view(() => ({ text: 'pieces' }));
      const home = tg.screen('/').view(() => ({
        text: 'home',
        keyboard: [[link('Items', kept)], [link('Parts', lost)]],
      }));
      return { screens: [home, kept, lost], start: home };
    });
    chat.restart(after.bot);
    await chat.press('Parts');
    expect(after.stale).toEqual(['unknown-screen']);
    await chat.press('Items');
    expect(chat.messages.map((message) => message.text)).toContain('catalogue');
  });

  test('two screens with one id are refused when the bot is composed', () => {
    const tg = telegramScreens<Context>();
    const one = tg.screen('/one', { id: 'same' }).view(() => ({ text: '1' }));
    const two = tg.screen('/two', { id: 'same' }).view(() => ({ text: '2' }));
    expect(() =>
      tg.create({ screens: [one, two], storage: new MemorySessionStorage<ScreenChatState>() }),
    ).toThrow(/share the id/);
  });
});

describe('telegram screens: params schemas and the test chat', () => {
  test('a params schema on a screen or a group parses what the button carries', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const seen: unknown[] = [];
    const { bot, stale } = botOver(storage, (tg) => {
      const page = tg
        .screen('/page/:n', { params: z.object({ n: z.coerce.number().int().min(1) }) })
        .load((c) => {
          seen.push(c.params.n);
          return {};
        })
        .view(() => ({ text: 'page' }));
      const shelf = tg
        .group('/shelf/:row', { params: z.object({ row: z.coerce.number().int() }) })
        .load((c) => {
          seen.push(c.params.row);
          return {};
        })
        .screen('/')
        .view(() => ({ text: 'shelf' }));
      const home = tg.screen('/').view(() => ({
        text: 'home',
        keyboard: [
          [link('Page', page, { n: 2 })],
          [link('Shelf', shelf, { row: 7 })],
          [link('Bad', page, { n: 0 })],
        ],
      }));
      return { screens: [home, page, shelf], start: home };
    });
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.press('Page');
    await chat.send('/start');
    await chat.press('Shelf');
    await chat.send('/start');
    await chat.press('Bad');
    expect(seen).toEqual([2, 7]);
    expect(stale).toEqual(['invalid-params']);
  });

  test('the test chat takes its chat id, chat type and user id', async () => {
    const storage = new MemorySessionStorage<ScreenChatState>();
    const users: (number | undefined)[] = [];
    const { bot } = botOver(
      storage,
      (tg) => {
        const home = tg
          .screen('/')
          .action('who', (c) => {
            users.push(c.ctx.from?.id);
          })
          .view(({ act }) => ({ text: 'home', keyboard: [[act.who('Who')]] }));
        return { screens: [home], start: home };
      },
      { chats: 'all' },
    );
    const chat = createScreenTestChat(bot, { chatId: -77, chatType: 'supergroup', userId: 5 });
    await chat.send('/start');
    await chat.press('Who');
    expect(users).toEqual([5]);
    expect(await storage.read('screens:-77')).toBeDefined();
  });
});
