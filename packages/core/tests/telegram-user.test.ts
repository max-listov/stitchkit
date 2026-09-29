/**
 * `stitchkit/telegram` user: one shape for the Bot API's `from` and a Mini
 * App's signed `user`, so one `ensureAccount` takes both.
 */
import { describe, expect, test } from 'bun:test';
import { parseTelegramUser, type TelegramUser } from '../src/entrypoints/telegram';

describe('a Telegram user in one shape', () => {
  test("grammY's ctx.from arrives camelCase, fields Telegram did not send absent", () => {
    const from = {
      id: 42,
      is_bot: false,
      first_name: 'Ada',
      last_name: 'Lovelace',
      username: 'ada',
      language_code: 'en',
      can_join_groups: true,
    };
    const user: TelegramUser | undefined = parseTelegramUser(from);
    expect(user).toEqual({
      id: 42,
      isBot: false,
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
      languageCode: 'en',
    });
    expect(
      parseTelegramUser({ id: 7, first_name: 'B', photo_url: 'https://t.me/i/u.jpg' }),
    ).toEqual({ id: 7, firstName: 'B', photoUrl: 'https://t.me/i/u.jpg' });
  });

  test('what is not a user is undefined, not an exception', () => {
    expect(parseTelegramUser(undefined)).toBeUndefined();
    expect(parseTelegramUser({ id: '42', first_name: 'A' })).toBeUndefined();
    expect(parseTelegramUser({ id: 1.5, first_name: 'A' })).toBeUndefined();
  });
});
