/**
 * The secret values an environment holds, to be masked by value.
 *
 * A pattern masks what it can recognise — a bot token, a bearer header — and a
 * provider's API key, a webhook secret or a database password looks like any
 * other string. The environment already says which values are secret: by the
 * variable's name. So the schema names the secrets, not the code that logs:
 * a key added to the environment is masked from its first line.
 */

/** A variable holding a secret, by its name. */
const SECRET_NAME = /(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIALS?)(?:_ID)?$/;
/** A query parameter holding a secret, by its name. */
const SECRET_PARAMETER =
  /^(?:key|api[_-]?key|token|access[_-]?token|secret|password|passwd|sig|signature)$/i;

export interface SecretValuesOptions {
  /**
   * Shorter values are not collected. Default 8: a short value occurs in
   * ordinary text by itself, and masking it there would spoil lines without
   * protecting anything.
   */
  readonly minLength?: number;
}

/** A URL's password and secret query values — not its user name, which names a role. */
function urlSecrets(value: string): string[] {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || !URL.canParse(value)) return [];
  const url = new URL(value);
  const secrets = url.password === '' ? [] : [url.password, decodeURIComponent(url.password)];
  for (const [name, parameter] of url.searchParams) {
    if (SECRET_PARAMETER.test(name) && parameter !== '') secrets.push(parameter);
  }
  return secrets;
}

/**
 * Every secret value in `env`: variables named as a token, secret, key,
 * password or credential, the password and secret query values inside any URL
 * variable (`DATABASE_URL`), and each of them URL-encoded too. For a logger's
 * and an operator channel's `sensitiveValues`.
 */
export function secretValuesFromEnv(
  env: Readonly<Record<string, unknown>>,
  options: SecretValuesOptions = {},
): string[] {
  const minLength = options.minLength ?? 8;
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (SECRET_NAME.test(name.toUpperCase())) values.add(value);
    for (const secret of urlSecrets(value)) values.add(secret);
  }
  for (const value of [...values]) values.add(encodeURIComponent(value));
  return [...values]
    .filter((value) => value.length >= minLength)
    .sort((left, right) => right.length - left.length);
}
