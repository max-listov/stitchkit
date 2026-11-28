import { describe, expect, test } from 'bun:test';
import type { AgentModelRequest } from '../src/agent-runtime/models-driver';
import { openRouterProvider } from '../src/agent-runtime/openrouter';
import { parseOpenRouterError } from '../src/agent-runtime/openrouter-response';
import {
  AgentProviderError,
  classifyProviderFailure,
} from '../src/agent-runtime/provider-failure';

function makeRequest(): AgentModelRequest {
  return {
    instructions: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
    settings: {},
    correlation: { conversationId: 'conv-1', attemptId: 'att-1', step: 0 },
  };
}

function sseResponse(frames: readonly string[]): Response {
  const payload = frames.join('');
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('OpenRouter HTTP 402 in-flight budget classification', () => {
  test('classifies HTTP 402 with limit_source openrouter_in_flight_budget as retryable overloaded', async () => {
    const parsed = parseOpenRouterError(
      {
        error: {
          code: 402,
          message: 'In-flight request budget exceeded',
          metadata: {
            provider_name: 'OpenRouter',
            limit_source: 'openrouter_in_flight_budget',
            reason: 'in_flight_budget',
          },
        },
      },
      '',
      402,
    );
    expect(parsed.statusCode).toBe(402);
    expect(parsed.failureReason).toBe('overloaded');
    expect(parsed.metadata).toEqual({
      provider_name: 'OpenRouter',
      limit_source: 'openrouter_in_flight_budget',
      reason: 'in_flight_budget',
    });

    // Nested metadata.raw JSON carrying openrouter_in_flight_budget also maps to retryable overloaded.
    const nestedParsed = parseOpenRouterError(
      {
        error: {
          code: 402,
          message: 'Provider returned error',
          metadata: {
            raw: JSON.stringify({
              error: {
                message: 'In-flight budget temporarily full',
                metadata: { limit_source: 'openrouter_in_flight_budget' },
              },
            }),
          },
        },
      },
      '',
      402,
    );
    expect(nestedParsed.failureReason).toBe('overloaded');

    // End-to-end HTTP 402 via openRouterProvider throws retryable AgentProviderError.
    const driver = openRouterProvider({
      apiKey: 'test-key',
      fetch: async () =>
        Response.json(
          {
            error: {
              code: 402,
              message: 'Too many concurrent pending requests',
              metadata: { limit_source: 'openrouter_in_flight_budget' },
            },
          },
          { status: 402 },
        ),
    }).create('openai/gpt-4.1');

    let caught: unknown;
    try {
      await driver.stream(makeRequest(), new AbortController().signal);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentProviderError);
    if (caught instanceof AgentProviderError) {
      expect(caught.statusCode).toBe(402);
      expect(caught.failureReason).toBe('overloaded');
      expect(caught.metadata).toEqual({ limit_source: 'openrouter_in_flight_budget' });
      expect(classifyProviderFailure(caught)).toEqual({
        reason: 'overloaded',
        status: 402,
        retryable: true,
        evidence: 'code',
      });
    }

    // End-to-end mid-stream SSE 402 error frame with openrouter_in_flight_budget is also retryable.
    const sseDriver = openRouterProvider({
      apiKey: 'test-key',
      fetch: async () =>
        sseResponse([
          `data: ${JSON.stringify({
            error: {
              code: 402,
              message: 'Concurrent reservation limit reached',
              metadata: { limit_source: 'openrouter_in_flight_budget' },
            },
          })}\n\n`,
        ]),
    }).create('openai/gpt-4.1');

    const stream = await sseDriver.stream(makeRequest(), new AbortController().signal);
    const errors: unknown[] = [];
    for await (const part of stream.parts) {
      if (part.type === 'error') errors.push(part.error);
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(AgentProviderError);
    if (errors[0] instanceof AgentProviderError) {
      expect(errors[0].statusCode).toBe(402);
      expect(errors[0].failureReason).toBe('overloaded');
      expect(classifyProviderFailure(errors[0])).toEqual({
        reason: 'overloaded',
        status: 402,
        retryable: true,
        evidence: 'code',
      });
    }
  });

  test('keeps ordinary HTTP 402 (account, key, or absent limit_source) as non-retryable insufficient-credits', async () => {
    for (const limitSource of ['account', 'key', undefined]) {
      const driver = openRouterProvider({
        apiKey: 'test-key',
        fetch: async () =>
          Response.json(
            {
              error: {
                code: 402,
                message: 'Insufficient credits',
                ...(limitSource !== undefined && { metadata: { limit_source: limitSource } }),
              },
            },
            { status: 402 },
          ),
      }).create('openai/gpt-4.1');

      let caught: unknown;
      try {
        await driver.stream(makeRequest(), new AbortController().signal);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AgentProviderError);
      if (caught instanceof AgentProviderError) {
        expect(caught.statusCode).toBe(402);
        expect(caught.failureReason).toBe('insufficient-credits');
        expect(classifyProviderFailure(caught)).toEqual({
          reason: 'insufficient-credits',
          status: 402,
          retryable: false,
          evidence: 'status',
        });
      }
    }
  });
});
