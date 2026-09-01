/**
 * Guard: a Mini App request is authenticated, and a refusal says which kind.
 *
 * Three consuming applications wrote this check by hand and two of them had
 * already drifted apart. The signature is built here with `node:crypto`, a
 * different implementation from the Web Crypto the module uses — if the two
 * ever stop agreeing, that is the failure this file exists to catch, and it is
 * the failure a self-consistent test written against the module's own helpers
 * could never see.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyTelegramInitData } from '../src/telegram';

const BOT_TOKEN = '123456:AAH-test-token-for-signing-only';

/** Sign a set of fields the way Telegram does, from the outside. */
function signInitData(fields: Record<string, string>): string {
  const dataCheckString = Object.keys(fields)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const AUTH_DATE = 1_800_000_000;
const NOW_MS = AUTH_DATE * 1000;
const USER = {
  id: 42,
  is_bot: false,
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  language_code: 'en',
  is_premium: true,
};

function validInitData(overrides: Record<string, string> = {}): string {
  return signInitData({
    user: JSON.stringify(USER),
    auth_date: String(AUTH_DATE),
    query_id: 'AAH-query',
    chat_type: 'private',
    ...overrides,
  });
}

describe('verifying Telegram initData', () => {
  test('an authentic string yields the user, in this surface s own naming', async () => {
    const result = await verifyTelegramInitData({
      initData: validInitData(),
      botToken: BOT_TOKEN,
      now: () => NOW_MS,
    });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    // Telegram writes `first_name`; every other name this package publishes is
    // camelCase, and a surface that switches convention by provenance makes the
    // caller remember which is which.
    expect(result.data.user).toEqual({
      id: 42,
      isBot: false,
      firstName: 'Ada',
      lastName: 'Lovelace',
      username: 'ada',
      languageCode: 'en',
      isPremium: true,
    });
    expect(result.data.authDate).toEqual(new Date(AUTH_DATE * 1000));
    expect(result.data.queryId).toBe('AAH-query');
    expect(result.data.chatType).toBe('private');
    expect(result.data.ageSeconds).toBe(0);
    // Every signed pair stays readable, so a field Telegram adds after this
    // release does not need a release to reach.
    expect(result.data.raw.auth_date).toBe(String(AUTH_DATE));
    expect(result.data.raw.hash).toBeUndefined();
  });

  test('one flipped byte anywhere in the payload is a signature mismatch', async () => {
    const authentic = validInitData();
    const tampered = authentic.replace('Ada', 'Eve');
    expect(tampered).not.toBe(authentic);
    const result = await verifyTelegramInitData({
      initData: tampered,
      botToken: BOT_TOKEN,
      now: () => NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'signature-mismatch' });
  });

  test('another bot s token does not verify this bot s string', async () => {
    const result = await verifyTelegramInitData({
      initData: validInitData(),
      botToken: '999999:AAH-a-different-bot',
      now: () => NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'signature-mismatch' });
  });

  test('a string with no hash is refused before any of it is believed', async () => {
    const result = await verifyTelegramInitData({
      initData: new URLSearchParams({ user: JSON.stringify(USER) }).toString(),
      botToken: BOT_TOKEN,
    });
    expect(result).toEqual({ valid: false, reason: 'missing-hash' });
  });

  test('maxAgeSeconds bounds a signature that would otherwise last forever', async () => {
    const initData = validInitData();
    const fresh = await verifyTelegramInitData({
      initData,
      botToken: BOT_TOKEN,
      maxAgeSeconds: 600,
      now: () => NOW_MS + 599_000,
    });
    expect(fresh.valid).toBe(true);

    const stale = await verifyTelegramInitData({
      initData,
      botToken: BOT_TOKEN,
      maxAgeSeconds: 600,
      now: () => NOW_MS + 601_000,
    });
    expect(stale).toEqual({ valid: false, reason: 'expired', ageSeconds: 601 });

    // Omitted is unbounded — the option is the only thing that bounds it, so a
    // caller that forgets it must not be told the string was fresh.
    const unbounded = await verifyTelegramInitData({
      initData,
      botToken: BOT_TOKEN,
      now: () => NOW_MS + 400 * 86_400_000,
    });
    expect(unbounded.valid).toBe(true);
  });

  test('expiry is decided after the signature, never before it', async () => {
    // A forged string carries whatever `auth_date` its author chose. Reporting
    // it as merely expired would hand an attacker a softer answer than the one
    // they earned — and, worse, tell them the timestamp is what to fix.
    const forged = new URLSearchParams({
      auth_date: '1',
      hash: '0'.repeat(64),
    }).toString();
    const result = await verifyTelegramInitData({
      initData: forged,
      botToken: BOT_TOKEN,
      maxAgeSeconds: 60,
      now: () => NOW_MS,
    });
    expect(result).toEqual({ valid: false, reason: 'signature-mismatch' });
  });

  test('an authentic string this version cannot read is malformed, not forged', async () => {
    const result = await verifyTelegramInitData({
      initData: signInitData({ user: '{not json', auth_date: String(AUTH_DATE) }),
      botToken: BOT_TOKEN,
      now: () => NOW_MS,
    });
    // Telegram signed it; we still cannot parse it. That is a different fact
    // from a forgery and gets a different name.
    expect(result).toEqual({ valid: false, reason: 'malformed' });

    const noDate = await verifyTelegramInitData({
      initData: signInitData({ user: JSON.stringify(USER) }),
      botToken: BOT_TOKEN,
      now: () => NOW_MS,
    });
    expect(noDate).toEqual({ valid: false, reason: 'malformed' });
  });

  test('a missing bot token is this process misconfigured, and throws', async () => {
    // Every refusal above is something a client can send, so it is a value.
    // This one is not reachable by any client and must not look like one.
    await expect(
      verifyTelegramInitData({ initData: validInitData(), botToken: '' }),
    ).rejects.toThrow(TypeError);
    await expect(
      verifyTelegramInitData({
        initData: validInitData(),
        botToken: BOT_TOKEN,
        maxAgeSeconds: -1,
      }),
    ).rejects.toThrow(TypeError);
  });

  test('a hash is compared without regard to case, and never partially', async () => {
    const initData = validInitData();
    const upper = initData.replace(
      /hash=([0-9a-f]+)/,
      (_, hash: string) => `hash=${hash.toUpperCase()}`,
    );
    expect(upper).not.toBe(initData);
    const result = await verifyTelegramInitData({
      initData: upper,
      botToken: BOT_TOKEN,
      now: () => NOW_MS,
    });
    expect(result.valid).toBe(true);

    // A digest of the wrong length is refused on length alone; the comparison
    // still never reports how much of it was right.
    const truncated = initData.replace(
      /hash=([0-9a-f]+)/,
      (_, hash: string) => `hash=${hash.slice(0, 32)}`,
    );
    expect(
      (await verifyTelegramInitData({ initData: truncated, botToken: BOT_TOKEN })).valid,
    ).toBe(false);
  });
});
