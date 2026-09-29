import { describe, expect, test } from 'bun:test';
import { secretValuesFromEnv } from '../src/entrypoints/observability';
import { createJsonLogger } from '../src/observability/json-logger';
import { redact } from '../src/observability/sanitize';

/*
 * A provider key, a webhook secret or a database password has no shape a
 * pattern could recognise; the environment names them, and the journal masks
 * them by value wherever they appear.
 */

const ENV = {
  TELEGRAM_BOT_TOKEN: '123456:telegram-token-value-for-tests',
  TELEGRAM_WEBHOOK_SECRET: 'webhook-secret-value',
  PROVIDER_API_KEY: 'provider-key/with+chars',
  AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE0001',
  DATABASE_URL: 'postgresql://app_role:db-pass%2Fword@db.internal:5432/app',
  SOURCE_URL: 'https://api.example.test/v1?region=eu-central&api_key=query-key-0123',
  GOOGLE_CLIENT_ID: 'public-client-id.apps.example',
  PUBLIC_URL: 'https://app.example.test/path',
  SHORT_TOKEN: 'short',
  PORT: 3000,
};

describe('secretValuesFromEnv', () => {
  test('collects named secrets and the credentials inside URLs, encoded too, longest first', () => {
    const secrets = secretValuesFromEnv(ENV);
    for (const value of [
      ENV.TELEGRAM_BOT_TOKEN,
      ENV.TELEGRAM_WEBHOOK_SECRET,
      ENV.PROVIDER_API_KEY,
      encodeURIComponent(ENV.PROVIDER_API_KEY),
      ENV.AWS_ACCESS_KEY_ID,
      'db-pass%2Fword',
      'db-pass/word',
      'query-key-0123',
    ]) {
      expect(secrets).toContain(value);
    }
    for (const value of [
      'app_role',
      'eu-central',
      ENV.GOOGLE_CLIENT_ID,
      ENV.PUBLIC_URL,
      'short',
    ]) {
      expect(secrets).not.toContain(value);
    }
    expect(secrets).toEqual([...secrets].sort((left, right) => right.length - left.length));
    expect(secretValuesFromEnv(ENV, { minLength: 5 })).toContain('short');
  });

  test('a journal given them masks every occurrence in the message and in any field', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      write: (line) => lines.push(line),
      sensitiveValues: secretValuesFromEnv(ENV),
    });
    const failure = new Error(`connect failed: ${ENV.DATABASE_URL}`, {
      cause: new Error(`webhook ${ENV.TELEGRAM_WEBHOOK_SECRET} refused`),
    });
    logger.error(`provider said no to ${ENV.PROVIDER_API_KEY}`, {
      error: failure,
      attempts: [{ header: `Bearer ${encodeURIComponent(ENV.PROVIDER_API_KEY)}` }],
    });
    const line = lines.join('\n');
    for (const secret of secretValuesFromEnv(ENV)) expect(line).not.toContain(secret);
    expect(line).toContain('app_role');
    expect(line).toContain('[redacted]');
    // Negative control: the same record without the values keeps them.
    expect(JSON.stringify(redact({ note: ENV.PROVIDER_API_KEY }))).toContain(
      ENV.PROVIDER_API_KEY,
    );
  });

  test('a secret containing another is masked whole, whatever order the values came in', () => {
    const masked = redact('key provider-key-12345-extended', {
      sensitiveValues: ['provider-key-12345', 'provider-key-12345-extended'],
    });
    expect(masked).toBe('key [redacted]');
  });
});
