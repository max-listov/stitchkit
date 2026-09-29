/**
 * `redact` masks a secret nobody named — by its shape — and keeps what an
 * error says about itself, so a journal line is safe and still useful.
 */
import { describe, expect, test } from 'bun:test';
import { createJsonLogger, redact } from '../src/entrypoints/observability';
import { redactTelegramBotToken, TelegramBotApiError } from '../src/entrypoints/telegram';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('secrets recognised by their shape', () => {
  test("a bot token keeps the bot's id and loses its secret, everywhere in a string", () => {
    expect(redact(`GET https://api.telegram.org/bot${TOKEN}/getMe and ${TOKEN}`)).toBe(
      'GET https://api.telegram.org/bot123456789:[redacted]/getMe and 123456789:[redacted]',
    );
    expect(redactTelegramBotToken(`/srv/bot-api/${TOKEN}/a ${TOKEN}`)).toBe(
      '/srv/bot-api/123456789:[redacted]/a 123456789:[redacted]',
    );
    // Not a token: too short an id, too short a secret.
    expect(redact('1234:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw 123456:short')).toBe(
      '1234:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw 123456:short',
    );
  });

  test('a password in an address is masked; its user, host and path stay', () => {
    expect(redact('postgresql://app:hunter2secret@db.internal:5432/app?sslmode=require')).toBe(
      'postgresql://app:[redacted]@db.internal:5432/app?sslmode=require',
    );
    expect(redact('see https://example.test/a:b@c')).toBe('see https://example.test/a:b@c');
  });

  test('a query parameter named as a secret is masked, and only its value', () => {
    expect(
      redact(
        'https://x.test/cb?state=ok&access_token=abc123&api-key=k1&key=AIza99&sig=zz#top',
      ),
    ).toBe(
      'https://x.test/cb?state=ok&access_token=[redacted]&api-key=[redacted]&key=[redacted]&sig=[redacted]#top',
    );
    expect(redact('https://x.test/?author=1&tokenizer=bpe')).toBe(
      'https://x.test/?author=1&tokenizer=bpe',
    );
  });
});

describe('an error in a journal line', () => {
  test("keeps its own fields — Telegram's answer — and names the objects it holds", () => {
    class Context {
      readonly update = { update_id: 1 };
    }
    const error = Object.assign(
      new TelegramBotApiError('sendMessage', {
        error_code: 429,
        description: 'Too Many Requests',
        parameters: { retry_after: 3 },
      }),
      { ctx: new Context(), apiKey: 'sk-live-1', status: 429 },
    );
    expect(redact(error)).toMatchObject({
      _type: 'error',
      name: 'TelegramBotApiError',
      method: 'sendMessage',
      error_code: 429,
      description: 'Too Many Requests',
      parameters: { retry_after: 3 },
      status: 429,
      ctx: '[Context]',
      apiKey: '[redacted]',
    });
  });

  test('an error that refers to itself is written once', () => {
    const error = new Error('loop');
    Object.assign(error, { self: error });
    expect(redact(error)).toMatchObject({ message: 'loop', self: '[circular]' });
  });

  test('the JSON logger writes all of it, masked', () => {
    const lines: string[] = [];
    const log = createJsonLogger({ write: (line) => void lines.push(line), now: () => 0 });
    log.error('send failed', {
      err: new TelegramBotApiError('sendMessage', { error_code: 403, description: 'blocked' }),
      url: `https://api.telegram.org/bot${TOKEN}/sendMessage`,
    });
    const line = JSON.parse(lines[0] ?? '{}');
    expect(line.err.error_code).toBe(403);
    expect(line.url).toBe('https://api.telegram.org/bot123456789:[redacted]/sendMessage');
    expect(lines[0]).not.toContain('AAHdqTcv');
  });
});
