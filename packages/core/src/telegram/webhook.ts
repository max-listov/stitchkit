/**
 * A bot's webhook: one place in all of Telegram, and who may take it.
 *
 * `setWebhook` moves a bot's updates without asking whose they were. A process
 * started anywhere with the production token — a developer's machine, a
 * staging host, a rehearsal — takes the production bot with one call, and the
 * production process simply stops hearing from Telegram. So a claim sets the
 * webhook only where it already points here, or where the caller named the
 * current owner's host as the one it takes over from (`'none'` when there is no
 * webhook — a bot on long polling is somebody's bot too).
 *
 * "Here" is the address *and* the secret. Telegram never returns the secret,
 * so the address carries a tag derived from it: an `owner` query parameter
 * holding an HMAC of the secret. A process with the production address but a
 * different secret has a different address and is refused, instead of quietly
 * installing its secret and leaving production answering 403 to every update.
 * Routers match the path, which the tag leaves alone; the secret cannot be
 * recovered from it. Errors and reports name hosts only — a foreign webhook's
 * path may itself be a secret.
 */

import { isRecord } from '../internal/typed';
import { callTelegramBotApi } from './bot-api';
import { digestsEqual, hmacSha256, toHex } from './crypto';
import type { TelegramFetch } from './transport';

const OWNER_PARAMETER = 'owner';
const OWNER_CONTEXT = 'stitchkit:telegram-webhook-owner';
const SECRET_SHAPE = /^[A-Za-z0-9_-]{1,256}$/;
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** `takeoverFrom` when there is no webhook to take over — the bot polls, or is new. */
export const TELEGRAM_WEBHOOK_NONE = 'none';

export interface TelegramWebhookConfig {
  readonly token: string;
  /** Where Telegram should post updates, without the owner tag. */
  readonly url: string;
  /** Telegram's `secret_token`: 1–256 of `A-Z a-z 0-9 _ -`. */
  readonly secret: string;
  /** A local Bot API server. Default: Telegram's. */
  readonly apiRoot?: string;
  readonly fetch?: TelegramFetch;
  readonly signal?: AbortSignal;
}

export interface ClaimTelegramWebhookConfig extends TelegramWebhookConfig {
  /**
   * The host the webhook may be taken from — the current owner's, as the
   * refusal names it — or `'none'` to set one where there is none. Set it for
   * one switch and remove it: left in place it is a standing permission.
   */
  readonly takeoverFrom?: string;
  /** Telegram's `allowed_updates`. Default: whatever the webhook had. */
  readonly allowedUpdates?: readonly string[];
  /** Telegram's `max_connections`, 1–100. */
  readonly maxConnections?: number;
  /** Default `false`: updates waiting for the previous owner are this owner's now. */
  readonly dropPendingUpdates?: boolean;
}

export interface TelegramWebhookClaim {
  /** The address set, owner tag included. */
  readonly url: string;
  /** The host it was taken over from; absent when it was already this one's. */
  readonly takenFrom?: string;
  readonly pendingUpdates: number;
}

export type TelegramWebhookRefusal =
  /** Another host holds the webhook. */
  | 'owned-elsewhere'
  /** This address holds it, registered with another secret. */
  | 'other-secret'
  /** Telegram accepted `setWebhook` but reports another address after it. */
  | 'not-confirmed';

export class TelegramWebhookClaimError extends Error {
  readonly reason: TelegramWebhookRefusal;
  /** Where the webhook points, as a host; `'none'` when nowhere. */
  readonly ownerHost: string;

  constructor(reason: TelegramWebhookRefusal, ownerHost: string) {
    super(
      reason === 'not-confirmed'
        ? `Telegram webhook was set but points to ${ownerHost} after it`
        : reason === 'other-secret'
          ? `Telegram webhook at ${ownerHost} is registered with another secret; refusing to ` +
            `replace it. takeoverFrom: '${ownerHost}' replaces it`
          : `Telegram webhook belongs to ${ownerHost}; refusing to take it over. ` +
            `takeoverFrom: '${ownerHost}' moves it here`,
    );
    this.name = 'TelegramWebhookClaimError';
    this.reason = reason;
    this.ownerHost = ownerHost;
  }
}

export interface TelegramWebhookState {
  /** The webhook points to this address with this secret. */
  readonly owned: boolean;
  readonly ownerHost: string;
  readonly pendingUpdates: number;
  /** Telegram's last failure to deliver, if it reported one. */
  readonly lastError?: { readonly at: number; readonly message: string };
}

function hostOf(url: string): string {
  if (url === '') return TELEGRAM_WEBHOOK_NONE;
  return URL.canParse(url) ? new URL(url).host : 'unknown';
}

function withoutTag(url: string): string {
  if (!URL.canParse(url)) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete(OWNER_PARAMETER);
  return parsed.toString();
}

/** The address with its owner tag: the same for every process with this secret. */
export async function telegramWebhookUrl(url: string, secret: string): Promise<string> {
  if (!SECRET_SHAPE.test(secret)) {
    throw new TypeError(
      '[stitchkit] telegram webhook: a secret is 1–256 of A-Z, a-z, 0-9, _ and -',
    );
  }
  const tagged = new URL(url);
  const tag = toHex(await hmacSha256(new TextEncoder().encode(secret), OWNER_CONTEXT));
  tagged.searchParams.set(OWNER_PARAMETER, tag.slice(0, 16));
  return tagged.toString();
}

interface WebhookInfo {
  readonly url: string;
  readonly pendingUpdates: number;
  readonly lastError?: { readonly at: number; readonly message: string };
}

async function webhookInfo(config: TelegramWebhookConfig): Promise<WebhookInfo> {
  const result = await callTelegramBotApi({ ...botCall(config), method: 'getWebhookInfo' });
  const info = isRecord(result) ? result : {};
  const at = info.last_error_date;
  const message = info.last_error_message;
  return {
    url: typeof info.url === 'string' ? info.url : '',
    pendingUpdates:
      typeof info.pending_update_count === 'number' ? info.pending_update_count : 0,
    ...(typeof at === 'number' &&
      typeof message === 'string' && { lastError: { at: at * 1_000, message } }),
  };
}

function botCall(config: TelegramWebhookConfig) {
  return {
    token: config.token,
    ...(config.apiRoot && { apiRoot: config.apiRoot }),
    ...(config.fetch && { fetch: config.fetch }),
    ...(config.signal && { signal: config.signal }),
  };
}

/**
 * Set the webhook if it is this process's to set, and confirm Telegram holds
 * it. Refused — without `setWebhook` — when another host or another secret
 * holds it and `takeoverFrom` does not name that holder.
 */
export async function claimTelegramWebhook(
  config: ClaimTelegramWebhookConfig,
): Promise<TelegramWebhookClaim> {
  const url = await telegramWebhookUrl(config.url, config.secret);
  const current = await webhookInfo(config);
  const ownerHost = hostOf(current.url);
  const owned = current.url === url;
  if (!owned && config.takeoverFrom !== ownerHost) {
    const sameAddress = current.url !== '' && withoutTag(current.url) === withoutTag(url);
    throw new TelegramWebhookClaimError(
      sameAddress ? 'other-secret' : 'owned-elsewhere',
      ownerHost,
    );
  }
  await callTelegramBotApi({
    ...botCall(config),
    method: 'setWebhook',
    params: {
      url,
      secret_token: config.secret,
      drop_pending_updates: config.dropPendingUpdates ?? false,
      ...(config.allowedUpdates && { allowed_updates: config.allowedUpdates }),
      ...(config.maxConnections !== undefined && { max_connections: config.maxConnections }),
    },
  });
  const confirmed = await webhookInfo(config);
  if (confirmed.url !== url) {
    throw new TelegramWebhookClaimError('not-confirmed', hostOf(confirmed.url));
  }
  return {
    url,
    ...(!owned && { takenFrom: ownerHost }),
    pendingUpdates: confirmed.pendingUpdates,
  };
}

/**
 * Whether the webhook still points here. A webhook moved to another host, or
 * re-registered with another secret, stops this process hearing from Telegram
 * without any error of its own — a periodic check is how it is noticed.
 */
export async function checkTelegramWebhook(
  config: TelegramWebhookConfig,
): Promise<TelegramWebhookState> {
  const url = await telegramWebhookUrl(config.url, config.secret);
  const info = await webhookInfo(config);
  return {
    owned: info.url === url,
    ownerHost: hostOf(info.url),
    pendingUpdates: info.pendingUpdates,
    ...(info.lastError && { lastError: info.lastError }),
  };
}

/** What becomes of an update body: recorded, seen before, or not an update. */
export type TelegramUpdateAcceptance = 'accepted' | 'duplicate' | 'invalid';

export interface ReceiveTelegramWebhookOptions {
  readonly secret: string;
  /** Records the update; answered to Telegram as soon as this resolves. */
  readonly accept: (body: string) => Promise<TelegramUpdateAcceptance>;
}

/**
 * Answer one webhook request: 403 without this secret, 400 for a body that is
 * not an update, 200 once the update is recorded — before it is handled.
 */
export async function receiveTelegramWebhook(
  request: Request,
  options: ReceiveTelegramWebhookOptions,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } });
  }
  const secret = request.headers.get(SECRET_HEADER);
  if (secret === null || !digestsEqual(secret, options.secret)) {
    return new Response(null, { status: 403 });
  }
  const acceptance = await options.accept(await request.text());
  return new Response(null, { status: acceptance === 'invalid' ? 400 : 200 });
}
