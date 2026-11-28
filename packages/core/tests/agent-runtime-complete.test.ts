import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type AgentModelDriver,
  type AgentModelMessage,
  type AgentModelStreamPart,
  AgentProviderError,
  AgentProviderStreamCutError,
  AgentRetryExhaustedError,
  type AgentStepResult,
  AgentStructuredOutputError,
  AgentToolApprovalError,
  type AgentUsage,
  type CompleteStreamPart,
  completeObject,
  completeText,
  streamComplete,
} from '../src/entrypoints/agent-runtime';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { type AgentTool, AgentToolError, defineAgentTool } from '../src/entrypoints/tools';

function reportedUsage(input: number, output: number, costUsd?: number): AgentUsage {
  return {
    inputTokens: { value: input, provenance: 'provider-reported' },
    outputTokens: { value: output, provenance: 'provider-reported' },
    ...(costUsd !== undefined && {
      cost: { value: costUsd, currency: 'USD', provenance: 'provider-reported' },
    }),
  };
}

describe('completeText & completeObject (B1 peer-free completion)', () => {
  test('completeText runs peer-free with multimodal messages, settings, cacheControl, ping, and timings', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const messages: AgentModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the image.' },
          {
            type: 'file',
            data: { type: 'data', data: bytes },
            mediaType: 'image/png',
            filename: 'shot.png',
          },
        ],
      },
    ];

    const driver = createScriptedModelDriver({
      provider: 'acme',
      modelId: 'acme-vision-1',
      steps: [
        [
          { type: 'response-metadata', id: 'resp-1', modelId: 'acme-vision-1' },
          { type: 'ping' },
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'A crisp ' },
          { type: 'text-delta', id: 't1', delta: 'PNG header.' },
          { type: 'text-end', id: 't1' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'end_turn',
            usage: reportedUsage(120, 14, 0.002),
            costDetails: { promptCostUsd: 0.0012, outputCostUsd: 0.0008, isByok: false },
            responseProvider: 'acme-east',
          },
        ],
      ],
    });

    const result = await completeText({
      driver,
      instructions: [
        {
          role: 'system',
          content: 'Be concise.',
          cacheControl: { type: 'ephemeral', ttl: '5m' },
        },
      ],
      messages,
      settings: { temperature: 0.1, topP: 0.9, seed: 7, maxOutputTokens: 256 },
      cacheControl: { type: 'ephemeral' },
      providerOptions: { acme: { region: 'eu' } },
      correlation: { conversationId: 'c-1', runId: 'r-1' },
    });

    expect(result.text).toBe('A crisp PNG header.');
    expect(result.finishReason).toBe('stop');
    expect(result.rawFinishReason).toBe('end_turn');
    expect(result.usage.inputTokens).toEqual({ value: 120, provenance: 'provider-reported' });
    expect(result.usage.outputTokens).toEqual({ value: 14, provenance: 'provider-reported' });
    expect(result.usage.cost).toEqual({
      value: 0.002,
      currency: 'USD',
      provenance: 'provider-reported',
    });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.costDetails).toEqual({
      promptCostUsd: 0.0012,
      outputCostUsd: 0.0008,
      isByok: false,
    });
    expect(result.steps[0]?.response.id).toBe('resp-1');
    expect(result.steps[0]?.response.provider).toBe('acme-east');
    expect(result.steps[0]?.timings?.stepTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.steps[0]?.timings?.ttftMs).toBeGreaterThanOrEqual(0);

    const req = driver.requests[0];
    expect(req?.instructions).toEqual([
      {
        role: 'system',
        content: 'Be concise.',
        cacheControl: { type: 'ephemeral', ttl: '5m' },
      },
    ]);
    expect(req?.messages).toEqual(messages);
    expect(req?.settings).toEqual({
      temperature: 0.1,
      topP: 0.9,
      seed: 7,
      maxOutputTokens: 256,
    });
    expect(req?.cacheControl).toEqual({ type: 'ephemeral' });
    expect(req?.providerOptions).toEqual({ acme: { region: 'eu' } });
    expect(req?.correlation.conversationId).toBe('c-1');
    expect(req?.correlation.runId).toBe('r-1');
    expect(req?.correlation.step).toBe(0);
  });

  test('completeText executes multi-step tools with prepareStep, deterministic order, and safe error redaction', async () => {
    const tools = {
      lookup: defineAgentTool({
        description: 'Look up an item',
        input: z.object({ id: z.string() }),
        execute: async ({ id }) => ({ found: true, id }),
      }),
      risky: defineAgentTool({
        description: 'A tool that crashes unexpectedly',
        input: z.object({ secret: z.string() }),
        execute: async ({ secret }) => {
          throw new Error(`boom with sensitive value ${secret}`);
        },
      }),
      guarded: defineAgentTool({
        description: 'A tool returning typed AgentToolError',
        input: z.object({ key: z.string() }),
        execute: async () => {
          throw new AgentToolError({ code: 'NOT_FOUND', message: 'Record missing' });
        },
      }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'lookup',
            input: JSON.stringify({ id: 'a1' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'risky',
            input: JSON.stringify({ secret: 'TOP_SECRET_TOKEN' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c3',
            toolName: 'guarded',
            input: JSON.stringify({ key: 'k' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c4',
            toolName: 'lookup',
            input: 'not-valid-json',
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: reportedUsage(30, 20),
          },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'All handled.' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: reportedUsage(60, 10),
          },
        ],
      ],
    });

    const finishedSteps: AgentStepResult[] = [];
    const seenInstructions: string[] = [];

    const result = await completeText({
      driver,
      instructions: 'Base instructions',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Run all tools' }] }],
      tools,
      maxSteps: 4,
      prepareStep: ({ stepNumber, instructions }) => {
        seenInstructions.push(
          typeof instructions === 'string'
            ? instructions
            : 'role' in instructions
              ? instructions.content
              : instructions.map((b) => b.content).join('\n'),
        );
        if (stepNumber === 0) {
          return { instructions: 'Step 1 override', temperature: 0 };
        }
        return { activeTools: ['lookup'] };
      },
      onStepFinish: (step) => {
        finishedSteps.push(step);
      },
    });

    expect(result.text).toBe('All handled.');
    expect(result.steps).toHaveLength(2);
    expect(finishedSteps).toHaveLength(2);
    expect(result.usage.inputTokens).toEqual({ value: 90, provenance: 'computed' });
    expect(result.usage.outputTokens).toEqual({ value: 30, provenance: 'computed' });

    // Step 1 override must NOT leak into Step 2's received instructions.
    expect(seenInstructions).toEqual(['Base instructions', 'Base instructions']);
    expect(driver.requests[0]?.instructions).toEqual([
      { role: 'system', content: 'Step 1 override' },
    ]);
    expect(driver.requests[1]?.instructions).toEqual([
      { role: 'system', content: 'Base instructions' },
    ]);
    expect(driver.requests[1]?.tools.map((t) => t.name)).toEqual(['lookup']);

    // Check deterministic tool result order & wire safety on step 2 request.
    const step2Messages = driver.requests[1]?.messages ?? [];
    const assistantMsg = step2Messages.find((m) => m.role === 'assistant');
    const toolMsg = step2Messages.find((m) => m.role === 'tool');
    expect(assistantMsg?.role).toBe('assistant');
    if (assistantMsg?.role === 'assistant' && typeof assistantMsg.content !== 'string') {
      const invalidCall = assistantMsg.content.find(
        (p) => p.type === 'tool-call' && p.toolCallId === 'c4',
      );
      expect(invalidCall?.type).toBe('tool-call');
      if (invalidCall?.type === 'tool-call') {
        expect(invalidCall.input).toEqual({});
      }
    }
    expect(toolMsg?.role).toBe('tool');
    if (toolMsg?.role === 'tool') {
      expect(
        toolMsg.content.map((p) => (p.type === 'tool-result' ? p.toolCallId : '')),
      ).toEqual(['c1', 'c2', 'c3', 'c4']);
      const riskyPart = toolMsg.content[1];
      const guardedPart = toolMsg.content[2];
      expect(riskyPart).toEqual({
        type: 'tool-result',
        toolCallId: 'c2',
        toolName: 'risky',
        output: { type: 'error-text', value: 'Tool execution failed' },
      });
      expect(JSON.stringify(toolMsg)).not.toContain('TOP_SECRET_TOKEN');
      expect(guardedPart).toEqual({
        type: 'tool-result',
        toolCallId: 'c3',
        toolName: 'guarded',
        output: {
          type: 'error-text',
          value: JSON.stringify({ code: 'NOT_FOUND', message: 'Record missing' }),
        },
      });
    }
  });

  test('completeText does not execute client tools on finishReason length and throws on stream cut', async () => {
    let toolRan = false;
    const tools = {
      act: defineAgentTool({
        description: 'Side effect',
        input: z.object({}),
        execute: async () => {
          toolRan = true;
          return { ok: true };
        },
      }),
    };

    const truncatedDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'act', input: '{}' },
          {
            type: 'finish',
            finishReason: 'length',
            usage: reportedUsage(10, 10),
          },
        ],
      ],
    });
    const res = await completeText({
      driver: truncatedDriver,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools,
      maxSteps: 3,
    });
    expect(res.finishReason).toBe('length');
    expect(toolRan).toBe(false);
    expect(truncatedDriver.requests).toHaveLength(1);

    const cutDriver = createScriptedModelDriver({
      steps: [[{ type: 'text-delta', id: 't1', delta: 'cut off' }]],
    });
    await expect(
      completeText({
        driver: cutDriver,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      }),
    ).rejects.toBeInstanceOf(AgentProviderStreamCutError);
  });

  test('completeObject enforces draft-2020-12 strict schema and supports multi-step tool loop', async () => {
    const AnswerSchema = z.object({
      city: z.string(),
      celsius: z.number(),
    });
    const tools = {
      weather: defineAgentTool({
        description: 'Get temperature',
        input: z.object({ city: z.string() }),
        execute: async ({ city }) => ({ city, celsius: 28 }),
      }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'w1',
            toolName: 'weather',
            input: JSON.stringify({ city: 'Kuala Lumpur' }),
          },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: reportedUsage(20, 15),
          },
        ],
        [
          {
            type: 'text-delta',
            id: 't2',
            delta: JSON.stringify({ city: 'Kuala Lumpur', celsius: 28 }),
          },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: reportedUsage(40, 12),
          },
        ],
      ],
    });

    const result = await completeObject({
      driver,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather in KL?' }] }],
      tools,
      maxSteps: 3,
      schema: AnswerSchema,
      schemaName: 'weather_answer',
      schemaDescription: 'Structured weather summary',
    });

    expect(result.object).toEqual({ city: 'Kuala Lumpur', celsius: 28 });
    expect(result.steps).toHaveLength(2);
    expect(result.usage.inputTokens).toEqual({ value: 60, provenance: 'computed' });
    expect(result.usage.outputTokens).toEqual({ value: 27, provenance: 'computed' });

    const fmt = driver.requests[0]?.responseFormat;
    expect(fmt?.type).toBe('json-schema');
    if (fmt?.type === 'json-schema') {
      expect(fmt.name).toBe('weather_answer');
      expect(fmt.description).toBe('Structured weather summary');
      expect(fmt.strict).toBe(true);
      expect(fmt.schema.type).toBe('object');
      expect(fmt.schema.additionalProperties).toBe(false);
    }
  });

  test('completeObject throws typed AgentStructuredOutputError for truncated, empty, invalid-json, and schema-mismatch', async () => {
    const Schema = z.object({ count: z.number().int().positive() });

    const runCase = async (
      text: string,
      finishReason: 'stop' | 'length' = 'stop',
    ): Promise<AgentStructuredOutputError> => {
      const driver = createScriptedModelDriver({
        steps: [
          [
            ...(text.length > 0
              ? [{ type: 'text-delta' as const, id: 't1', delta: text }]
              : []),
            {
              type: 'finish',
              finishReason,
              usage: reportedUsage(5, 5),
            },
          ],
        ],
      });
      try {
        await completeObject({
          driver,
          messages: [{ role: 'user', content: [{ type: 'text', text: 'emit' }] }],
          schema: Schema,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(AgentStructuredOutputError);
        if (error instanceof AgentStructuredOutputError) return error;
      }
      throw new Error('Expected completeObject to throw AgentStructuredOutputError');
    };

    const truncated = await runCase('{"count": 1', 'length');
    expect(truncated.reason).toBe('truncated');
    expect(truncated.finishReason).toBe('length');
    expect(truncated.rawText).toBe('{"count": 1');
    expect(truncated.usage?.inputTokens).toEqual({
      value: 5,
      provenance: 'provider-reported',
    });
    expect(truncated.usage?.outputTokens).toEqual({
      value: 5,
      provenance: 'provider-reported',
    });

    const empty = await runCase('   ', 'stop');
    expect(empty.reason).toBe('empty');
    expect(empty.finishReason).toBe('stop');

    const invalidJson = await runCase('{bad json}', 'stop');
    expect(invalidJson.reason).toBe('invalid-json');
    expect(invalidJson.cause).toBeInstanceOf(SyntaxError);

    const mismatch = await runCase(JSON.stringify({ count: -3 }), 'stop');
    expect(mismatch.reason).toBe('schema-mismatch');
    expect(mismatch.cause).toBeInstanceOf(z.ZodError);
    expect(mismatch.steps).toHaveLength(1);
  });

  test('completeObject supports .optional()/.transform()/.default() with strict-mode null stripping and distinguishes tool-calls, content-filter, and provider-error', async () => {
    const Schema = z.object({
      city: z.string().transform((value) => value.trim().toUpperCase()),
      note: z.string().optional(),
      explicitNull: z.string().nullable(),
      tags: z.array(z.string()).default(['general']),
    });

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'text-delta',
            id: 't1',
            delta: JSON.stringify({
              city: '  kuala lumpur ',
              note: null,
              explicitNull: null,
            }),
          },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(15, 10) },
        ],
      ],
    });

    const ok = await completeObject({
      driver,
      prompt: 'Give weather metadata',
      schema: Schema,
      schemaName: 'city_meta',
    });
    expect(ok.object).toEqual({
      city: 'KUALA LUMPUR',
      explicitNull: null,
      tags: ['general'],
    });
    expect('note' in ok.object).toBe(false);

    // Invalid schemaName (>64 chars or empty) fails fast through AgentModelResponseFormatSchema.
    await expect(
      completeObject({
        driver,
        prompt: 'x',
        schema: Schema,
        schemaName: '',
      }),
    ).rejects.toThrow();
    await expect(
      completeObject({
        driver,
        prompt: 'x',
        schema: Schema,
        schemaName: 'a'.repeat(65),
      }),
    ).rejects.toThrow();

    // finishReason: tool-calls exhausted at maxSteps -> reason 'tool-calls' with steps attached.
    const toolExhaustedDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(8, 4) },
        ],
      ],
    });
    try {
      await completeObject({
        driver: toolExhaustedDriver,
        prompt: 'call tool',
        maxSteps: 1,
        tools: {
          noop: defineAgentTool({
            description: 'No-op',
            input: z.object({}),
            execute: async () => ({ ok: true }),
          }),
        },
        schema: z.object({ done: z.boolean() }),
      });
      throw new Error('Expected AgentStructuredOutputError');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentStructuredOutputError);
      if (error instanceof AgentStructuredOutputError) {
        expect(error.reason).toBe('tool-calls');
        expect(error.finishReason).toBe('tool-calls');
        expect(error.steps).toHaveLength(1);
      }
    }

    // finishReason: content-filter and error produce distinct structured error reasons.
    for (const [finishReason, expectedReason] of [
      ['content-filter', 'content-filter'],
      ['error', 'provider-error'],
    ] as const) {
      const reasonDriver = createScriptedModelDriver({
        steps: [[{ type: 'finish', finishReason, usage: reportedUsage(4, 0) }]],
      });
      try {
        await completeObject({
          driver: reasonDriver,
          prompt: 'emit',
          schema: z.object({ done: z.boolean() }),
        });
        throw new Error('Expected AgentStructuredOutputError');
      } catch (error) {
        expect(error).toBeInstanceOf(AgentStructuredOutputError);
        if (error instanceof AgentStructuredOutputError) {
          expect(error.reason).toBe(expectedReason);
          expect(error.finishReason).toBe(finishReason);
          expect(error.steps).toHaveLength(1);
        }
      }
    }
  });

  test('completeText retries transient failures, reports onAttemptDiscarded, and throws AgentRetryExhaustedError with accumulated usage', async () => {
    let calls = 0;
    const discarded: Array<{ attempt: number; reason: string; inputTokens?: number }> = [];
    const flakyDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'flaky',
      async stream() {
        calls += 1;
        if (calls === 1) {
          throw new AgentProviderError('rate limited', {
            provider: 'test',
            statusCode: 429,
            retryAfterMs: 1,
          });
        }
        if (calls === 2) {
          return {
            parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
              yield {
                type: 'error',
                error: new AgentProviderError('upstream overloaded', {
                  provider: 'test',
                  statusCode: 529,
                }),
              };
              yield {
                type: 'finish',
                finishReason: 'error',
                usage: reportedUsage(11, 2, 0.001),
              };
            })(),
          };
        }
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'text-delta', id: 't1', delta: 'Recovered' };
            yield {
              type: 'finish',
              finishReason: 'stop',
              usage: reportedUsage(15, 5, 0.002),
            };
          })(),
        };
      },
    };

    const recovered = await completeText({
      driver: flakyDriver,
      prompt: 'hi',
      retry: { maxAttempts: 3, delayMs: () => 1 },
      onAttemptDiscarded: (record) => {
        discarded.push({
          attempt: record.attempt,
          reason: record.reason,
          ...(record.usage?.inputTokens.provenance !== 'unavailable' && {
            inputTokens: record.usage?.inputTokens.value,
          }),
        });
      },
    });
    expect(recovered.text).toBe('Recovered');
    expect(calls).toBe(3);
    expect(discarded).toEqual([
      { attempt: 1, reason: 'rate-limited' },
      { attempt: 2, reason: 'overloaded', inputTokens: 11 },
    ]);
    // Billable usage includes the discarded attempt 2 plus final attempt 3.
    expect(recovered.usage.inputTokens).toEqual({ value: 26, provenance: 'computed' });
    expect(recovered.usage.outputTokens).toEqual({ value: 7, provenance: 'computed' });

    // Exhausting retries throws AgentRetryExhaustedError with all attempts & accumulated usage.
    const alwaysOverloaded: AgentModelDriver = {
      provider: 'test',
      modelId: 'overloaded',
      async stream() {
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield {
              type: 'error',
              error: new AgentProviderError('still busy', {
                provider: 'test',
                statusCode: 503,
              }),
            };
            yield { type: 'finish', finishReason: 'error', usage: reportedUsage(10, 1) };
          })(),
        };
      },
    };
    try {
      await completeText({
        driver: alwaysOverloaded,
        prompt: 'hi',
        retry: { maxAttempts: 2, delayMs: () => 1 },
      });
      throw new Error('Expected AgentRetryExhaustedError');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRetryExhaustedError);
      if (error instanceof AgentRetryExhaustedError) {
        expect(error.attempts).toHaveLength(2);
        expect(error.lastError).toBeInstanceOf(AgentProviderError);
        expect(error.usage?.inputTokens).toEqual({ value: 20, provenance: 'computed' });
      }
    }

    // Non-retryable 402 stops on attempt 1 without waiting or retrying.
    let paymentCalls = 0;
    const paymentDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'broke',
      async stream() {
        paymentCalls += 1;
        throw new AgentProviderError('payment required', {
          provider: 'test',
          statusCode: 402,
        });
      },
    };
    await expect(
      completeText({
        driver: paymentDriver,
        prompt: 'hi',
        retry: { maxAttempts: 4, delayMs: () => 1 },
      }),
    ).rejects.toBeInstanceOf(AgentProviderError);
    expect(paymentCalls).toBe(1);
  });

  test('completeText enforces stopPolicies, idleTimeoutMs, and per-request headers', async () => {
    const tools = {
      slow: defineAgentTool({
        description: 'Slow tool that exceeds idleTimeoutMs while executing',
        input: z.object({ step: z.number() }),
        execute: async ({ step }) => {
          await Bun.sleep(45);
          return { step };
        },
      }),
    };
    const multiStepDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'slow', input: '{"step":1}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
        ],
        [
          { type: 'tool-call', toolCallId: 'c2', toolName: 'slow', input: '{"step":2}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(20, 5) },
        ],
        [
          { type: 'text-delta', id: 't3', delta: 'Should not run' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(30, 5) },
        ],
      ],
    });

    const stopped = await completeText({
      driver: multiStepDriver,
      prompt: 'run tools',
      tools,
      maxSteps: 5,
      // idleTimeoutMs suspends during slow tool execution (45ms > 25ms) so step 1 completes cleanly.
      idleTimeoutMs: 25,
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      stopPolicies: [
        {
          name: 'hold-exhausted',
          when: ({ steps }) => steps.length >= 2,
        },
      ],
    });
    expect(stopped.stoppedByPolicy).toBe('hold-exhausted');
    expect(stopped.steps).toHaveLength(2);
    expect(multiStepDriver.requests).toHaveLength(2);
    expect(multiStepDriver.requests[0]?.headers?.traceparent).toBe(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    );

    // Stalled provider stream triggers idleTimeoutMs and aborts cleanly.
    const hungDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'hung',
      async stream(_request, signal) {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise<IteratorResult<AgentModelStreamPart>>((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), {
                      once: true,
                    });
                  }),
              };
            },
          },
        };
      },
    };
    await expect(
      completeText({ driver: hungDriver, prompt: 'hang', idleTimeoutMs: 20 }),
    ).rejects.toThrow();

    // Duplicate/empty stopPolicy names and invalid idleTimeoutMs are rejected immediately.
    await expect(
      completeText({
        driver: multiStepDriver,
        prompt: 'x',
        stopPolicies: [{ name: '', when: () => false }],
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      completeText({
        driver: multiStepDriver,
        prompt: 'x',
        stopPolicies: [
          { name: 'dup', when: () => false },
          { name: 'dup', when: () => false },
        ],
      }),
    ).rejects.toThrow(TypeError);
    await expect(
      completeText({
        driver: multiStepDriver,
        prompt: 'x',
        idleTimeoutMs: -5,
      }),
    ).rejects.toThrow();
  });

  test('streamComplete and onPart stream reasoning, text, streaming tool results, and abort cleanly on early break', async () => {
    const tools = {
      streamer: defineAgentTool({
        description: 'Yields preliminary progress and final output',
        input: z.object({ label: z.string() }),
        async *execute({ label }) {
          yield { pct: 50, label };
          yield { pct: 100, label };
        },
      }),
    };
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'reasoning-delta', id: 'r1', delta: 'thinking...' },
          { type: 'tool-input-start', toolCallId: 'c1', toolName: 'streamer' },
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'streamer',
            input: '{"label":"go"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 8) },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Hello ' },
          { type: 'text-delta', id: 't2', delta: 'world!' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(20, 4) },
        ],
      ],
    });

    const stream = streamComplete({
      driver,
      prompt: 'Stream me everything',
      tools,
      maxSteps: 3,
    });
    const seen: CompleteStreamPart[] = [];
    for await (const part of stream.parts) {
      seen.push(part);
    }
    const final = await stream.result;
    expect(final.text).toBe('Hello world!');
    expect(seen.map((p) => p.type)).toEqual([
      'reasoning-delta',
      'tool-input-start',
      'tool-call',
      'tool-result',
      'tool-result',
      'tool-result',
      'finish-step',
      'text-delta',
      'text-delta',
      'finish-step',
      'finish',
    ]);
    const validatedCall = seen.find(
      (p): p is Extract<CompleteStreamPart, { type: 'tool-call' }> => p.type === 'tool-call',
    );
    expect(validatedCall?.input).toEqual({ label: 'go' });
    const finalPart = seen.at(-1);
    expect(finalPart?.type).toBe('finish');
    if (finalPart?.type === 'finish') {
      expect(finalPart.finishReason).toBe('stop');
      expect(finalPart.usage.inputTokens).toEqual({ value: 30, provenance: 'computed' });
    }
    const toolResults = seen.filter(
      (
        p,
      ): p is Extract<CompleteStreamPart, { type: 'tool-result'; providerExecuted: false }> =>
        p.type === 'tool-result' && p.providerExecuted === false,
    );
    expect(toolResults.map((r) => [r.preliminary, r.result])).toEqual([
      [true, { pct: 50, label: 'go' }],
      [true, { pct: 100, label: 'go' }],
      [false, { pct: 100, label: 'go' }],
    ]);

    // Double iteration on stream.parts is refused.
    expect(() => stream.parts[Symbol.asyncIterator]()).toThrow(TypeError);

    // Early break aborts the underlying provider stream cleanly without hanging.
    let providerAborted = false;
    const infiniteDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'inf',
      async stream(_request, signal) {
        signal.addEventListener('abort', () => {
          providerAborted = true;
        });
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            for (let i = 0; i < 1000; i += 1) {
              if (signal.aborted) return;
              yield { type: 'text-delta', id: 't', delta: `chunk-${i}` };
              await Bun.sleep(1);
            }
          })(),
        };
      },
    };
    const earlyStream = streamComplete({ driver: infiniteDriver, prompt: 'forever' });
    const received: string[] = [];
    for await (const part of earlyStream.parts) {
      if (part.type === 'text-delta') received.push(part.delta);
      if (received.length === 2) break;
    }
    expect(received).toEqual(['chunk-0', 'chunk-1']);
    expect(providerAborted).toBe(true);
    await expect(earlyStream.result).rejects.toThrow();
  });

  test('runStandaloneClientTools handles empty AsyncIterable, invokes onInputAvailable, and ignores aborted settlements', async () => {
    const inputCallbacks: string[] = [];
    const tools = {
      emptyGen: defineAgentTool({
        description: 'Empty async generator',
        input: z.object({ id: z.string() }),
        onInputAvailable: ({ input }) => {
          inputCallbacks.push(`emptyGen:${input.id}`);
        },
        async *execute() {
          // yields nothing
        },
      }),
      nonExecutable: defineAgentTool({
        description: 'Client-handled tool without execute',
        input: z.object({ note: z.string() }),
        onInputAvailable: ({ input }) => {
          inputCallbacks.push(`nonExecutable:${input.note}`);
        },
      }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'emptyGen', input: '{"id":"1"}' },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'nonExecutable',
            input: '{"note":"hi"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
        ],
      ],
    });
    const res = await completeText({ driver, prompt: 'run', tools, maxSteps: 3 });
    expect(inputCallbacks).toEqual(['emptyGen:1', 'nonExecutable:hi']);
    expect(res.steps[0]?.toolResults[0]?.output).toBeUndefined();
    // nonExecutable prevents auto-continuation because settledClientToolCount (1) < clientToolCallCount (2).
    expect(res.steps).toHaveLength(1);
  });

  test('defineAgentTool and completeText/completeObject honor cacheControl, providerOptions, strict, flattenUnionInput, toModelOutput, toolChoice, repairToolCall, signal, and responseFormat', async () => {
    const unionTool = defineAgentTool({
      description: 'Discriminated union input tool with custom wire output',
      input: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), val: z.string() }),
        z.object({ kind: z.literal('b'), count: z.number() }),
      ]),
      flattenUnionInput: true,
      strict: false,
      cacheControl: { type: 'ephemeral' },
      providerOptions: { acme: { tier: 'fast' } },
      toModelOutput: ({ output }) => ({ type: 'text', value: `custom:${String(output)}` }),
      execute: async (input) => (input.kind === 'a' ? input.val : input.count),
    });
    expect(unionTool.strict).toBe(false);
    expect(unionTool.cacheControl).toEqual({ type: 'ephemeral' });
    expect(unionTool.providerOptions).toEqual({ acme: { tier: 'fast' } });
    expect(unionTool.inputSchema.type).toBe('object');

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'union_typo',
            input: '{"kind":"a","val":"ok"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
        ],
        [
          { type: 'text-delta', id: 't2', delta: '{"ok":true}' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(20, 4) },
        ],
      ],
    });
    const controller = new AbortController();
    const res = await completeText({
      driver,
      prompt: 'go',
      tools: { unionTool },
      toolChoice: { type: 'tool', toolName: 'unionTool' },
      responseFormat: { type: 'json-object' },
      maxSteps: 3,
      signal: controller.signal,
      repairToolCall: ({ toolCall }) =>
        toolCall.toolName === 'union_typo'
          ? { toolCallId: toolCall.toolCallId, toolName: 'unionTool', input: toolCall.input }
          : null,
    });
    expect(res.text).toBe('{"ok":true}');
    expect(driver.requests[0]?.toolChoice).toEqual({ type: 'tool', toolName: 'unionTool' });
    expect(driver.requests[0]?.responseFormat).toEqual({ type: 'json-object' });
    expect(driver.requests[0]?.tools[0]).toMatchObject({
      name: 'unionTool',
      strict: false,
      cacheControl: { type: 'ephemeral' },
      providerOptions: { acme: { tier: 'fast' } },
    });
    const toolMsg = driver.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(toolMsg?.role === 'tool' ? toolMsg.content[0] : undefined).toMatchObject({
      type: 'tool-result',
      output: { type: 'text', value: 'custom:ok' },
    });

    // completeObject with strict: false preserves non-closed object schema and honors signal abort.
    const nonStrictDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'text-delta', id: 't1', delta: '{"name":"x"}' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 3) },
        ],
      ],
    });
    const loose = await completeObject({
      driver: nonStrictDriver,
      prompt: 'loose',
      schema: z.object({ name: z.string() }),
      strict: false,
    });
    expect(loose.object).toEqual({ name: 'x' });
    const fmt = nonStrictDriver.requests[0]?.responseFormat;
    expect(fmt?.type === 'json-schema' ? fmt.strict : undefined).toBe(false);
    expect(
      fmt?.type === 'json-schema' ? fmt.schema.additionalProperties : 'x',
    ).toBeUndefined();

    const aborted = new AbortController();
    aborted.abort(new Error('already aborted'));
    await expect(
      completeText({ driver: nonStrictDriver, prompt: 'x', signal: aborted.signal }),
    ).rejects.toThrow('already aborted');
  });

  test('streamComplete handles parallel streaming tools past backpressure limit, external abort while full, and retry buffer reset with in-band attempt-reset', async () => {
    // 1. Two parallel streaming tools each emitting 80 preliminary chunks (> 64 buffer limit) under slow consumer.
    const perTool = 80;
    const tools = {
      streamA: defineAgentTool({
        description: 'Fast parallel streamer A',
        input: z.object({}),
        async *execute() {
          for (let i = 0; i < perTool; i += 1) {
            yield { source: 'A', i };
          }
        },
      }),
      streamB: defineAgentTool({
        description: 'Fast parallel streamer B',
        input: z.object({}),
        async *execute() {
          for (let i = 0; i < perTool; i += 1) {
            yield { source: 'B', i };
          }
        },
      }),
    };
    const parallelDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'ca', toolName: 'streamA', input: '{}' },
          { type: 'tool-call', toolCallId: 'cb', toolName: 'streamB', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Both finished.' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(20, 4) },
        ],
      ],
    });
    const parallelStream = streamComplete({
      driver: parallelDriver,
      prompt: 'run both',
      tools,
      maxSteps: 3,
    });
    let prelimA = 0;
    let prelimB = 0;
    let finalToolResults = 0;
    for await (const part of parallelStream.parts) {
      if (part.type === 'tool-result' && part.providerExecuted === false) {
        if (part.preliminary === true) {
          if (part.toolName === 'streamA') prelimA += 1;
          if (part.toolName === 'streamB') prelimB += 1;
          if ((prelimA + prelimB) % 25 === 0) await Bun.sleep(1);
        } else {
          finalToolResults += 1;
        }
      }
    }
    const parallelRes = await parallelStream.result;
    expect(prelimA).toBe(perTool);
    expect(prelimB).toBe(perTool);
    expect(finalToolResults).toBe(2);
    expect(parallelRes.text).toBe('Both finished.');

    // 2. External signal.abort() while queue is completely full (backpressure) unblocks cleanly without hanging.
    const producerBlocked = Promise.withResolvers<void>();
    const floodDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'flood',
      async stream(_req, signal) {
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            for (let i = 0; i < 120; i += 1) {
              if (signal.aborted) return;
              if (i === 65) producerBlocked.resolve();
              yield { type: 'text-delta', id: 't', delta: `c${i}` };
            }
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 5) };
          })(),
        };
      },
    };
    const abortCtrl = new AbortController();
    const fullStream = streamComplete({
      driver: floodDriver,
      prompt: 'flood',
      signal: abortCtrl.signal,
    });
    const iter = fullStream.parts[Symbol.asyncIterator]();
    // Pull 1 item so iteration starts, then let producer fill the 64-item buffer and park on pushWaiters.
    const first = await iter.next();
    expect(first.done).toBe(false);
    await producerBlocked.promise;
    await Bun.sleep(5);
    const abortErr = new Error('cancelled during backpressure');
    abortCtrl.abort(abortErr);
    await expect(fullStream.result).rejects.toThrow('cancelled during backpressure');
    await expect(
      (async () => {
        for (;;) {
          const next = await iter.next();
          if (next.done) break;
        }
      })(),
    ).rejects.toThrow('cancelled during backpressure');

    // 3. Mid-stream retry clears stale buffered chunks of discarded attempt 1 and emits in-band attempt-reset.
    let retryCalls = 0;
    const midRetryDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'mid-retry',
      async stream() {
        retryCalls += 1;
        if (retryCalls === 1) {
          return {
            parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
              for (let i = 0; i < 10; i += 1) {
                yield { type: 'text-delta', id: 'a1', delta: `stale-${i}|` };
              }
              yield {
                type: 'error',
                error: new AgentProviderError('overloaded', {
                  provider: 'test',
                  statusCode: 529,
                }),
              };
              yield { type: 'finish', finishReason: 'error', usage: reportedUsage(12, 4) };
            })(),
          };
        }
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'text-delta', id: 'a2', delta: 'fresh-answer' };
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(14, 3) };
          })(),
        };
      },
    };
    let discardCalled = 0;
    const retryStream = streamComplete({
      driver: midRetryDriver,
      prompt: 'retry me',
      retry: { maxAttempts: 2, delayMs: () => 5 },
      onAttemptDiscarded: () => {
        discardCalled += 1;
      },
    });
    const retryIter = retryStream.parts[Symbol.asyncIterator]();
    // Read only 2 chunks so stale-2..stale-9 sit buffered when attempt 1 fails and retries.
    const seenRetryParts: CompleteStreamPart[] = [];
    for (let i = 0; i < 2; i += 1) {
      const next = await retryIter.next();
      if (!next.done) seenRetryParts.push(next.value);
    }
    // Wait until retry has discarded attempt 1 before draining the rest of the stream.
    await Bun.sleep(20);
    for (;;) {
      const next = await retryIter.next();
      if (next.done) break;
      seenRetryParts.push(next.value);
    }
    const retryResult = await retryStream.result;
    expect(discardCalled).toBe(1);
    expect(retryResult.text).toBe('fresh-answer');
    const resetIdx = seenRetryParts.findIndex((p) => p.type === 'attempt-reset');
    expect(resetIdx).toBeGreaterThan(-1);
    const resetPart = seenRetryParts[resetIdx];
    expect(resetPart).toMatchObject({
      type: 'attempt-reset',
      attempt: 1,
      reason: 'overloaded',
    });
    const afterReset = seenRetryParts.slice(resetIdx + 1);
    expect(
      afterReset
        .filter((p) => p.type === 'text-delta')
        .map((p) => (p.type === 'text-delta' ? p.delta : '')),
    ).toEqual(['fresh-answer']);
    // Stale buffered chunks stale-2..stale-9 from attempt 1 must NOT be delivered after discard.
    const deliveredTexts = seenRetryParts
      .filter(
        (p): p is Extract<CompleteStreamPart, { type: 'text-delta' }> =>
          p.type === 'text-delta',
      )
      .map((p) => p.delta);
    expect(deliveredTexts).not.toContain('stale-9|');

    // 4. Multi-step retry retains committed step 0 finish-step while dropping step 1 attempt 1 stale chunks.
    let step1Calls = 0;
    const multiStepRetryTools = {
      ping: defineAgentTool({
        description: 'ping',
        input: z.object({}),
        execute: async () => ({ pong: true }),
      }),
    };
    let totalCalls = 0;
    const multiStepRetryDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'multi-retry',
      async stream() {
        totalCalls += 1;
        if (totalCalls === 1) {
          return {
            parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
              yield { type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' };
              yield { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 3) };
            })(),
          };
        }
        step1Calls += 1;
        if (step1Calls === 1) {
          return {
            parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
              yield { type: 'text-delta', id: 's1a1', delta: 'stale-step1' };
              throw new AgentProviderStreamCutError('EOF', { provider: 'test' });
            })(),
          };
        }
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'text-delta', id: 's1a2', delta: 'clean-step1' };
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(8, 2) };
          })(),
        };
      },
    };
    const multiStream = streamComplete({
      driver: multiStepRetryDriver,
      prompt: 'two steps',
      tools: multiStepRetryTools,
      maxSteps: 3,
      retry: { maxAttempts: 2, delayMs: () => 5 },
    });
    // Delay consuming so step 0 finish-step AND step 1 attempt 1 sit in queue before retry fires.
    await Bun.sleep(25);
    const multiParts: CompleteStreamPart[] = [];
    for await (const part of multiStream.parts) {
      multiParts.push(part);
    }
    const multiRes = await multiStream.result;
    expect(multiRes.text).toBe('clean-step1');
    const stepFinishes = multiParts.filter((p) => p.type === 'finish-step');
    expect(stepFinishes).toHaveLength(2);
    expect(multiParts.some((p) => p.type === 'attempt-reset')).toBe(true);
    expect(multiParts.some((p) => p.type === 'text-delta' && p.delta === 'stale-step1')).toBe(
      false,
    );
  });

  test('streamComplete emits validated/repaired tool-call with parsed input, preserves provider-executed calls, and emits one final finish', async () => {
    const tools = {
      lookup: defineAgentTool({
        description: 'Lookup item',
        input: z.object({ id: z.number().int().positive() }),
        execute: async ({ id }) => ({ found: id }),
      }),
    };
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-input-start', toolCallId: 'c1', toolName: 'lookup_typo' },
          { type: 'tool-input-delta', toolCallId: 'c1', delta: '{"id":7}' },
          { type: 'tool-input-end', toolCallId: 'c1' },
          // Raw provider-executed call/result must pass through as-is.
          {
            type: 'tool-call',
            toolCallId: 'p1',
            toolName: 'web_search',
            input: '{"q":"news"}',
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'p1',
            toolName: 'web_search',
            result: { hits: 1 },
            providerExecuted: true,
          },
          // Client tool call needing repair (typo) and one invalid-input call.
          { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup_typo', input: '{"id":7}' },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'lookup', input: '{"id":-5}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 6) },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'Done' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'end_turn',
            usage: reportedUsage(20, 3),
          },
        ],
      ],
    });
    const stream = streamComplete({
      driver,
      prompt: 'go',
      tools,
      maxSteps: 3,
      repairToolCall: ({ toolCall }) =>
        toolCall.toolName === 'lookup_typo'
          ? { toolCallId: toolCall.toolCallId, toolName: 'lookup', input: toolCall.input }
          : null,
    });
    const parts: CompleteStreamPart[] = [];
    for await (const part of stream.parts) {
      parts.push(part);
    }
    await stream.result;

    // Raw string tool-call for client tools must NEVER leak into stream; only repaired/validated calls appear.
    const clientCalls = parts.filter(
      (p): p is Extract<CompleteStreamPart, { type: 'tool-call' }> =>
        p.type === 'tool-call' && p.providerExecuted !== true,
    );
    expect(clientCalls).toHaveLength(2);
    expect(clientCalls[0]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'c1',
      toolName: 'lookup',
      input: { id: 7 },
    });
    expect(clientCalls[1]).toMatchObject({
      type: 'tool-call',
      toolCallId: 'c2',
      toolName: 'lookup',
      input: { id: -5 },
      invalid: true,
    });
    expect(clientCalls[1]?.error).toBeDefined();

    // Provider-executed tool-call and tool-result forwarded untouched.
    expect(
      parts.some(
        (p) => p.type === 'tool-call' && p.toolCallId === 'p1' && p.providerExecuted === true,
      ),
    ).toBe(true);
    expect(
      parts.some(
        (p) =>
          p.type === 'tool-result' && p.toolCallId === 'p1' && p.providerExecuted === true,
      ),
    ).toBe(true);

    // Exactly ONE finish event at the very end of the loop (never prematurely after step 0!).
    const finishIndexes = parts
      .map((p, idx) => (p.type === 'finish' ? idx : -1))
      .filter((idx) => idx >= 0);
    expect(finishIndexes).toEqual([parts.length - 1]);
    const lastPart = parts.at(-1);
    expect(lastPart).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'end_turn',
    });
  });

  test('caller onPart failure never duplicates tool-result, aborts sibling parallel tools, and never triggers LLM retries', async () => {
    // 1. Throwing onPart on tool-result aborts an in-flight sibling tool and does not synthesize duplicate tool-error.
    let siblingAborted = false;
    let driverCalls = 0;
    const slowStarted = Promise.withResolvers<void>();
    const seenToolParts: string[] = [];
    const onPartBoom = new Error('fetch failed');
    const tools = {
      fast: defineAgentTool({
        description: 'Completes once sibling is in-flight',
        input: z.object({}),
        execute: async () => {
          await slowStarted.promise;
          return { ok: true };
        },
      }),
      slow: defineAgentTool({
        description: 'Waits for abortSignal',
        input: z.object({}),
        execute: async (_input, { abortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            if (abortSignal?.aborted) {
              siblingAborted = true;
              slowStarted.resolve();
              reject(abortSignal.reason);
              return;
            }
            abortSignal?.addEventListener(
              'abort',
              () => {
                siblingAborted = true;
                reject(abortSignal.reason);
              },
              { once: true },
            );
            slowStarted.resolve();
          }),
      }),
    };
    const toolDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'm',
      async stream() {
        driverCalls += 1;
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'tool-call', toolCallId: 'c-slow', toolName: 'slow', input: '{}' };
            yield { type: 'tool-call', toolCallId: 'c-fast', toolName: 'fast', input: '{}' };
            yield { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 3) };
          })(),
        };
      },
    };
    await expect(
      completeText({
        driver: toolDriver,
        prompt: 'parallel',
        tools,
        retry: { maxAttempts: 3, delayMs: () => 1 },
        onPart: (part) => {
          if (part.type === 'tool-result' || part.type === 'tool-error') {
            seenToolParts.push(`${part.type}:${part.toolCallId}`);
            if (part.type === 'tool-result' && part.toolCallId === 'c-fast') {
              throw onPartBoom;
            }
          }
        },
      }),
    ).rejects.toBe(onPartBoom);
    expect(siblingAborted).toBe(true);
    expect(driverCalls).toBe(1);
    expect(seenToolParts).toEqual(['tool-result:c-fast']);

    // 2. Throwing onPart with retryable-looking network prose on text-delta NEVER retries LLM.
    let modelAttempts = 0;
    const textDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'm',
      async stream() {
        modelAttempts += 1;
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'text-delta', id: 't1', delta: 'hi' };
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 2) };
          })(),
        };
      },
    };
    const networkLikeCallbackError = new Error('fetch failed: downstream UI socket closed');
    await expect(
      completeText({
        driver: textDriver,
        prompt: 'hello',
        retry: { maxAttempts: 4, delayMs: () => 1 },
        onPart: (part) => {
          if (part.type === 'text-delta') throw networkLikeCallbackError;
        },
      }),
    ).rejects.toBe(networkLikeCallbackError);
    expect(modelAttempts).toBe(1);
  });

  test('completeText checks !canContinue before stopPolicies, keeps prepareStep.driver sticky, and completeObject handles interrupted + literal schema keys', async () => {
    // 1. Natural finishReason 'stop' must NOT trigger stopPolicies or set stoppedByPolicy.
    let policyEvaluated = false;
    const singleStepDriver = createScriptedModelDriver({
      provider: 'primary',
      modelId: 'm-primary',
      steps: [
        [
          { type: 'text-delta', id: 't1', delta: 'Done naturally.' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 3) },
        ],
      ],
    });
    const natural = await completeText({
      driver: singleStepDriver,
      prompt: 'hi',
      stopPolicies: [
        {
          name: 'should-not-fire',
          when: () => {
            policyEvaluated = true;
            return true;
          },
        },
      ],
    });
    expect(natural.stoppedByPolicy).toBeUndefined();
    expect(policyEvaluated).toBe(false);
    expect(natural.steps[0]?.model).toEqual({ provider: 'primary', modelId: 'm-primary' });

    // 2. prepareStep.driver stays sticky across subsequent steps and is reported on step.model.
    const driverA = createScriptedModelDriver({
      provider: 'prov-a',
      modelId: 'model-a',
      steps: [],
    });
    const driverB = createScriptedModelDriver({
      provider: 'prov-b',
      modelId: 'model-b',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 2) },
        ],
        [
          { type: 'text-delta', id: 't2', delta: 'from B' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(8, 3) },
        ],
      ],
    });
    const seenDriversInPrepare: string[] = [];
    const stickyRes = await completeText({
      driver: driverA,
      prompt: 'switch',
      maxSteps: 3,
      tools: {
        ping: defineAgentTool({
          description: 'ping',
          input: z.object({}),
          execute: async () => 'pong',
        }),
      },
      prepareStep: ({ stepNumber, driver }) => {
        seenDriversInPrepare.push(`${driver.provider}/${driver.modelId}`);
        if (stepNumber === 0) return { driver: driverB };
        return undefined;
      },
    });
    expect(driverA.requests).toHaveLength(0);
    expect(driverB.requests).toHaveLength(2);
    expect(seenDriversInPrepare).toEqual(['prov-a/model-a', 'prov-b/model-b']);
    expect(stickyRes.steps.map((s) => s.model)).toEqual([
      { provider: 'prov-b', modelId: 'model-b' },
      { provider: 'prov-b', modelId: 'model-b' },
    ]);

    // 3. completeObject maps finishReason: 'interrupted' to AgentStructuredOutputError('interrupted').
    const interruptedDriver = createScriptedModelDriver({
      steps: [[{ type: 'finish', finishReason: 'interrupted', usage: reportedUsage(4, 1) }]],
    });
    try {
      await completeObject({
        driver: interruptedDriver,
        prompt: 'emit',
        schema: z.object({ ok: z.boolean() }),
      });
      throw new Error('Expected AgentStructuredOutputError');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentStructuredOutputError);
      if (error instanceof AgentStructuredOutputError) {
        expect(error.reason).toBe('interrupted');
        expect(error.finishReason).toBe('interrupted');
      }
    }

    // 4. closeStrictObjectNodes skips literal default/enum/const/examples values while still closing a property literally named "default".
    const LiteralEdgeSchema = z.object({
      template: z
        .object({ type: z.string(), properties: z.object({ x: z.number() }) })
        .default({ type: 'object', properties: { x: 1 } }),
      default: z.object({ inner: z.string() }),
    });
    const schemaInspectDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'text-delta',
            id: 't1',
            delta: JSON.stringify({
              template: { type: 'object', properties: { x: 2 } },
              default: { inner: 'ok' },
            }),
          },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 5) },
        ],
      ],
    });
    const parsedLiteral = await completeObject({
      driver: schemaInspectDriver,
      prompt: 'emit',
      schema: LiteralEdgeSchema,
    });
    expect(parsedLiteral.object.default).toEqual({ inner: 'ok' });
    const fmt = schemaInspectDriver.requests[0]?.responseFormat;
    expect(fmt?.type).toBe('json-schema');
    if (fmt?.type === 'json-schema') {
      const props = fmt.schema.properties;
      expect(typeof props === 'object' && props !== null).toBe(true);
      if (typeof props === 'object' && props !== null) {
        const templateProp = Reflect.get(props, 'template');
        const templateDefault =
          typeof templateProp === 'object' && templateProp !== null
            ? Reflect.get(templateProp, 'default')
            : undefined;
        // Literal `default` value inside `template` schema must NOT be mutated with additionalProperties: false.
        expect(templateDefault).toEqual({ type: 'object', properties: { x: 1 } });
        expect(
          typeof templateDefault === 'object' &&
            templateDefault !== null &&
            'additionalProperties' in templateDefault,
        ).toBe(false);
        // Property literally named `default` IS a schema object and MUST be closed with additionalProperties: false.
        const defaultProp = Reflect.get(props, 'default');
        expect(
          typeof defaultProp === 'object' && defaultProp !== null
            ? Reflect.get(defaultProp, 'additionalProperties')
            : undefined,
        ).toBe(false);
      }
    }
  });

  test('defineAgentTool({ output }) supports .transform()/.default(), zero-lag streaming, empty iterable without fabricated preliminary, hand-built outputSchema, and file.filename', async () => {
    const releaseSecond = Promise.withResolvers<void>();
    let chunk2Produced = false;
    const toModelObserved: unknown[] = [];

    const transformTool = defineAgentTool({
      input: z.object({ raw: z.string() }),
      output: z.object({
        n: z.string().transform(Number),
        d: z.boolean().default(true),
      }),
      execute: async ({ raw }) => ({ n: raw }),
      toModelOutput: ({ output }) => {
        toModelObserved.push(output);
        return { type: 'text', value: `n=${output.n},d=${output.d}` };
      },
    });

    const liveStreamTool = defineAgentTool({
      input: z.object({}),
      output: z.object({
        n: z.string().transform(Number),
        d: z.boolean().default(true),
        progress: z.number().optional(),
      }),
      async *execute() {
        yield { n: '1', progress: 1 };
        await releaseSecond.promise;
        chunk2Produced = true;
        yield { n: '77' };
      },
    });

    const emptyStrictTool = defineAgentTool({
      input: z.object({}),
      output: z.object({ required: z.number() }),
      async *execute() {
        // yields nothing
      },
    });

    const handBuiltTool: AgentTool = {
      inputSchema: { type: 'object', properties: {} },
      outputSchema: z.object({ count: z.string().transform(Number) }),
      execute: () => ({ count: '12' }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'c-tr',
            toolName: 'transformTool',
            input: '{"raw":"42"}',
          },
          { type: 'tool-call', toolCallId: 'c-st', toolName: 'liveStreamTool', input: '{}' },
          { type: 'tool-call', toolCallId: 'c-em', toolName: 'emptyStrictTool', input: '{}' },
          { type: 'tool-call', toolCallId: 'c-hb', toolName: 'handBuiltTool', input: '{}' },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
        ],
        [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
            filename: 'chart.png',
          },
          { type: 'text-delta', id: 't-end', delta: 'done' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(20, 4) },
        ],
      ],
    });

    const stream = streamComplete({
      driver,
      prompt: 'run all tools',
      tools: { transformTool, liveStreamTool, emptyStrictTool, handBuiltTool },
    });

    const parts: CompleteStreamPart[] = [];
    const preliminaryEvents: Array<{ result: unknown; chunk2Produced: boolean }> = [];
    for await (const part of stream.parts) {
      parts.push(part);
      if (
        part.type === 'tool-result' &&
        part.toolCallId === 'c-st' &&
        part.preliminary === true
      ) {
        preliminaryEvents.push({ result: part.result, chunk2Produced });
        releaseSecond.resolve();
      }
    }
    const result = await stream.result;

    // 1. Sync/async .transform() + .default() validated ONCE and passed transformed to toModelOutput.
    expect(toModelObserved).toEqual([{ n: 42, d: true }]);
    expect(
      parts.find(
        (p) => p.type === 'tool-result' && p.toolCallId === 'c-tr' && p.preliminary === false,
      ),
    ).toMatchObject({ result: { n: 42, d: true } });

    // 2. Streaming tool yielded chunk 1 BEFORE chunk 2 was produced, and final chunk was transformed.
    expect(preliminaryEvents).toEqual([
      { result: { n: '1', progress: 1 }, chunk2Produced: false },
      { result: { n: '77' }, chunk2Produced: true },
    ]);
    expect(
      parts.find(
        (p) => p.type === 'tool-result' && p.toolCallId === 'c-st' && p.preliminary === false,
      ),
    ).toMatchObject({ result: { n: 77, d: true } });

    // 3. Empty AsyncIterable emitted ZERO preliminary events and failed final validation cleanly.
    expect(
      parts.filter(
        (p) => p.type === 'tool-result' && p.toolCallId === 'c-em' && p.preliminary === true,
      ),
    ).toEqual([]);
    expect(parts.some((p) => p.type === 'tool-error' && p.toolCallId === 'c-em')).toBe(true);

    // 4. Hand-constructed AgentTool literal with outputSchema was validated and transformed at finalization.
    expect(
      parts.find(
        (p) => p.type === 'tool-result' && p.toolCallId === 'c-hb' && p.preliminary === false,
      ),
    ).toMatchObject({ result: { count: 12 } });

    // 5. Optional filename on AgentModelStreamPart `file` preserved in step content and responseMessages.
    const stepFile = result.steps[1]?.content.find((c) => c.type === 'file');
    expect(stepFile?.type === 'file' && stepFile.filename).toBe('chart.png');
    const assistantMsg = result.responseMessages.at(-1);
    expect(assistantMsg?.role).toBe('assistant');
    if (assistantMsg?.role === 'assistant' && Array.isArray(assistantMsg.content)) {
      const msgFile = assistantMsg.content.find((c) => c.type === 'file');
      expect(msgFile?.type === 'file' && msgFile.filename).toBe('chart.png');
    }
  });

  test('completeObject integrates z.discriminatedUnion + z.array(ObjWithOpt).nullable() and fails fast on z.record() through OpenAI/Anthropic strict schemas', async () => {
    const RichSchema = z.object({
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('reply'), body: z.string(), note: z.string().optional() }),
        z.object({
          kind: z.literal('escalate'),
          level: z.number(),
          tag: z.string().optional(),
        }),
      ]),
      items: z.array(z.object({ id: z.string(), label: z.string().optional() })).nullable(),
    });

    // Strict-mode provider echoes `null` for optional fields inside both the discriminatedUnion branch and nullable array items.
    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'text-delta',
            id: 't1',
            delta: JSON.stringify({
              action: { kind: 'reply', body: 'hi', note: null },
              items: [
                { id: '1', label: null },
                { id: '2', label: 'kept' },
              ],
            }),
          },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(10, 8) },
        ],
      ],
    });
    const out = await completeObject({
      driver,
      prompt: 'return structured object',
      schema: RichSchema,
    });
    expect(out.object).toEqual({
      action: { kind: 'reply', body: 'hi' },
      items: [{ id: '1' }, { id: '2', label: 'kept' }],
    });

    // Also verify null value for the nullable array itself stays null (never stripped!).
    const nullDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'text-delta',
            id: 't1',
            delta: JSON.stringify({
              action: { kind: 'escalate', level: 2, tag: null },
              items: null,
            }),
          },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(10, 8) },
        ],
      ],
    });
    const nullOut = await completeObject({
      driver: nullDriver,
      prompt: 'return null items',
      schema: RichSchema,
    });
    expect(nullOut.object).toEqual({
      action: { kind: 'escalate', level: 2 },
      items: null,
    });

    // Negative control: z.record() fails fast (I9) when passed to strict OpenAI or Anthropic providers.
    const { openAiProvider } = await import('../src/entrypoints/agent-runtime/openai');
    const { anthropicProvider } = await import('../src/entrypoints/agent-runtime/anthropic');
    let fetchCalled = false;
    const guardFetch = async () => {
      fetchCalled = true;
      return new Response('{}', { status: 200 });
    };
    const RecordSchema = z.object({ labels: z.record(z.string(), z.string()) });
    await expect(
      completeObject({
        driver: openAiProvider({ apiKey: 'sk-test', fetch: guardFetch }).create(
          'gpt-4.1-mini',
        ),
        prompt: 'record',
        schema: RecordSchema,
      }),
    ).rejects.toThrow(/z\.record|additionalProperties|strict/i);
    await expect(
      completeObject({
        driver: anthropicProvider({
          apiKey: 'sk-ant-test',
          fetch: guardFetch,
        }).create('claude-sonnet-4-5'),
        prompt: 'record',
        settings: { maxOutputTokens: 256 },
        schema: RecordSchema,
      }),
    ).rejects.toThrow(/z\.record|additionalProperties|strict/i);
    expect(fetchCalled).toBe(false);
  });

  test('completeText, streamComplete, and completeObject enforce tool.needsApproval fail-closed without calling execute', async () => {
    let executedCount = 0;
    const predicateCalls: Array<{
      action: string;
      toolCallId: string;
      messageCount: number;
      hasSignal: boolean;
    }> = [];
    const tools = {
      alwaysGated: defineAgentTool({
        description: 'Static approval gate',
        input: z.object({ target: z.string() }),
        needsApproval: true,
        execute: async () => {
          executedCount += 1;
          return { done: true };
        },
      }),
      conditionalGated: defineAgentTool({
        description: 'Async predicate approval gate',
        input: z.object({ action: z.enum(['read', 'delete']) }),
        needsApproval: async (input, call) => {
          predicateCalls.push({
            action: input.action,
            toolCallId: call.toolCallId,
            messageCount: call.messages.length,
            hasSignal: call.abortSignal instanceof AbortSignal,
          });
          return input.action === 'delete';
        },
        execute: async ({ action }) => {
          executedCount += 1;
          return { ran: action };
        },
      }),
      throwingPredicate: defineAgentTool({
        description: 'Approval predicate fails',
        input: z.object({}),
        needsApproval: async () => {
          throw new Error('approval store unreachable');
        },
        execute: async () => {
          executedCount += 1;
          return { ok: true };
        },
      }),
      clientOnlyGated: defineAgentTool({
        description: 'Non-executable client tool with needsApproval',
        input: z.object({ note: z.string() }),
        needsApproval: true,
      }),
    };

    // 1. Static needsApproval: true fails closed in completeText without calling execute.
    await expect(
      completeText({
        driver: createScriptedModelDriver({
          steps: [
            [
              {
                type: 'tool-call',
                toolCallId: 'c-static',
                toolName: 'alwaysGated',
                input: '{"target":"prod"}',
              },
              { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
            ],
          ],
        }),
        prompt: 'drop prod',
        tools,
      }),
    ).rejects.toMatchObject({
      name: 'AgentToolApprovalError',
      reason: 'approval-unsupported',
    });
    expect(executedCount).toBe(0);

    // 2. Async predicate returning true fails closed in streamComplete on both result and parts.
    const gatedStream = streamComplete({
      driver: createScriptedModelDriver({
        steps: [
          [
            {
              type: 'tool-call',
              toolCallId: 'c-pred-true',
              toolName: 'conditionalGated',
              input: '{"action":"delete"}',
            },
            { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
          ],
        ],
      }),
      prompt: 'delete record',
      tools,
    });
    await expect(gatedStream.result).rejects.toBeInstanceOf(AgentToolApprovalError);
    await expect(gatedStream.result).rejects.toMatchObject({ reason: 'approval-unsupported' });
    await expect(
      (async () => {
        for await (const _part of gatedStream.parts) {
          // drain until error
        }
      })(),
    ).rejects.toMatchObject({
      name: 'AgentToolApprovalError',
      reason: 'approval-unsupported',
    });
    expect(executedCount).toBe(0);
    expect(predicateCalls).toEqual([
      { action: 'delete', toolCallId: 'c-pred-true', messageCount: 1, hasSignal: true },
    ]);

    // 3. completeObject also fails closed without executing.
    await expect(
      completeObject({
        driver: createScriptedModelDriver({
          steps: [
            [
              {
                type: 'tool-call',
                toolCallId: 'c-obj',
                toolName: 'alwaysGated',
                input: '{"target":"db"}',
              },
              { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
            ],
          ],
        }),
        prompt: 'run gated tool then json',
        schema: z.object({ ok: z.boolean() }),
        tools,
      }),
    ).rejects.toMatchObject({
      name: 'AgentToolApprovalError',
      reason: 'approval-unsupported',
    });
    expect(executedCount).toBe(0);

    // 4. Throwing predicate fails closed without calling execute.
    await expect(
      completeText({
        driver: createScriptedModelDriver({
          steps: [
            [
              {
                type: 'tool-call',
                toolCallId: 'c-throw',
                toolName: 'throwingPredicate',
                input: '{}',
              },
              { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
            ],
          ],
        }),
        prompt: 'check',
        tools,
      }),
    ).rejects.toThrow('approval store unreachable');
    expect(executedCount).toBe(0);

    // 5. Negative control: predicate returning false allows execution in both completeText and streamComplete.
    const allowedDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'c-pred-false',
            toolName: 'conditionalGated',
            input: '{"action":"read"}',
          },
          { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
        ],
        [
          { type: 'text-delta', id: 't1', delta: 'Read succeeded.' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(15, 4) },
        ],
      ],
    });
    const allowedResult = await completeText({
      driver: allowedDriver,
      prompt: 'read record',
      tools,
    });
    expect(allowedResult.text).toBe('Read succeeded.');
    expect(executedCount).toBe(1);
    expect(allowedResult.steps[0]?.toolResults[0]?.output).toEqual({ ran: 'read' });

    const allowedStream = streamComplete({
      driver: createScriptedModelDriver({
        steps: [
          [
            {
              type: 'tool-call',
              toolCallId: 'c-pred-false-stream',
              toolName: 'conditionalGated',
              input: '{"action":"read"}',
            },
            { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(10, 5) },
          ],
          [
            { type: 'text-delta', id: 't2', delta: 'Stream read ok.' },
            { type: 'finish', finishReason: 'stop', usage: reportedUsage(15, 4) },
          ],
        ],
      }),
      prompt: 'stream read',
      tools,
    });
    for await (const _part of allowedStream.parts) {
      // drain
    }
    expect((await allowedStream.result).text).toBe('Stream read ok.');
    expect(executedCount).toBe(2);

    // 6. Client-handled tool without execute returns control to caller rather than throwing.
    const handoffRes = await completeText({
      driver: createScriptedModelDriver({
        steps: [
          [
            {
              type: 'tool-call',
              toolCallId: 'c-client',
              toolName: 'clientOnlyGated',
              input: '{"note":"confirm"}',
            },
            { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 3) },
          ],
        ],
      }),
      prompt: 'handoff',
      tools,
    });
    expect(handoffRes.steps).toHaveLength(1);
    expect(handoffRes.steps[0]?.toolCalls[0]?.toolName).toBe('clientOnlyGated');
  });

  test('streamComplete never deadlocks pushWaiters when input.onPart, onInputAvailable, or idleTimeoutMs fails on a full queue', async () => {
    // 1. Two parallel tools on a full 64-item queue: input.onPart throws on tool B while tool A is parked.
    const triggerBStarted = Promise.withResolvers<void>();
    const queueFilledA = Promise.withResolvers<void>();
    const onPartErr = new Error('onPart exploded under backpressure');
    const toolsOnPart = {
      floodA: defineAgentTool({
        description: 'Fills backpressure queue once sibling is running',
        input: z.object({}),
        async *execute() {
          await triggerBStarted.promise;
          for (let i = 0; i < 80; i += 1) {
            if (i === 62) queueFilledA.resolve();
            yield { i };
          }
        },
      }),
      triggerB: defineAgentTool({
        description: 'Waits for queue full then emits a part that fails input.onPart',
        input: z.object({}),
        async *execute() {
          triggerBStarted.resolve();
          await queueFilledA.promise;
          await Bun.sleep(5);
          yield { boom: true };
        },
      }),
    };
    const stream1 = streamComplete({
      driver: createScriptedModelDriver({
        steps: [
          [
            { type: 'tool-call', toolCallId: 'ca', toolName: 'floodA', input: '{}' },
            { type: 'tool-call', toolCallId: 'cb', toolName: 'triggerB', input: '{}' },
            { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 3) },
          ],
        ],
      }),
      prompt: 'parallel onPart fail',
      tools: toolsOnPart,
      onPart: (part) => {
        if (part.type === 'tool-result' && part.toolCallId === 'cb') {
          throw onPartErr;
        }
      },
    });
    // Intentionally do NOT drain stream1.parts before awaiting stream1.result: must settle promptly without deadlock.
    await expect(stream1.result).rejects.toBe(onPartErr);
    await expect(
      (async () => {
        for await (const _part of stream1.parts) {
          // should reject immediately
        }
      })(),
    ).rejects.toBe(onPartErr);

    // 2. Two parallel tools on a full queue: tool B's onInputAvailable throws (input.onPart never throws; only stepAbort fires).
    const inputHookEntered = Promise.withResolvers<void>();
    const queueFilledB = Promise.withResolvers<void>();
    const inputHookErr = new Error('onInputAvailable rejected under backpressure');
    const toolsOnInput = {
      floodA: defineAgentTool({
        description: 'Fills backpressure queue once tool B enters onInputAvailable',
        input: z.object({}),
        async *execute() {
          await inputHookEntered.promise;
          for (let i = 0; i < 80; i += 1) {
            if (i === 62) queueFilledB.resolve();
            yield { i };
          }
        },
      }),
      failingInputB: defineAgentTool({
        description: 'Rejects in onInputAvailable once floodA is parked on pushWaiters',
        input: z.object({}),
        onInputAvailable: async () => {
          inputHookEntered.resolve();
          await queueFilledB.promise;
          await Bun.sleep(5);
          throw inputHookErr;
        },
        execute: async () => ({ never: true }),
      }),
    };
    const stream2 = streamComplete({
      driver: createScriptedModelDriver({
        steps: [
          [
            { type: 'tool-call', toolCallId: 'ca', toolName: 'floodA', input: '{}' },
            { type: 'tool-call', toolCallId: 'cb', toolName: 'failingInputB', input: '{}' },
            { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 3) },
          ],
        ],
      }),
      prompt: 'parallel onInputAvailable fail',
      tools: toolsOnInput,
    });
    await expect(stream2.result).rejects.toBe(inputHookErr);
    await expect(
      (async () => {
        for await (const _part of stream2.parts) {
          // should reject immediately
        }
      })(),
    ).rejects.toBe(inputHookErr);

    // 3. idleTimeoutMs fires while provider stream is parked in pushWaiters on an un-drained full queue.
    const floodTextDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'flood-idle',
      async stream(_req, signal) {
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            for (let i = 0; i < 90; i += 1) {
              if (signal.aborted) return;
              yield { type: 'text-delta', id: 't1', delta: `x${i}` };
            }
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 5) };
          })(),
        };
      },
    };
    const stream3 = streamComplete({
      driver: floodTextDriver,
      prompt: 'flood idle timeout',
      idleTimeoutMs: 25,
    });
    await expect(stream3.result).rejects.toMatchObject({
      name: 'AgentProviderError',
      failureReason: 'timeout',
    });
  });

  test('completeText and streamComplete never wrap or retry caller onPart errors thrown after idleTimeoutMs', async () => {
    // 1. Positive control: slow onPart throws AFTER idleTimeoutMs expires -> original error, ZERO LLM retries.
    let completeDriverCalls = 0;
    const callerErr = new Error('caller UI consumer failed after idle window');
    const makeSlowPartDriver = (onCall: () => void): AgentModelDriver => ({
      provider: 'test',
      modelId: 'idle-vs-onpart',
      async stream() {
        onCall();
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'text-delta', id: 't1', delta: 'hello' };
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(5, 2) };
          })(),
        };
      },
    });

    await expect(
      completeText({
        driver: makeSlowPartDriver(() => {
          completeDriverCalls += 1;
        }),
        prompt: 'slow onPart',
        idleTimeoutMs: 15,
        retry: { maxAttempts: 3, delayMs: () => 5 },
        onPart: async (part) => {
          if (part.type === 'text-delta') {
            await Bun.sleep(40);
            throw callerErr;
          }
        },
      }),
    ).rejects.toBe(callerErr);
    expect(completeDriverCalls).toBe(1);

    let streamDriverCalls = 0;
    const slowStream = streamComplete({
      driver: makeSlowPartDriver(() => {
        streamDriverCalls += 1;
      }),
      prompt: 'slow onPart stream',
      idleTimeoutMs: 15,
      retry: { maxAttempts: 3, delayMs: () => 5 },
      onPart: async (part) => {
        if (part.type === 'text-delta') {
          await Bun.sleep(40);
          throw callerErr;
        }
      },
    });
    await expect(slowStream.result).rejects.toBe(callerErr);
    expect(streamDriverCalls).toBe(1);

    // 2. Negative control: genuine provider idle timeout STILL wraps as timeout and retries normally.
    let timeoutAttempts = 0;
    const flakyIdleDriver: AgentModelDriver = {
      provider: 'test',
      modelId: 'real-idle',
      async stream(_req, signal) {
        timeoutAttempts += 1;
        if (timeoutAttempts === 1) {
          return {
            parts: {
              [Symbol.asyncIterator]() {
                return {
                  next: () =>
                    new Promise<IteratorResult<AgentModelStreamPart>>((_resolve, reject) => {
                      if (signal.aborted) reject(signal.reason);
                      else
                        signal.addEventListener('abort', () => reject(signal.reason), {
                          once: true,
                        });
                    }),
                };
              },
            },
          };
        }
        return {
          parts: (async function* (): AsyncIterable<AgentModelStreamPart> {
            yield { type: 'text-delta', id: 't2', delta: 'recovered' };
            yield { type: 'finish', finishReason: 'stop', usage: reportedUsage(8, 3) };
          })(),
        };
      },
    };
    const recovered = await completeText({
      driver: flakyIdleDriver,
      prompt: 'retry timeout',
      idleTimeoutMs: 15,
      retry: { maxAttempts: 2, delayMs: () => 5 },
    });
    expect(timeoutAttempts).toBe(2);
    expect(recovered.text).toBe('recovered');
  });

  test('streamComplete parses providerExecuted tool-call input and aborts tool finalization and later calls on abort', async () => {
    // 1. providerExecuted: true tool-call carries parsed JSON input in streamComplete and onPart (matching stepResult.toolCalls).
    const providerToolDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'p-json',
            toolName: 'web_search',
            input: '{"query":"stitchkit","limit":3}',
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'p-json',
            toolName: 'web_search',
            result: { hits: 3 },
            providerExecuted: true,
          },
          {
            type: 'tool-call',
            toolCallId: 'p-empty',
            toolName: 'ping_tool',
            input: '   ',
            providerExecuted: true,
          },
          {
            type: 'tool-call',
            toolCallId: 'p-raw',
            toolName: 'broken_json',
            input: 'not-valid-json',
            providerExecuted: true,
          },
          { type: 'text-delta', id: 't1', delta: 'Found 3 hits.' },
          { type: 'finish', finishReason: 'stop', usage: reportedUsage(12, 6) },
        ],
      ],
    });
    const onPartCalls: Array<Extract<CompleteStreamPart, { type: 'tool-call' }>> = [];
    const onPartArgCounts: number[] = [];
    const s = streamComplete({
      driver: providerToolDriver,
      prompt: 'search',
      onPart: (...args) => {
        onPartArgCounts.push(args.length);
        const [part] = args;
        if (part.type === 'tool-call') onPartCalls.push(part);
      },
    });
    const streamCalls: Array<Extract<CompleteStreamPart, { type: 'tool-call' }>> = [];
    for await (const part of s.parts) {
      if (part.type === 'tool-call') streamCalls.push(part);
    }
    const res = await s.result;
    expect(onPartArgCounts.every((count) => count === 1)).toBe(true);
    expect(streamCalls.map((c) => [c.toolCallId, c.providerExecuted, c.input])).toEqual([
      ['p-json', true, { query: 'stitchkit', limit: 3 }],
      ['p-empty', true, {}],
      ['p-raw', true, 'not-valid-json'],
    ]);
    expect(onPartCalls).toEqual(streamCalls);
    expect(res.steps[0]?.toolCalls.map((c) => [c.toolCallId, c.input])).toEqual([
      ['p-json', { query: 'stitchkit', limit: 3 }],
      ['p-empty', {}],
      ['p-raw', 'not-valid-json'],
    ]);

    // 2. Aborting while an uncooperative tool finishes prevents finalize/toModelOutput, terminal onPart, and launching later calls.
    const abortCtrl = new AbortController();
    const abortErr = new Error('stopped mid-tool');
    let toModelCalled = false;
    let secondToolCalled = false;
    const emittedTerminal: string[] = [];
    const abortTools = {
      uncooperative: defineAgentTool({
        description: 'Ignores abortSignal and resolves normally after abort',
        input: z.object({}),
        toModelOutput: ({ output }) => {
          toModelCalled = true;
          return { type: 'text', value: JSON.stringify(output) };
        },
        execute: async () => {
          abortCtrl.abort(abortErr);
          return { late: true };
        },
      }),
      neverLaunched: defineAgentTool({
        description: 'Must not run once step is aborted',
        input: z.object({}),
        execute: async () => {
          secondToolCalled = true;
          return { bad: true };
        },
      }),
    };
    await expect(
      completeText({
        driver: createScriptedModelDriver({
          steps: [
            [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'uncooperative',
                input: '{}',
              },
              {
                type: 'tool-call',
                toolCallId: 'c2',
                toolName: 'neverLaunched',
                input: '{}',
              },
              { type: 'finish', finishReason: 'tool-calls', usage: reportedUsage(5, 3) },
            ],
          ],
        }),
        prompt: 'abort test',
        tools: abortTools,
        signal: abortCtrl.signal,
        onPart: (part) => {
          if (part.type === 'tool-result' || part.type === 'tool-error') {
            emittedTerminal.push(`${part.type}:${part.toolCallId}`);
          }
        },
      }),
    ).rejects.toBe(abortErr);
    expect(toModelCalled).toBe(false);
    expect(secondToolCalled).toBe(false);
    expect(emittedTerminal).toEqual([]);
  });
});
