/**
 * Who a Telegram Mini App request is from, proved rather than believed.
 *
 * A Mini App hands its backend an `initData` string. Telegram signs it with a
 * key derived from the bot token, so a backend that checks the signature knows
 * the user; a backend that reads `initDataUnsafe` and trusts it has an open
 * door — the string is fully client-controlled, and the name Telegram gave that
 * field is the whole warning.
 *
 * Three consuming applications wrote this check independently. Two of the three
 * files agree closely enough to have shared an ancestor, and the third had
 * drifted: the algorithm is short, published, and easy to get *almost* right.
 * Almost right is the failure mode worth removing — a comparison that returns
 * early on the first differing byte, an expiry checked before the signature, a
 * `user` field read out of the string before anything proved it was ours.
 *
 * **This verifies; it does not phrase and it does not decide.** What a rejected
 * request should answer, whether an expired one may re-authenticate, which
 * fields a session keeps — those belong to the application. What the core owes
 * is the distinction between *authentic* and *not*, and the reason when not.
 *
 * Not a domain model (→ ADR 0002): "Telegram signed this string" is a fact
 * about a transport, the same kind of fact as a bearer token being well-formed.
 */

import { z } from 'zod';

/**
 * The Telegram user record, as our surface names things.
 *
 * Telegram's wire fields are `snake_case`; every other name this package
 * publishes is `camelCase`, and a surface that switches convention because of
 * where a value came from makes the caller remember which is which. The
 * untouched wire pairs stay available in `raw`.
 */
const TelegramInitDataUserSchema = z
  .object({
    id: z.int(),
    is_bot: z.boolean().optional(),
    first_name: z.string(),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional(),
    is_premium: z.boolean().optional(),
    allows_write_to_pm: z.boolean().optional(),
    photo_url: z.string().optional(),
  })
  .transform((user) => ({
    id: user.id,
    firstName: user.first_name,
    ...(user.is_bot !== undefined && { isBot: user.is_bot }),
    ...(user.last_name !== undefined && { lastName: user.last_name }),
    ...(user.username !== undefined && { username: user.username }),
    ...(user.language_code !== undefined && { languageCode: user.language_code }),
    ...(user.is_premium !== undefined && { isPremium: user.is_premium }),
    ...(user.allows_write_to_pm !== undefined && { allowsWriteToPm: user.allows_write_to_pm }),
    ...(user.photo_url !== undefined && { photoUrl: user.photo_url }),
  }));

export type TelegramInitDataUser = z.infer<typeof TelegramInitDataUserSchema>;

export interface TelegramInitData {
  /** Absent when the Mini App was opened somewhere Telegram sends no user. */
  user?: TelegramInitDataUser;
  /** Whose chat the Mini App was opened from, when Telegram named one. */
  receiver?: TelegramInitDataUser;
  /** When Telegram signed this string. */
  authDate: Date;
  /** How old the signature was at verification time. */
  ageSeconds: number;
  queryId?: string;
  startParam?: string;
  chatType?: string;
  chatInstance?: string;
  /**
   * Every signed pair exactly as Telegram sent it, `hash` excluded.
   *
   * Telegram adds fields without warning, and a caller that needs one this
   * release has never heard of should not have to wait for a release to read
   * it. Everything here was covered by the signature.
   */
  raw: Readonly<Record<string, string>>;
}

/**
 * Why a string was not accepted.
 *
 * `signature-mismatch` is the only one that means someone tampered; the others
 * are shapes a legitimate client can produce, and an application may well
 * answer them differently — an expired string is a re-open, a malformed one is
 * a bug report.
 */
export type TelegramInitDataRefusal =
  | 'missing-hash'
  | 'signature-mismatch'
  | 'malformed'
  | 'expired';

export type TelegramInitDataVerification =
  | { readonly valid: true; readonly data: TelegramInitData }
  | {
      readonly valid: false;
      readonly reason: TelegramInitDataRefusal;
      /** Present on `expired`, where the number is the point of the refusal. */
      readonly ageSeconds?: number;
    };

export interface VerifyTelegramInitDataOptions {
  /** The raw query-string Telegram handed the Mini App. */
  initData: string;
  /** The bot the Mini App belongs to. Never leaves this function. */
  botToken: string;
  /**
   * Refuse a signature older than this many seconds.
   *
   * A signed string stays valid forever unless something bounds it, so a
   * captured one is a permanent credential. Omitted means no bound, which is a
   * deliberate choice rather than a default: only the application knows how
   * long its own session is worth.
   */
  maxAgeSeconds?: number;
  /** Epoch milliseconds, for a caller that owns its own clock. */
  now?: () => number;
}

const encoder = new TextEncoder();

async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  message: string,
): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', imported, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * A plain `===` on a digest returns as soon as one byte disagrees, and the time
 * it took is a measurement of how much of the digest was right. The whole point
 * of the comparison is that an attacker cannot get a partial answer.
 */
function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function optionalUser(
  raw: Record<string, string>,
  key: string,
): TelegramInitDataUser | undefined {
  const encoded = raw[key];
  if (encoded === undefined) return undefined;
  return TelegramInitDataUserSchema.parse(JSON.parse(encoded));
}

/**
 * Verify one `initData` string and report what it says.
 *
 * Never throws for anything a client can send: a string that fails is a
 * refusal with a reason, because the caller has to answer the request either
 * way and an exception for the ordinary case turns every handler into a
 * `try`/`catch`. A missing bot token is not that case — it is this process
 * being configured wrong, and it throws.
 */
export async function verifyTelegramInitData(
  options: VerifyTelegramInitDataOptions,
): Promise<TelegramInitDataVerification> {
  if (!options.botToken) throw new TypeError('botToken is required to verify initData');
  if (
    options.maxAgeSeconds !== undefined &&
    (!Number.isFinite(options.maxAgeSeconds) || options.maxAgeSeconds < 0)
  ) {
    throw new TypeError('maxAgeSeconds must be a non-negative finite number');
  }

  const params = new URLSearchParams(options.initData);
  const hash = params.get('hash');
  if (!hash) return { valid: false, reason: 'missing-hash' };

  const signed: Record<string, string> = {};
  for (const [key, value] of params) {
    if (key === 'hash') continue;
    signed[key] = value;
  }

  // Telegram's data-check string: every remaining pair, sorted by key, joined
  // by newlines — over the *decoded* values, which is why the pairs are read
  // through URLSearchParams rather than split out of the raw string.
  const dataCheckString = Object.keys(signed)
    .sort()
    .map((key) => `${key}=${signed[key]}`)
    .join('\n');

  const secretKey = await hmacSha256(encoder.encode('WebAppData'), options.botToken);
  const expected = toHex(await hmacSha256(secretKey, dataCheckString));
  // The signature is checked before anything else is believed. An expiry read
  // out of an unsigned string is a number the sender chose.
  if (!digestsEqual(expected, hash.toLowerCase())) {
    return { valid: false, reason: 'signature-mismatch' };
  }

  const authDateSeconds = Number(signed.auth_date);
  if (!Number.isSafeInteger(authDateSeconds) || authDateSeconds <= 0) {
    return { valid: false, reason: 'malformed' };
  }
  const nowMs = options.now?.() ?? Date.now();
  const ageSeconds = Math.floor(nowMs / 1000) - authDateSeconds;
  if (options.maxAgeSeconds !== undefined && ageSeconds > options.maxAgeSeconds) {
    return { valid: false, reason: 'expired', ageSeconds };
  }

  let user: TelegramInitDataUser | undefined;
  let receiver: TelegramInitDataUser | undefined;
  try {
    user = optionalUser(signed, 'user');
    receiver = optionalUser(signed, 'receiver');
  } catch {
    // Authentic and still unreadable: Telegram signed a `user` payload this
    // version cannot parse. That is a different fact from a forged string and
    // gets a different name, so a caller can tell a client bug from an attack.
    return { valid: false, reason: 'malformed' };
  }

  return {
    valid: true,
    data: {
      ...(user !== undefined && { user }),
      ...(receiver !== undefined && { receiver }),
      authDate: new Date(authDateSeconds * 1000),
      ageSeconds,
      ...(signed.query_id !== undefined && { queryId: signed.query_id }),
      ...(signed.start_param !== undefined && { startParam: signed.start_param }),
      ...(signed.chat_type !== undefined && { chatType: signed.chat_type }),
      ...(signed.chat_instance !== undefined && { chatInstance: signed.chat_instance }),
      raw: Object.freeze({ ...signed }),
    },
  };
}
