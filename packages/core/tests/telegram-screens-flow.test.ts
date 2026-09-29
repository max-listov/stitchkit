import { describe, expect, test } from 'bun:test';
import { Bot, type Context, MemorySessionStorage } from 'grammy';
import { z } from 'zod';
import {
  back,
  createScreenTestChat,
  html,
  link,
  type ScreenChatState,
  type ScreenEvent,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

interface Project {
  id: string;
  name: string;
  owner: number;
  greeting: string;
  rule: 'first' | 'every';
}

const OWN = '11111111-2222-4333-8444-555555555555';
const FOREIGN = '99999999-2222-4333-8444-555555555555';

function fixture() {
  const projects = new Map<string, Project>([
    [
      OWN,
      { id: OWN, name: 'Alpha <beta>', owner: 1_000, greeting: 'Hello there', rule: 'first' },
    ],
    [FOREIGN, { id: FOREIGN, name: 'Foreign', owner: 7, greeting: 'Theirs', rule: 'first' }],
  ]);
  const tg = telegramScreens<Context>();

  const home = tg.screen('/').view(({ ctx }) => ({
    text: html`<b>Your projects</b>`,
    keyboard: [...projects.values()]
      .filter((project) => project.owner === ctx.from?.id)
      .map((project) => [link(project.name, details, { projectId: project.id })]),
  }));

  const owned = tg
    .group('/project/:projectId', { params: z.object({ projectId: z.uuid() }) })
    .load((c) => {
      const project = projects.get(c.params.projectId);
      return project && project.owner === c.ctx.from?.id
        ? project
        : c.go(home).toast('Project not found');
    });

  const details = owned
    .screen('/')
    .action('rename', z.object({ suffix: z.string() }), (c) => {
      c.data.name = `${c.data.name}${c.input.suffix}`;
      return c.toast('Renamed');
    })
    .view(({ data: project, params, act }) => ({
      text: html`📁 <b>${project.name}</b>`,
      keyboard: [
        [link('👋 Greeting', greeting, params)],
        [act.rename('Add !', { suffix: '!' })],
        [back('« Back')],
      ],
    }));

  const greeting = owned
    .screen('/greeting')
    .action('clear', (c) => {
      c.data.greeting = '';
    })
    .action('toggle', (c) => {
      c.data.rule = c.data.rule === 'first' ? 'every' : 'first';
    })
    .view(({ data: project, params, act }) =>
      project.greeting
        ? [
            { key: 'header', text: html`<b>Users receive ↓</b>` },
            {
              text: project.greeting,
              keyboard: [
                [link('✏️ Edit', greetingEdit, params), act.clear('🗑 Clear')],
                [act.toggle(project.rule === 'first' ? 'First only' : 'Every message')],
                [back('« Back')],
              ],
            },
          ]
        : { text: html`🗑 <b>No greeting.</b>`, keyboard: [[back('« Back')]] },
    );

  const greetingEdit = owned
    .screen('/greeting/edit')
    .on('text', async (c) => {
      if (c.text.length < 3)
        return c.notice(html`<b>❌ Too short</b>`, { expiresInMs: 5_000 });
      await c.pending('⏳');
      c.data.greeting = c.text;
      return c.notice(html`<blockquote>✅ Saved</blockquote>`).back();
    })
    .view(() => ({ text: html`📝 Send the new greeting ↓`, keyboard: [[back('« Back')]] }));

  const storage = new MemorySessionStorage<ScreenChatState>();
  const events: ScreenEvent[] = [];
  const makeBot = () => {
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({
      screens: [home, details, greeting, greetingEdit],
      storage,
      onEvent: (event) => events.push(event),
    });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    bot.command('help', (ctx) => ctx.reply('help text'));
    bot.catch((error) => {
      throw error.error;
    });
    return { bot, screens };
  };
  return {
    projects,
    storage,
    events,
    makeBot,
    screens: { home, details, greeting, greetingEdit },
  };
}

describe('telegram screens: a menu end to end', () => {
  test('open, navigate by editing in place, back, and a two-message screen', async () => {
    const { makeBot } = fixture();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    expect(chat.messages.at(-1)?.text).toBe('<b>Your projects</b>');
    expect(chat.messages.at(-1)?.buttons).toEqual([['Alpha <beta>']]);

    chat.clearCalls();
    await chat.press('Alpha <beta>');
    const shown = chat.messages.filter((message) => message.from === 'bot');
    expect(shown).toHaveLength(1);
    expect(shown[0]?.text).toBe('📁 <b>Alpha &lt;beta&gt;</b>');
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
    ]);

    chat.clearCalls();
    await chat.press('👋 Greeting');
    const two = chat.messages.filter((message) => message.from === 'bot');
    expect(two.map((message) => message.text)).toEqual([
      '<b>Users receive ↓</b>',
      'Hello there',
    ]);
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'sendMessage',
      'sendMessage',
      'deleteMessage',
    ]);

    chat.clearCalls();
    await chat.press('« Back');
    const one = chat.messages.filter((message) => message.from === 'bot');
    expect(one.map((message) => message.text)).toEqual(['📁 <b>Alpha &lt;beta&gt;</b>']);
    // The body message — key 'main' on both screens — is edited, the header deleted.
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageText',
      'deleteMessage',
    ]);
  });
});

describe('telegram screens: actions, input and notices', () => {
  test('a change of keyboard alone edits the keyboard; a toast answers the press', async () => {
    const { makeBot } = fixture();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Alpha <beta>');
    await chat.press('👋 Greeting');
    chat.clearCalls();
    await chat.press('First only');
    expect(chat.calls.map((call) => call.method)).toEqual([
      'answerCallbackQuery',
      'editMessageReplyMarkup',
    ]);
    expect(chat.messages.at(-1)?.buttons[1]).toEqual(['Every message']);

    await chat.press('« Back');
    chat.clearCalls();
    await chat.press('Add !');
    expect(chat.answers).toEqual(['Renamed']);
    expect(chat.messages.at(-1)?.text).toBe('📁 <b>Alpha &lt;beta&gt;!</b>');
  });

  test('input: the message is removed first, pending shown and removed, a receipt stays above the screen', async () => {
    const { makeBot, projects } = fixture();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Alpha <beta>');
    await chat.press('👋 Greeting');
    await chat.press('✏️ Edit');
    chat.clearCalls();
    await chat.send('Welcome aboard');
    expect(projects.get(OWN)?.greeting).toBe('Welcome aboard');
    const methods = chat.calls.map((call) => call.method);
    expect(methods[0]).toBe('deleteMessage');
    expect(methods).toContain('sendMessage');
    const visible = chat.messages.map((message) => [message.from, message.text]);
    expect(visible.filter(([from]) => from === 'user').map(([, text]) => text)).toEqual([
      '/start',
    ]);
    expect(visible.filter(([from]) => from === 'bot').map(([, text]) => text)).toEqual([
      '<blockquote>✅ Saved</blockquote>',
      '<b>Users receive ↓</b>',
      'Welcome aboard',
    ]);
    expect(chat.messages.some((message) => message.text === '⏳')).toBe(false);
  });

  test('an expiring notice sits below the screen and is swept once due', async () => {
    let now = 1_000;
    const { projects, storage } = fixture();
    const tg = telegramScreens<Context>();
    const home = tg
      .screen('/')
      .on('text', (c) => c.notice(html`<b>❌ ${c.text}</b>`, { expiresInMs: 5_000 }))
      .view(() => ({ text: 'Send something' }));
    void projects;
    const bot = new Bot<Context>('0:test');
    const screens = tg.create({ screens: [home], storage, clock: () => now });
    bot.use(screens);
    bot.command('start', (ctx) => screens.open(ctx, home));
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    await chat.send('nope');
    expect(chat.messages.map((message) => message.text)).toEqual([
      '/start',
      'Send something',
      '<b>❌ nope</b>',
    ]);
    // Before its time a remark stays, whatever else the chat does.
    now += 1_000;
    await chat.send('soon');
    expect(chat.messages.map((message) => message.text)).toEqual([
      '/start',
      'Send something',
      '<b>❌ nope</b>',
      '<b>❌ soon</b>',
    ]);
    now += 6_000;
    await chat.send('again');
    expect(chat.messages.map((message) => message.text)).toEqual([
      '/start',
      'Send something',
      '<b>❌ again</b>',
    ]);
    screens.close();
  });

  test('a command is never input: it reaches its own handler', async () => {
    const { makeBot, projects } = fixture();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Alpha <beta>');
    await chat.press('👋 Greeting');
    await chat.press('✏️ Edit');
    await chat.send('/help');
    expect(chat.messages.at(-1)?.text).toBe('help text');
    expect(projects.get(OWN)?.greeting).toBe('Hello there');
  });
});

describe('telegram screens: trust', () => {
  test('callback_data that no button on the message carries never reaches a handler', async () => {
    const { makeBot, projects } = fixture();
    const chat = createScreenTestChat(makeBot().bot);
    await chat.send('/start');
    await chat.press('Alpha <beta>');
    const menu = chat.messages.at(-1);
    const rename = menu?.markup?.inline_keyboard[1]?.[0];
    const data = rename && 'callback_data' in rename ? rename.callback_data : '';
    expect(data).not.toBe('');
    // Same action, input changed by hand: not on the keyboard.
    await chat.pressData(menu?.id ?? 0, data.replace(/suffix=.*$/, 'suffix=HACK'));
    expect(projects.get(OWN)?.name).toBe('Alpha <beta>');
    expect(chat.answers.at(-1)).toBe('');
    await chat.pressData(menu?.id ?? 0, data);
    expect(projects.get(OWN)?.name).toBe('Alpha <beta>!');
  });

  test("a link to someone else's project is refused by the group's load", async () => {
    const { makeBot, screens: declared } = fixture();
    const { bot, screens } = makeBot();
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const foreign = screens.button(link('Open', declared.details, { projectId: FOREIGN }));
    await bot.api.sendMessage(1_000, 'notification', {
      reply_markup: { inline_keyboard: [[foreign]] },
    });
    await chat.press('Open');
    expect(chat.answers.at(-1)).toBe('Project not found');
    expect(chat.messages.some((message) => message.text.includes('Foreign'))).toBe(false);
    // The notification is left as it is; home opened below.
    expect(chat.messages.some((message) => message.text === 'notification')).toBe(true);
    expect(chat.messages.at(-1)?.text).toBe('<b>Your projects</b>');
  });

  test('state survives a restart: input after a new runtime over the same storage reaches the screen', async () => {
    const { makeBot, projects } = fixture();
    const first = makeBot();
    const chat = createScreenTestChat(first.bot);
    await chat.send('/start');
    await chat.press('Alpha <beta>');
    await chat.press('👋 Greeting');
    await chat.press('✏️ Edit');
    // A new process: new bot, new runtime, same storage, the same chat.
    chat.restart(makeBot().bot);
    await chat.send('After restart');
    expect(projects.get(OWN)?.greeting).toBe('After restart');
    expect(chat.messages.at(-1)?.text).toBe('After restart');
  });

  test('group chats are left to other handlers by default', async () => {
    const { makeBot } = fixture();
    const chat = createScreenTestChat(makeBot().bot, {
      chatType: 'supergroup',
      chatId: -100,
      userId: 1_000,
    });
    // The application may still open a screen there on purpose…
    await chat.send('/start');
    expect(chat.messages.at(-1)?.text).toBe('<b>Your projects</b>');
    chat.clearCalls();
    // …but presses and messages from the group are not the screens' to take.
    await chat.press('Alpha <beta>');
    await chat.send('some text');
    expect(chat.calls.map((call) => call.method)).toEqual([]);
  });
});
