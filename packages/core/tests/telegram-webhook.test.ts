/**
 * `stitchkit/telegram` webhook ownership: set only where it is already this
 * process's, or by naming the host it is taken from; a copied address with
 * another secret is not "this process".
 */
import { describe, expect, test } from 'bun:test';
import {
  checkTelegramWebhook,
  claimTelegramWebhook,
  receiveTelegramWebhook,
  TELEGRAM_WEBHOOK_NONE,
  type TelegramUpdateAcceptance,
  TelegramWebhookClaimError,
  telegramWebhookUrl,
} from '../src/entrypoints/telegram';

const BASE = 'https://bot.example.test/telegram/webhook';
const SECRET = 's'.repeat(32);
const FOREIGN = 'https://legacy.example.test/bot/secret-path';

/** A fetch stand-in; Bun's `typeof fetch` also carries `preconnect`. */
function asFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: (): void => undefined });
}

/** A Bot API with one webhook: `getWebhookInfo` reads it, `setWebhook` replaces it. */
function botApi(initialUrl: string, options: { ignoreSet?: boolean } = {}) {
  const calls: string[] = [];
  const set: Record<string, unknown> = {};
  const state = { url: initialUrl, calls, set };
  const fetch = asFetch(async (input, init) => {
    const method = new URL(String(input)).pathname.split('/').at(-1) ?? '';
    state.calls.push(method);
    if (method === 'getWebhookInfo') {
      return Response.json({
        ok: true,
        result: {
          url: state.url,
          pending_update_count: 3,
          last_error_date: 1_700_000_000,
          last_error_message: 'Wrong response from the webhook: 403 Forbidden',
        },
      });
    }
    Object.assign(state.set, JSON.parse(String(init?.body)));
    if (!options.ignoreSet) state.url = String(state.set.url);
    return Response.json({ ok: true, result: true });
  });
  return { state, config: { token: '1:x', url: BASE, secret: SECRET, fetch } };
}

async function refusal(promise: Promise<unknown>): Promise<TelegramWebhookClaimError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  if (!(error instanceof TelegramWebhookClaimError))
    throw new Error('expected a claim refusal');
  return error;
}

describe('telegram webhook: who may set it', () => {
  test('the address carries a tag of the secret: one per secret, path untouched, secret not in it', async () => {
    const own = await telegramWebhookUrl(BASE, SECRET);
    expect(await telegramWebhookUrl(BASE, SECRET)).toBe(own);
    expect(await telegramWebhookUrl(BASE, 'r'.repeat(32))).not.toBe(own);
    expect(new URL(own).pathname).toBe('/telegram/webhook');
    expect(own).not.toContain(SECRET.slice(0, 8));
    await expect(telegramWebhookUrl(BASE, 'has space')).rejects.toThrow(TypeError);
  });

  test("a foreign webhook is refused without setWebhook, and the refusal names only the owner's host", async () => {
    const { state, config } = botApi(FOREIGN);
    const error = await refusal(claimTelegramWebhook(config));
    expect(error.reason).toBe('owned-elsewhere');
    expect(error.ownerHost).toBe('legacy.example.test');
    expect(error.message).toContain("takeoverFrom: 'legacy.example.test'");
    expect(error.message).not.toContain('secret-path');
    expect(state.calls).toEqual(['getWebhookInfo']);
    // Naming another host is not naming this one.
    await refusal(claimTelegramWebhook({ ...config, takeoverFrom: 'other.example.test' }));
    expect(state.url).toBe(FOREIGN);
  });

  test('no webhook at all is a polling bot, taken only by naming none', async () => {
    const polling = botApi('');
    expect((await refusal(claimTelegramWebhook(polling.config))).ownerHost).toBe('none');
    const claim = await claimTelegramWebhook({
      ...polling.config,
      takeoverFrom: TELEGRAM_WEBHOOK_NONE,
    });
    expect(claim.takenFrom).toBe('none');
    expect(polling.state.url).toBe(await telegramWebhookUrl(BASE, SECRET));
  });

  test('the same address with another secret is not this process: refused, secret untouched', async () => {
    const production = await telegramWebhookUrl(BASE, 'p'.repeat(64));
    const { state, config } = botApi(production);
    const error = await refusal(claimTelegramWebhook(config));
    expect(error.reason).toBe('other-secret');
    expect(state.calls).toEqual(['getWebhookInfo']);
  });

  test('its own webhook is refreshed, a named takeover moves it, and pending updates are kept', async () => {
    const own = botApi(await telegramWebhookUrl(BASE, SECRET));
    const refreshed = await claimTelegramWebhook({
      ...own.config,
      allowedUpdates: ['message'],
      maxConnections: 5,
    });
    expect(refreshed.takenFrom).toBeUndefined();
    expect(refreshed.pendingUpdates).toBe(3);
    expect(own.state.set).toMatchObject({
      secret_token: SECRET,
      drop_pending_updates: false,
      allowed_updates: ['message'],
      max_connections: 5,
    });
    const moved = botApi(FOREIGN);
    const claim = await claimTelegramWebhook({
      ...moved.config,
      takeoverFrom: 'legacy.example.test',
    });
    expect(claim).toMatchObject({ takenFrom: 'legacy.example.test', url: refreshed.url });
    expect(moved.state.calls).toEqual(['getWebhookInfo', 'setWebhook', 'getWebhookInfo']);
  });

  test('a setWebhook Telegram did not keep is not a claim', async () => {
    const { config } = botApi('', { ignoreSet: true });
    const error = await refusal(claimTelegramWebhook({ ...config, takeoverFrom: 'none' }));
    expect(error.reason).toBe('not-confirmed');
  });

  test('a local Bot API root and an abort signal reach every call', async () => {
    const urls: string[] = [];
    const { config } = botApi('');
    const fetch = asFetch((input, init) => {
      urls.push(String(input));
      return config.fetch(input, init);
    });
    await checkTelegramWebhook({ ...config, fetch, apiRoot: 'http://127.0.0.1:8081/' });
    expect(urls).toEqual(['http://127.0.0.1:8081/bot1:x/getWebhookInfo']);
    const aborted = AbortSignal.abort(new Error('stopping'));
    const stop = asFetch((input, init) =>
      init?.signal?.aborted ? Promise.reject(init.signal.reason) : config.fetch(input, init),
    );
    await expect(
      claimTelegramWebhook({ ...config, fetch: stop, signal: aborted, takeoverFrom: 'none' }),
    ).rejects.toThrow('stopping');
  });

  test('the check reports a webhook that moved, with Telegram last delivery error', async () => {
    const own = botApi(await telegramWebhookUrl(BASE, SECRET));
    expect(await checkTelegramWebhook(own.config)).toMatchObject({
      owned: true,
      pendingUpdates: 3,
    });
    expect(await checkTelegramWebhook(botApi(FOREIGN).config)).toEqual({
      owned: false,
      ownerHost: 'legacy.example.test',
      pendingUpdates: 3,
      lastError: {
        at: 1_700_000_000_000,
        message: 'Wrong response from the webhook: 403 Forbidden',
      },
    });
  });
});

describe('telegram webhook: one request', () => {
  const request = (body: string, secret?: string, method = 'POST') =>
    new Request(BASE, {
      method,
      ...(method === 'POST' && { body }),
      headers: secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret },
    });

  test('answers 403 without the secret, 400 for no update, 200 once recorded', async () => {
    const bodies: string[] = [];
    const options = {
      secret: SECRET,
      accept: async (body: string): Promise<TelegramUpdateAcceptance> => {
        bodies.push(body);
        return body.includes('update_id') ? 'accepted' : 'invalid';
      },
    };
    expect((await receiveTelegramWebhook(request('{}'), options)).status).toBe(403);
    expect((await receiveTelegramWebhook(request('{}', 'wrong'), options)).status).toBe(403);
    expect((await receiveTelegramWebhook(request('', SECRET, 'GET'), options)).status).toBe(
      405,
    );
    expect((await receiveTelegramWebhook(request('{}', SECRET), options)).status).toBe(400);
    expect(
      (await receiveTelegramWebhook(request('{"update_id":1}', SECRET), options)).status,
    ).toBe(200);
    expect(bodies).toEqual(['{}', '{"update_id":1}']);
  });
});
