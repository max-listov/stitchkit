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
  AgentProviderError,
  AgentProviderStreamCutError,
  isAgentProviderError,
} from '../src/agent-runtime/provider-failure';
import {
  type AgentProviderFailureReason,
  classifyProviderFailure,
  isToolResultFailure,
} from '../src/entrypoints/agent-runtime';

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
      ['nonexistent-vendor/does-not-exist-0000 is not a valid model ID', 'model-unavailable'],
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
    // and repeating an unchanged oversized prompt or exhausted balance fails identically forever.
    expect(classifyProviderFailure(apiError(429)).retryable).toBe(true);
    expect(classifyProviderFailure(apiError(408)).retryable).toBe(true);
    expect(classifyProviderFailure(apiError(402)).retryable).toBe(false);
    expect(classifyProviderFailure(apiError(413)).retryable).toBe(false);
    expect(classifyProviderFailure(apiError(404)).retryable).toBe(false);
  });

  test('narrow insufficient credit regex excludes permissions/context/scope prose', () => {
    for (const msg of [
      'insufficient permissions',
      'insufficient context',
      'insufficient_scope',
    ]) {
      const failure = classifyProviderFailure(new Error(msg));
      expect(failure.reason).toBe('unknown');
      expect(failure.retryable).toBe(false);
    }
    for (const msg of [
      'insufficient credits',
      'insufficient credit',
      'insufficient funds',
      'insufficient balance',
      'insufficient_quota',
    ]) {
      const failure = classifyProviderFailure(new Error(msg));
      expect(failure.reason).toBe('insufficient-credits');
      expect(failure.retryable).toBe(false);
    }
  });

  test('AgentProviderError has statusCode without status alias, eagerly populates failureReason, and parents AgentProviderStreamCutError', () => {
    const httpErr = new AgentProviderError('Service down', {
      provider: 'openrouter',
      statusCode: 503,
    });
    expect(httpErr.statusCode).toBe(503);
    expect('status' in httpErr).toBe(false);
    expect(httpErr.failureReason).toBe('server-error');
    // Preserves honest 'status' provenance instead of forging 'code'
    expect(classifyProviderFailure(httpErr)).toMatchObject({
      reason: 'server-error',
      status: 503,
      retryable: true,
      evidence: 'status',
    });

    const cutErr = new AgentProviderStreamCutError('EOF', { provider: 'openai' });
    expect(cutErr).toBeInstanceOf(AgentProviderError);
    expect(cutErr.provider).toBe('openai');
    expect(cutErr.failureReason).toBe('stream-cut');
    expect(isAgentProviderError(httpErr)).toBe(true);
    expect(isAgentProviderError(cutErr)).toBe(true);
    expect(isAgentProviderError(new Error('plain'))).toBe(false);
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

  test('ignores Object.prototype keys, classifies model-does-not-exist prose, inspects both cause and response, and marks AgentProviderStreamCutError with code evidence', () => {
    // Prototype-chain keys must NEVER resolve to functions or throw.
    for (const protoKey of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(classifyProviderFailure({ code: protoKey })).toEqual({
        reason: 'unknown',
        retryable: false,
        evidence: 'none',
      });
      expect(classifyProviderFailure({ type: protoKey })).toEqual({
        reason: 'unknown',
        retryable: false,
        evidence: 'none',
      });
    }

    // "model ... does not exist" matches model-unavailable (including dotted model versions),
    // while non-model "does not exist" prose stays unknown (negative control).
    for (const msg of [
      'The model `gpt-5.1-fake` does not exist or you do not have access to it.',
      "model 'acme/nonexistent-v2' does not exist",
    ]) {
      expect(classifyProviderFailure(new Error(msg))).toMatchObject({
        reason: 'model-unavailable',
        retryable: false,
        evidence: 'message',
      });
    }
    expect(classifyProviderFailure(new Error('file /tmp/missing does not exist'))).toEqual({
      reason: 'unknown',
      retryable: false,
      evidence: 'none',
    });

    // When both `cause` (without status/code) and `response` (with status/code) exist, `response` is still inspected.
    const dualErr = Object.assign(new Error('request failed'), {
      cause: new Error('underlying detail'),
      response: { status: 429, error: { code: 'rate_limit_exceeded' } },
    });
    expect(classifyProviderFailure(dualErr)).toEqual({
      reason: 'rate-limited',
      status: 429,
      retryable: true,
      evidence: 'code',
    });
    const dualStatusOnly = Object.assign(new Error('request failed'), {
      cause: new Error('underlying detail'),
      response: { status: 503 },
    });
    expect(classifyProviderFailure(dualStatusOnly)).toEqual({
      reason: 'server-error',
      status: 503,
      retryable: true,
      evidence: 'status',
    });

    // Typed AgentProviderStreamCutError reports structured 'code' evidence, not 'none'.
    expect(
      classifyProviderFailure(new AgentProviderStreamCutError('EOF', { provider: 'openai' })),
    ).toEqual({
      reason: 'stream-cut',
      retryable: true,
      evidence: 'code',
    });
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
    expect(isToolResultFailure({ error: null })).toBe(false);
    expect(isToolResultFailure({ error: false })).toBe(false);
    expect(isToolResultFailure({ error: undefined })).toBe(false);
    expect(isToolResultFailure('{"error":null}')).toBe(false);
    expect(isToolResultFailure('{"value":{"error":false}}')).toBe(false);
    // Plain text carries no envelope and therefore hides no error inside one.
    expect(isToolResultFailure('everything went fine')).toBe(false);
    expect(isToolResultFailure(undefined)).toBe(false);
  });
});
