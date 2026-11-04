/**
 * What tracking must not keep: passwords, sign-in credentials and a Telegram
 * Mini App's signed `initData`. The key stays and the value becomes a marker, so
 * the parameter is still visible; a path, `utm_*`, `ref` and every other
 * navigation or campaign parameter stay byte for byte.
 *
 * The browser applies this before sending, and an application's ingest applies
 * it again on receipt: a direct caller cannot be trusted to have run the client.
 */
const MASK = '[masked]';

/** Text past this is cut first: a URL is shorter, and these patterns are not linear. */
const MAX_REDACTED_CHARS = 16_384;

/** The signed launch data; the other Mini App parameters are navigation. */
const TELEGRAM_SIGNED_FIELD = 'tgwebappdata';
const PASSWORD_FIELD =
  /^(?:current|new|old|confirm|repeat|repeated)?(?:password|passwd|pwd)(?:confirmation)?$/;
const CREDENTIAL_FIELDS = new Set([
  'token',
  'accesstoken',
  'idtoken',
  'refreshtoken',
  'authtoken',
  'sessiontoken',
  'csrftoken',
  'resettoken',
  'magictoken',
  'secret',
  'clientsecret',
  'apikey',
  'privatekey',
  'authorization',
  'signature',
  'xamzsignature',
]);
/** `code` is a credential beside `state`, and an ordinary promo code alone. */
const OAUTH_FIELDS = new Set(['code', 'state', 'sessionstate']);
/** `hash` signs a Telegram login beside `auth_date`, and is an anchor alone. */
const SIGNED_LOGIN_FIELDS = new Set(['hash']);

const PARAMETER = /([?&#])([^=&#?\s]+)=([^&#\s]*)/g;
const URL_PASSWORD = /(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi;
const BEARER = /\b(bearer\s+)[^\s,;]+/gi;
const ASSIGNMENT =
  /(^|[^\w?&#/-])("[^"\n]+"|'[^'\n]+'|[\w.$[\]-]+)(\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/g;

interface SecretContext {
  oauth: boolean;
  signedLogin: boolean;
}

function fieldName(key: string): string {
  // `&amp;` is how a URL looks after passing through HTML; `token[0]` names `token`.
  const field =
    key
      .replace(/^amp;/, '')
      .split(/[.[\]]/)
      .filter((part) => part !== '' && !/^\d+$/.test(part))
      .at(-1) ?? '';
  return field.replace(/[-_\s]/g, '').toLowerCase();
}

function isSecretField(key: string, context?: SecretContext): boolean {
  const field = fieldName(key);
  if (PASSWORD_FIELD.test(field) || CREDENTIAL_FIELDS.has(field)) return true;
  if (field === TELEGRAM_SIGNED_FIELD) return true;
  if (context?.oauth && OAUTH_FIELDS.has(field)) return true;
  return Boolean(context?.signedLogin && SIGNED_LOGIN_FIELDS.has(field));
}

function decodeKey(key: string): string {
  try {
    return decodeURIComponent(key.replace(/\+/g, ' '));
  } catch {
    return key;
  }
}

/** Which families of context-dependent secrets the text proves by the parameters it carries. */
function secretContextOf(input: string): SecretContext {
  const names = new Set(
    Array.from(input.matchAll(PARAMETER), (match) => fieldName(decodeKey(match[2] ?? ''))),
  );
  return {
    oauth: names.has('state') && names.has('code'),
    signedLogin: names.has('authdate'),
  };
}

/** Mask secrets in a URL, a query string or free text, cut to 16 KiB. */
export function redactTrackingText(input: string): string {
  const text = input.slice(0, MAX_REDACTED_CHARS);
  const context = secretContextOf(text);
  return text
    .replace(URL_PASSWORD, `$1${MASK}$2`)
    .replace(BEARER, `$1${MASK}`)
    .replace(PARAMETER, (whole, separator: string, key: string, value: string) => {
      try {
        if (isSecretField(decodeKey(key), context)) return `${separator}${key}=${MASK}`;
        // A campaign value may itself be a URL or an assignment. Its encoding stays
        // unless its decoded form really holds a secret.
        const decoded = decodeURIComponent(value.replace(/\+/g, ' '));
        const redacted = redactTrackingText(decoded);
        return redacted === decoded
          ? whole
          : `${separator}${key}=${encodeURIComponent(redacted)}`;
      } catch {
        return whole;
      }
    })
    .replace(ASSIGNMENT, (whole, prefix: string, key: string, assignment: string) =>
      isSecretField(key.replace(/^["']|["']$/g, ''))
        ? `${prefix}${key}${assignment}${MASK}`
        : whole,
    );
}

/**
 * Mask the values of the named parameters wherever they appear in a URL — the
 * click markers an application recognises, whose value identifies one click.
 * Names match exactly, as `URLSearchParams` reads them.
 */
export function maskTrackingParameters(input: string, names: ReadonlySet<string>): string {
  if (names.size === 0) return input;
  return input.replace(PARAMETER, (whole, separator: string, key: string) =>
    names.has(decodeKey(key)) ? `${separator}${key}=${MASK}` : whole,
  );
}

/** The same rule through a value of any shape: a secret key masks whatever it holds. */
export function redactTrackingValue(value: unknown): unknown {
  if (typeof value === 'string') return redactTrackingText(value);
  if (Array.isArray(value)) return value.map(redactTrackingValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSecretField(key) ? MASK : redactTrackingValue(item),
      ]),
    );
  }
  return value;
}
