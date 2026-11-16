/** Widget limits, the byte-counted strings and the shapes Telegram sends for widgets. */
import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import { ZodError } from 'zod';
import {
  parseTelegramWidgetQuery,
  TELEGRAM_WIDGET_LIMITS,
  TelegramWidgetDataSchema,
  TelegramWidgetHtmlSchema,
  TelegramWidgetMessageSchema,
  TelegramWidgetQuerySchema,
} from '../src/entrypoints/telegram';

const QUERY = {
  id: 'query-1',
  from: { id: 42, is_bot: false, first_name: 'Fixture' },
  chat: { id: 42, type: 'private' },
  message_id: 7,
  chat_instance: '-1234',
  type: { type: 'data' },
  data: 'r',
};

describe('the stated limits', () => {
  test('are Telegram’s numbers and cannot be changed at run time', () => {
    expect(TELEGRAM_WIDGET_LIMITS).toEqual({
      htmlBytes: 32_768,
      compressedHtmlBytes: 4_096,
      dataBytes: 1_024,
      queryDataBytes: 64,
      answerWindowMs: 15_000,
    });
    expect(Object.isFrozen(TELEGRAM_WIDGET_LIMITS)).toBe(true);
  });
});

describe('byte-counted widget strings', () => {
  test('data counts UTF-8 bytes: 512 Cyrillic letters fit, 513 do not', () => {
    expect(TelegramWidgetDataSchema.safeParse('я'.repeat(512)).success).toBe(true);
    expect(TelegramWidgetDataSchema.safeParse('я'.repeat(513)).success).toBe(false);
    expect(TelegramWidgetDataSchema.safeParse('😀'.repeat(256)).success).toBe(true);
    expect(TelegramWidgetDataSchema.safeParse(`${'😀'.repeat(256)}x`).success).toBe(false);
  });

  test('an empty data string is a value, and NUL or a lone surrogate is refused', () => {
    expect(TelegramWidgetDataSchema.parse('')).toBe('');
    const nul = TelegramWidgetDataSchema.safeParse('a\0b');
    expect(nul.error?.issues[0]?.message).toBe('Text contains NUL');
    const surrogate = TelegramWidgetDataSchema.safeParse('\uDE00');
    expect(surrogate.error?.issues[0]?.message).toBe('Text contains an unpaired surrogate');
    expect(TelegramWidgetDataSchema.safeParse('😀').success).toBe(true);
  });

  test('the compressed limit holds at exactly 4096 bytes and refuses 4097', () => {
    // Printable noise grows the compressed size by about a byte a character, so
    // some prefix of it lands exactly on each side of the limit in this runtime.
    let seed = 11;
    const noise = Array.from({ length: 8_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return String.fromCharCode(33 + (seed % 94));
    }).join('');
    const sizeOf = (length: number) =>
      deflateSync(noise.slice(0, length), { level: 9 }).byteLength;
    // The size grows with the prefix: find the first prefix that reaches the
    // limit, then look a few characters around it for each exact size.
    let low = 1;
    let high = noise.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (sizeOf(middle) < 4_096) low = middle + 1;
      else high = middle;
    }
    const near = Array.from({ length: 64 }, (_, index) => low - 16 + index);
    const at = near.find((length) => sizeOf(length) === 4_096);
    const over = near.find((length) => sizeOf(length) === 4_097);
    if (at === undefined || over === undefined)
      throw new Error('no prefix lands on the limit');
    expect(TelegramWidgetHtmlSchema.safeParse(noise.slice(0, at)).success).toBe(true);
    expect(
      TelegramWidgetHtmlSchema.safeParse(noise.slice(0, over)).error?.issues[0]?.message,
    ).toBe('Text compresses to 4097 bytes, at most 4096 allowed');
  });

  test('a leading BOM is data like any other character', () => {
    expect(TelegramWidgetDataSchema.parse('\uFEFFx')).toBe('\uFEFFx');
  });

  test('HTML is 1–32768 bytes and at most 4096 compressed', () => {
    expect(TelegramWidgetHtmlSchema.safeParse('').success).toBe(false);
    expect(TelegramWidgetHtmlSchema.safeParse(' '.repeat(32_768)).success).toBe(true);
    const over = TelegramWidgetHtmlSchema.safeParse(' '.repeat(32_769));
    expect(over.error?.issues[0]?.message).toBe(
      'Text is 32769 UTF-8 bytes, at most 32768 allowed',
    );
    let seed = 7;
    const noise = Array.from({ length: 6_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return String.fromCharCode(33 + (seed % 94));
    }).join('');
    const compressed = TelegramWidgetHtmlSchema.safeParse(noise);
    expect(compressed.error?.issues[0]?.message).toMatch(
      /^Text compresses to \d+ bytes, at most 4096 allowed$/,
    );
  });
});

describe('a sent widget message', () => {
  test('keeps fields Telegram adds and refuses a message without a widget', () => {
    const message = TelegramWidgetMessageSchema.parse({
      message_id: 7,
      date: 1,
      chat: { id: 42, type: 'private', username: 'fixture' },
      widget: { html: '<p/>', width: 300, chat_data: '', a_new_widget_field: 1 },
      a_new_message_field: 'kept',
    });
    expect(message.widget.chat_data).toBe('');
    expect(Reflect.get(message, 'a_new_message_field')).toBe('kept');
    expect(Reflect.get(message.widget, 'a_new_widget_field')).toBe(1);
    expect(
      TelegramWidgetMessageSchema.safeParse({
        message_id: 7,
        chat: { id: 42, type: 'private' },
      }).success,
    ).toBe(false);
  });
});

describe('a widget query', () => {
  test('parses the three documented kinds and keeps new fields', () => {
    const wallet = { address: 'EQ…', amount: '100' };
    expect(parseTelegramWidgetQuery({ ...QUERY, a_new_field: 1 })).toMatchObject({
      query: { id: 'query-1', type: { type: 'data' }, data: 'r', a_new_field: 1 },
    });
    expect(
      TelegramWidgetQuerySchema.safeParse({
        ...QUERY,
        type: { type: 'sign_data', wallet, sign_data: '{}' },
      }).success,
    ).toBe(true);
    expect(
      TelegramWidgetQuerySchema.safeParse({
        ...QUERY,
        type: { type: 'sent_transaction', wallet, msg_hash: 'h' },
      }).success,
    ).toBe(true);
    expect(
      parseTelegramWidgetQuery({
        id: 'inline-query',
        from: { id: 1 },
        inline_message_id: 'inline-1',
        chat_instance: '1',
        chat_type: 'sender',
        type: { type: 'data' },
        data: 'x',
      }),
    ).toMatchObject({ query: { inline_message_id: 'inline-1', chat_type: 'sender' } });
  });

  test('a query that does not parse still returns its id, so it can be refused', () => {
    for (const broken of [
      { ...QUERY, type: { type: 'a_kind_added_later' } },
      { ...QUERY, data: '' },
      { ...QUERY, data: 'x'.repeat(65) },
      { ...QUERY, chat_instance: undefined },
    ]) {
      const parsed = parseTelegramWidgetQuery(broken);
      expect(parsed).toMatchObject({ id: 'query-1' });
      expect(parsed !== undefined && 'error' in parsed && parsed.error).toBeInstanceOf(
        ZodError,
      );
    }
    expect(parseTelegramWidgetQuery({ ...QUERY, data: 'x'.repeat(64) })).toMatchObject({
      query: { id: 'query-1' },
    });
  });

  test('without an id there is nothing to answer', () => {
    expect(parseTelegramWidgetQuery(undefined)).toBeUndefined();
    expect(parseTelegramWidgetQuery('query')).toBeUndefined();
    expect(parseTelegramWidgetQuery({ ...QUERY, id: '' })).toBeUndefined();
    expect(parseTelegramWidgetQuery({ ...QUERY, id: 5 })).toBeUndefined();
  });
});
