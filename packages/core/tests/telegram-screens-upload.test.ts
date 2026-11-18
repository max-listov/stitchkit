import { describe, expect, test } from 'bun:test';
import { Bot, InputFile, MemorySessionStorage } from 'grammy';
import { z } from 'zod';
import {
  createScreenTestChat,
  type ScreenChatState,
  telegramScreens,
} from '../src/entrypoints/telegram/screens';

const bytes = (page: number) => Uint8Array.of(255, 216, page, 0, 128, 255, 217);
const caption = 'A "photo" <&>\n第二枚';
const refs = ['https://example.org/photo.jpg?a=1&b=2', 'saved-file-id'];

function album(bot: Bot, upload: boolean) {
  const tg = telegramScreens();
  const storage = new MemorySessionStorage<ScreenChatState>();
  const builds: number[] = [];
  let page = 0;
  let renamed = false;
  const gallery = tg
    .screen('/')
    .action('next', () => {
      page++;
    })
    .action('rename', () => {
      renamed = true;
    })
    .action('refresh', () => undefined)
    .view(({ act }) => {
      const index = page;
      const keyboard = [
        [act.next('Next'), act.rename('Rename'), act.refresh(renamed ? 'Reload' : 'Refresh')],
      ];
      if (upload) {
        return {
          keyboard,
          richUpload: {
            contentKey: `catalog-v1/${index}`,
            build: async () => {
              builds.push(index);
              const media = new InputFile(bytes(index), 'preview.jpg');
              return {
                blocks: [
                  {
                    type: 'photo',
                    photo: { type: 'photo', media },
                    caption: { text: caption },
                  },
                ],
              };
            },
          },
        };
      }
      return {
        keyboard,
        rich: {
          blocks: [
            {
              type: 'photo' as const,
              photo: { type: 'photo' as const, media: refs[index] ?? 'last-file-id' },
              caption: { text: caption },
            },
          ],
        },
      };
    });
  const screens = tg.create({ screens: [gallery], storage });
  bot.use(screens);
  bot.command('start', (ctx) => screens.open(ctx, gallery));
  return { builds, storage };
}

const Keyboard = z.object({
  inline_keyboard: z.array(z.array(z.object({ text: z.string(), callback_data: z.string() }))),
});

/** Capture the request after grammY has written its real JSON or multipart body. */
async function wireChat(upload: boolean) {
  const id = 74;
  const user = { id: 12, first_name: 'User', is_bot: false };
  const peer = { id: user.id, type: 'private', first_name: 'User' } as const;
  const photo = z.object({
    blocks: z.tuple([
      z.object({
        type: z.literal('photo'),
        photo: z.object({ media: z.string() }),
        caption: z.object({ text: z.string() }),
      }),
    ]),
  });
  const requests: {
    method: string;
    contentType: string;
    messageId: unknown;
    media: string;
    caption: string;
    file?: { name: string; bytes: Uint8Array };
  }[] = [];
  const methods: string[] = [];
  let keyboard: z.infer<typeof Keyboard> = { inline_keyboard: [] };
  const respond = async (url: unknown, init?: RequestInit) => {
    const method = String(url).split('/').at(-1) ?? '';
    methods.push(method);
    if (method === 'getMe')
      return Response.json({
        ok: true,
        result: { id: 9, is_bot: true, first_name: 'Test', username: 'album_bot' },
      });
    const body = new Response(init?.body, { headers: init?.headers });
    const contentType = body.headers.get('content-type') ?? '';
    if (method === 'sendRichMessage' || method === 'editMessageText') {
      const form = contentType.startsWith('multipart/form-data')
        ? await body.formData()
        : undefined;
      const payload = form ? Object.fromEntries(form) : await body.json();
      expect(Number(payload.chat_id)).toBe(peer.id);
      const block = photo.parse(form ? JSON.parse(payload.rich_message) : payload.rich_message)
        .blocks[0];
      keyboard = Keyboard.parse(
        form ? JSON.parse(payload.reply_markup) : payload.reply_markup,
      );
      const media = block.photo.media;
      const file = form?.get(media.slice('attach://'.length));
      requests.push({
        method,
        contentType,
        messageId: payload.message_id,
        media,
        caption: block.caption.text,
        file:
          file instanceof File
            ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) }
            : undefined,
      });
    }
    return Response.json({ ok: true, result: { message_id: id } });
  };
  const bot = new Bot('0:test', {
    client: { fetch: Object.assign(respond, { preconnect: () => undefined }) },
  });
  const app = album(bot, upload);
  await bot.init();
  let update = 1;
  const message = { message_id: 1, date: 1, chat: peer, from: user };
  await bot.handleUpdate({
    update_id: update,
    message: {
      ...message,
      text: '/start',
      entities: [{ type: 'bot_command', offset: 0, length: 6 }],
    },
  });
  async function press(label: string) {
    const button = keyboard.inline_keyboard.flat().find((item) => item.text === label);
    if (!button) throw new Error(`No button ${label}`);
    await bot.handleUpdate({
      update_id: ++update,
      callback_query: {
        id: String(update),
        from: user,
        chat_instance: 'test',
        data: button.callback_data,
        message: { ...message, message_id: id, reply_markup: keyboard },
      },
    });
  }
  return { ...app, id, press, requests, methods };
}

describe('telegram screens: rich uploads', () => {
  test('invalid upload declarations from JavaScript fail before sending', async () => {
    const build = () => ({});
    for (const [view, refusal] of [
      [{ richUpload: { build } }, 'contentKey and a build function'],
      [{ richUpload: { contentKey: '', build } }, 'contentKey and a build function'],
      [
        { richUpload: { contentKey: 'v1', build: 'invalid' } },
        'contentKey and a build function',
      ],
      [{ richUpload: null }, 'contentKey and a build function'],
      [{ richUpload: { contentKey: 'v1', build }, rich: { markdown: 'inline' } }, 'not both'],
    ] as const) {
      const tg = telegramScreens();
      // @ts-expect-error — exercising the declaration as supplied by a JavaScript caller
      const screen = tg.screen('/').view(() => view);
      const bot = new Bot('0:test');
      bot.catch((error) => {
        throw error.error;
      });
      const screens = tg.create({
        screens: [screen],
        storage: new MemorySessionStorage<ScreenChatState>(),
      });
      bot.use(screens);
      bot.command('start', (ctx) => screens.open(ctx, screen));
      const chat = createScreenTestChat(bot);
      await expect(chat.send('/start')).rejects.toThrow(refusal);
      expect(chat.calls).toHaveLength(0);
    }
  });
  test('grammY sends and edits the photo as multipart on the same message', async () => {
    const { press, requests, builds, methods, id, storage } = await wireChat(true);
    await press('Refresh');
    await press('Next');
    await press('Rename');
    expect(methods).toEqual([
      'getMe',
      'sendRichMessage',
      'answerCallbackQuery',
      'answerCallbackQuery',
      'editMessageText',
      'answerCallbackQuery',
      'editMessageReplyMarkup',
    ]);
    expect(builds).toEqual([0, 1]);
    expect(requests.map((call) => call.messageId)).toEqual([undefined, String(id)]);
    for (const [index, request] of requests.entries()) {
      expect(request.contentType).toStartWith('multipart/form-data;');
      expect(request.media).toMatch(/^attach:\/\/.+/);
      expect(request.caption).toBe(caption);
      expect(request.file).toEqual({ name: 'preview.jpg', bytes: bytes(index) });
    }
    const record = await storage.read('screens:12');
    expect(record?.view?.messages).toHaveLength(1);
    expect(record?.view?.messages[0]).toMatchObject({ id, kind: 'rich' });
    expect(JSON.stringify(record)).not.toContain('catalog-v1');
    expect(JSON.stringify(record)).not.toContain('preview.jpg');
  });

  test('grammY sends URL and file_id rich messages as JSON', async () => {
    const { press, requests, builds, id } = await wireChat(false);
    await press('Next');
    await press('Refresh');
    expect(builds).toEqual([]);
    expect(requests.map((request) => request.media)).toEqual(refs);
    expect(requests.map((request) => request.messageId)).toEqual([undefined, id]);
    for (const request of requests) {
      expect(request.contentType).toBe('application/json');
      expect(request.caption).toBe(caption);
    }
  });

  test('the test chat pages through uploads and a refused edit rebuilds the file for the resend', async () => {
    const bot = new Bot('0:test');
    const { builds } = album(bot, true);
    const chat = createScreenTestChat(bot);
    await chat.send('/start');
    const first = chat.messages.at(-1);
    await chat.press('Next');
    const second = chat.messages.at(-1);
    expect(second?.id).toBe(first?.id);
    expect(second?.rich).not.toEqual(first?.rich);
    await chat.press('Refresh');
    expect(builds).toEqual([0, 1]);
    chat.failNext('editMessageText', "Bad Request: message can't be edited");
    await chat.press('Next');
    expect(builds).toEqual([0, 1, 2, 2]);
    expect(chat.messages.at(-1)?.id).not.toBe(first?.id);
    expect(chat.messages.filter((m) => m.from === 'bot')).toHaveLength(1);
  });
});
