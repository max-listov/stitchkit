/**
 * Secrets recognised by their shape, with no list of values to match.
 *
 * A journal line carries secrets nobody named: a request URL with a bot token
 * in its path, a database address with its password, a callback with
 * `?token=` — often another process's, so not in this one's environment. Each
 * shape masks only the secret part, so the line still says which bot, which
 * host, which parameter.
 */

/**
 * The secret half of a Telegram bot token, after the bot's numeric id and the
 * colon. The id is not a secret — it is the bot's public user id — and it is
 * what tells two bots' failures apart in a journal.
 */
export const BOT_TOKEN_SECRET = /(?<=\d{5,}:)[A-Za-z0-9_-]{30,}/;

/** The password of `scheme://user:password@host`; the user and host stay. */
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'<>]*:)([^\s/?#@"'<>]+)(?=@)/gi;

/** One query parameter: its separator, its name, its value. */
const QUERY_PARAMETER = /([?&;])([^=&#\s"'<>]+)=([^&#\s"'<>]*)/g;

/**
 * Query parameter names that carry a credential although the word is not a
 * secret in a field name — a `key` field is usually a lookup key, a `?key=` is
 * usually an API key.
 */
const QUERY_SECRET_NAMES = new Set(['key', 'sig', 'signature']);

function decoded(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/**
 * Mask every shaped secret in `input` with `mask`. `isSecretName` decides a
 * query parameter by its name, the same test a field name gets.
 */
export function maskSecretShapes(
  input: string,
  mask: string,
  isSecretName: (name: string) => boolean,
): string {
  return input
    .replace(new RegExp(BOT_TOKEN_SECRET.source, 'g'), mask)
    .replace(URL_PASSWORD, `$1${mask}`)
    .replace(QUERY_PARAMETER, (whole, separator: string, name: string) => {
      const plain = decoded(name);
      return isSecretName(plain) || QUERY_SECRET_NAMES.has(plain.toLowerCase())
        ? `${separator}${name}=${mask}`
        : whole;
    });
}
