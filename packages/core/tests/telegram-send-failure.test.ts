/**
 * Guard: a refused send says whether to retry *this send* and whether to keep
 * addressing *this recipient* — two questions, two answers.
 *
 * Two consuming applications share a broadcast subsystem, three of its files
 * byte-identical, and inside it one list of substrings doing both jobs at once.
 * The cases below are the ones that list gets wrong or cannot express.
 */
import { describe, expect, test } from 'bun:test';
import { classifyTelegramSendFailure } from '../src/telegram';

/** A grammY error, in the shape it is thrown: code, prose and parameters. */
function botApiError(
  error_code: number,
  description: string,
  parameters?: Record<string, number>,
): Error {
  const error = new Error(`Call to 'sendMessage' failed! (${error_code}: ${description})`);
  return Object.assign(error, { error_code, description, ...(parameters && { parameters }) });
}

describe('a refused Telegram send is classified', () => {
  test('the four recipient refusals keep their own names', () => {
    // Each implies a different next move, which is why they are not one member:
    // a deactivated account can be closed, a block can be lifted, an unstarted
    // chat needs an invitation, and an unknown chat is usually our bad id.
    const cases = [
      [botApiError(403, 'Forbidden: bot was blocked by the user'), 'blocked-by-user'],
      [botApiError(403, 'Forbidden: user is deactivated'), 'user-deactivated'],
      [botApiError(400, 'Bad Request: chat not found'), 'chat-not-found'],
      [
        botApiError(403, "Forbidden: bot can't initiate conversation with a user"),
        'not-started',
      ],
    ] as const;
    for (const [error, reason] of cases) {
      const failure = classifyTelegramSendFailure(error);
      expect(failure.reason).toBe(reason);
      expect(failure.recipientUnreachable).toBe(true);
      expect(failure.retryable).toBe(false);
      expect(failure.evidence).toBe('description');
    }
  });

  test('a rate limit stops this send and implicates nobody', () => {
    const failure = classifyTelegramSendFailure(
      botApiError(429, 'Too Many Requests: retry after 30', { retry_after: 30 }),
    );
    expect(failure.reason).toBe('rate-limited');
    expect(failure.retryAfterSeconds).toBe(30);
    expect(failure.retryable).toBe(true);
    expect(failure.recipientUnreachable).toBe(false);
    // Telegram's own structured field, not our reading of its sentence.
    expect(failure.evidence).toBe('parameters');
  });

  test('a wait Telegram did not state is absent, never invented', () => {
    const failure = classifyTelegramSendFailure(botApiError(429, 'Too Many Requests'));
    expect(failure.reason).toBe('rate-limited');
    expect(failure.retryAfterSeconds).toBeUndefined();
    expect(failure.retryable).toBe(true);
    expect(failure.evidence).toBe('description');
  });

  test('our broken payload does not cost us the recipient', () => {
    // The case a substring list cannot express: nothing is wrong with the user,
    // and a sender that counts this as a delivery failure blacklists someone
    // over its own markdown.
    for (const description of [
      "Bad Request: can't parse entities: unexpected end tag",
      'Bad Request: message is too long',
    ]) {
      const failure = classifyTelegramSendFailure(botApiError(400, description));
      expect(failure.reason).toBe('message-invalid');
      expect(failure.recipientUnreachable).toBe(false);
      expect(failure.retryable).toBe(false);
    }
  });

  test('Telegram faltering is retryable and says nothing about the recipient', () => {
    const failure = classifyTelegramSendFailure(botApiError(502, 'Bad Gateway'));
    expect(failure.reason).toBe('server-error');
    expect(failure.retryable).toBe(true);
    expect(failure.recipientUnreachable).toBe(false);
    expect(failure.evidence).toBe('status');
  });

  test('an unrecognised refusal never marks a recipient unreachable', () => {
    // Dropping a working subscriber forever is far more expensive than one
    // wasted send, so the guess goes the other way.
    const failure = classifyTelegramSendFailure(new Error('socket hang up'));
    expect(failure.reason).toBe('unknown');
    expect(failure.recipientUnreachable).toBe(false);
    expect(failure.retryable).toBe(false);
    expect(failure.evidence).toBe('none');
  });

  test('a raw Bot API body classifies the same as a thrown error', () => {
    // Not every caller goes through a bot library; some read the response.
    const failure = classifyTelegramSendFailure({
      ok: false,
      error_code: 403,
      description: 'Forbidden: bot was blocked by the user',
    });
    expect(failure.reason).toBe('blocked-by-user');
    expect(failure.status).toBe(403);

    // And a failure wrapped one level down is still found.
    const wrapped = classifyTelegramSendFailure({
      cause: { error_code: 429, parameters: { retry_after: 7 } },
    });
    expect(wrapped.reason).toBe('rate-limited');
    expect(wrapped.retryAfterSeconds).toBe(7);
  });

  test('it never throws, whatever it is handed', () => {
    for (const value of [undefined, null, 0, '', [], { nothing: true }, new Error()]) {
      const failure = classifyTelegramSendFailure(value);
      expect(failure.reason).toBe('unknown');
      expect(failure.recipientUnreachable).toBe(false);
    }
    // A cycle must not become a stack overflow inside error handling.
    const cyclic: Record<string, unknown> = { error_code: 999 };
    cyclic.cause = cyclic;
    expect(classifyTelegramSendFailure(cyclic).reason).toBe('unknown');
  });
});
