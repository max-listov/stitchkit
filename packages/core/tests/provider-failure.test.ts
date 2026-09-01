/**
 * Guard: a provider refusal is a fact with a name, and an unrecognised one says
 * so instead of borrowing a name that fits.
 *
 * Three applications carry the same file for this; two byte-identical. The core
 * classifies and deliberately does not phrase — the sentence a user reads is the
 * application's, and a core writing product copy would be answering a question
 * nobody asked it.
 */
import { describe, expect, test } from 'bun:test';
import {
  type AgentProviderFailureReason,
  classifyProviderFailure,
  isToolResultFailure,
} from '../src/agent-runtime';

/** A provider error as the SDK hands it over: a status behind a `cause`. */
function apiError(status: number, message = 'request failed'): Error {
  const error = new Error(message);
  Object.assign(error, { cause: { statusCode: status } });
  return error;
}

describe('a provider failure is classified, never phrased', () => {
  test('a status the provider stated is read from the status, not the prose', () => {
    const cases: readonly [number, AgentProviderFailureReason][] = [
      [402, 'insufficient-credits'],
      [404, 'model-unavailable'],
      [408, 'timeout'],
      [413, 'context-overflow'],
      [429, 'rate-limited'],
    ];
    for (const [status, reason] of cases) {
      const failure = classifyProviderFailure(apiError(status));
      expect(failure.reason).toBe(reason);
      expect(failure.status).toBe(status);
      // Which evidence produced the answer is part of the answer: a caller
      // deciding to retry automatically should know it was not a prose guess.
      expect(failure.evidence).toBe('status');
    }
  });

  test('without a status the prose is read, and the answer says it was prose', () => {
    const cases: readonly [string, AgentProviderFailureReason][] = [
      ['Insufficient credits to complete this request', 'insufficient-credits'],
      ['Rate limit exceeded, please slow down', 'rate-limited'],
      ['No endpoints found for the requested model', 'model-unavailable'],
      ['This request exceeds the maximum context length', 'context-overflow'],
      ['The operation timed out', 'timeout'],
      ['The operation was aborted', 'cancelled'],
    ];
    for (const [message, reason] of cases) {
      const failure = classifyProviderFailure(new Error(message));
      expect(failure.reason).toBe(reason);
      expect(failure.evidence).toBe('message');
    }
  });

  test('an unrecognised failure is unknown, and is not retried on a guess', () => {
    const failure = classifyProviderFailure(new Error('the flux capacitor drifted'));
    expect(failure.reason).toBe('unknown');
    expect(failure.evidence).toBe('none');
    // A retry loop built on a guess is how one broken request becomes a bill.
    expect(failure.retryable).toBe(false);
  });

  test('retryable separates waiting from rewriting', () => {
    // The distinction that earns the field: waiting out a rate limit can work,
    // and repeating an unchanged oversized prompt fails identically forever.
    expect(classifyProviderFailure(apiError(429)).retryable).toBe(true);
    expect(classifyProviderFailure(apiError(408)).retryable).toBe(true);
    expect(classifyProviderFailure(apiError(413)).retryable).toBe(false);
    expect(classifyProviderFailure(apiError(404)).retryable).toBe(false);
  });

  test('a status wins over prose that suggests something else', () => {
    // The provider stating 429 outranks a message mentioning credits: one is its
    // own answer about itself, the other is our reading of its sentence.
    const failure = classifyProviderFailure(apiError(429, 'insufficient credits'));
    expect(failure.reason).toBe('rate-limited');
    expect(failure.evidence).toBe('status');
  });

  test('it never throws, whatever it is handed', () => {
    for (const value of [undefined, null, 0, '', [], { nothing: true }, new Error()]) {
      expect(classifyProviderFailure(value).reason).toBe('unknown');
    }
  });
});

describe('a successful tool result can be carrying a failure', () => {
  test('both wrapped shapes are recognised, and a plain success is not', () => {
    expect(isToolResultFailure('{"error":"FORBIDDEN"}')).toBe(true);
    // The envelope the SDK puts around a structured result.
    expect(isToolResultFailure('{"value":{"error":"CONFLICT"}}')).toBe(true);
    expect(isToolResultFailure({ error: 'NOT_FOUND' })).toBe(true);

    expect(isToolResultFailure('{"ok":true}')).toBe(false);
    expect(isToolResultFailure('{"value":{"ok":true}}')).toBe(false);
    // Plain text carries no envelope and therefore hides no error inside one.
    expect(isToolResultFailure('everything went fine')).toBe(false);
    expect(isToolResultFailure(undefined)).toBe(false);
  });
});
