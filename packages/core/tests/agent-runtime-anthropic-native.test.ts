import { describe, expect, test } from 'bun:test';
import {
  buildAnthropicRequest,
  splitErrorToolResultImages,
} from '../src/agent-runtime/anthropic-messages';
import type {
  AgentModelFinishReason,
  AgentModelRequest,
  AgentModelStreamPart,
} from '../src/agent-runtime/models-driver';
import {
  AgentProviderError,
  AgentProviderStreamCutError,
  classifyProviderFailure,
} from '../src/agent-runtime/provider-failure';
import {
  type AnthropicProviderAccess,
  type AnthropicProviderSettings,
  type AnthropicRequestPolicy,
  AnthropicRequestPolicySchema,
  type AnthropicThinkingPolicy,
  AnthropicThinkingPolicySchema,
  anthropicProvider,
  normalizeAnthropicUsage,
} from '../src/entrypoints/agent-runtime/anthropic';
import { createFaultProviderServer } from '../src/entrypoints/agent-runtime/testing';

/** A fetch stand-in; Bun's `typeof fetch` also carries `preconnect`. */
function mockFetch(
  handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect: (): void => undefined });
}

function makeRequest(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    instructions: [],
    messages: [{ role: 'user', content: 'Hello Claude' }],
    tools: [],
    settings: { maxOutputTokens: 1024 },
    correlation: { conversationId: 'conv-1', attemptId: 'att-1', step: 1 },
    ...overrides,
  };
}

function sseResponse(frames: readonly string[], chunkSize?: number): Response {
  const full = new TextEncoder().encode(frames.join(''));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (chunkSize && chunkSize > 0) {
        for (let offset = 0; offset < full.byteLength; offset += chunkSize) {
          controller.enqueue(full.subarray(offset, offset + chunkSize));
        }
      } else {
        controller.enqueue(full);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function collectParts(
  iterable: AsyncIterable<AgentModelStreamPart>,
): Promise<AgentModelStreamPart[]> {
  const parts: AgentModelStreamPart[] = [];
  for await (const part of iterable) parts.push(part);
  return parts;
}

describe('anthropic-options: policy schemas and upfront validation', () => {
  test('accepts adaptive, enabled (>=1024), and disabled thinking policies', () => {
    const adaptive: AnthropicThinkingPolicy = AnthropicThinkingPolicySchema.parse({
      type: 'adaptive',
    });
    const enabled: AnthropicThinkingPolicy = AnthropicThinkingPolicySchema.parse({
      type: 'enabled',
      budgetTokens: 2048,
    });
    const disabled: AnthropicThinkingPolicy = AnthropicThinkingPolicySchema.parse({
      type: 'disabled',
    });
    expect(adaptive.type).toBe('adaptive');
    expect(enabled).toEqual({ type: 'enabled', budgetTokens: 2048 });
    expect(disabled.type).toBe('disabled');
  });

  test('rejects budgetTokens below 1024 and maxOutputTokens <= budgetTokens (negative controls)', () => {
    expect(() =>
      AnthropicThinkingPolicySchema.parse({ type: 'enabled', budgetTokens: 1023 }),
    ).toThrow();
    expect(() =>
      AnthropicRequestPolicySchema.parse({
        maxOutputTokens: 2048,
        thinking: { type: 'enabled', budgetTokens: 2048 },
      }),
    ).toThrow(/maxOutputTokens/i);
    expect(() =>
      AnthropicRequestPolicySchema.parse({
        maxOutputTokens: 1024,
        thinking: { type: 'enabled', budgetTokens: 2048 },
      }),
    ).toThrow(/maxOutputTokens/i);
    expect(() =>
      AnthropicRequestPolicySchema.parse({
        unknownKey: true,
      } as unknown as AnthropicRequestPolicy),
    ).toThrow();
  });

  test('anthropicProvider validates defaultPolicy and extraBody clashes up front', () => {
    expect(() =>
      anthropicProvider(
        { apiKey: 'test-key' },
        {
          defaultPolicy: {
            maxOutputTokens: 1024,
            thinking: { type: 'enabled', budgetTokens: 1024 },
          },
        },
      ),
    ).toThrow();

    for (const key of [
      'model',
      'thinking',
      'max_tokens',
      'tools',
      'output_config',
      'cache_control',
    ]) {
      expect(() =>
        anthropicProvider({
          apiKey: 'test-key',
          extraBody: { [key]: 'bad' },
        }),
      ).toThrow(TypeError);
    }
  });
});

describe('anthropic-messages: I9 fail-fast validations before network', () => {
  test('never hits fetch when settings or request violate Anthropic invariants', async () => {
    let fetchCalls = 0;
    const neverFetch = mockFetch(async () => {
      fetchCalls += 1;
      return new Response('should not run', { status: 500 });
    });

    const callExpectReject = async (
      request: AgentModelRequest,
      access: AnthropicProviderAccess = {},
    ): Promise<unknown> => {
      const driver = anthropicProvider(
        { apiKey: 'sk-ant-test', fetch: neverFetch },
        access,
      ).create('claude-sonnet-4-5');
      try {
        await driver.stream(request, new AbortController().signal);
        throw new Error('Expected stream() to reject');
      } catch (error) {
        return error;
      }
    };

    // Missing maxOutputTokens (never silently invent 4096)
    const missingMax = await callExpectReject(makeRequest({ settings: {} }));
    expect(missingMax).toBeInstanceOf(TypeError);
    expect((missingMax as Error).message).toContain('maxOutputTokens');

    // maxOutputTokens <= budgetTokens from request + policy combination
    const lowBudget = await callExpectReject(
      makeRequest({ settings: { maxOutputTokens: 2048 } }),
      { defaultPolicy: { thinking: { type: 'enabled', budgetTokens: 2048 } } },
    );
    expect(lowBudget).toBeInstanceOf(TypeError);

    // Unsupported sampling parameters
    for (const settings of [
      { maxOutputTokens: 1024, presencePenalty: 0.5 },
      { maxOutputTokens: 1024, frequencyPenalty: 0.2 },
      { maxOutputTokens: 1024, seed: 42 },
    ]) {
      const err = await callExpectReject(makeRequest({ settings }));
      expect(err).toBeInstanceOf(TypeError);
    }

    // Thinking constraints (both enabled and adaptive)
    for (const thinking of [
      { type: 'enabled', budgetTokens: 1024 } as const,
      { type: 'adaptive' } as const,
    ]) {
      const access: AnthropicProviderAccess = {
        defaultPolicy: { maxOutputTokens: 4096, thinking },
      };
      expect(
        await callExpectReject(makeRequest({ settings: { temperature: 0.5 } }), access),
      ).toBeInstanceOf(TypeError);
      expect(
        await callExpectReject(makeRequest({ settings: { topK: 20 } }), access),
      ).toBeInstanceOf(TypeError);
      expect(
        await callExpectReject(
          makeRequest({
            settings: {},
            tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
            toolChoice: 'required',
          }),
          access,
        ),
      ).toBeInstanceOf(TypeError);
      expect(
        await callExpectReject(
          makeRequest({
            settings: {},
            tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
            toolChoice: { type: 'tool', toolName: 'ping' },
          }),
          access,
        ),
      ).toBeInstanceOf(TypeError);
    }

    // Schemaless json-object
    expect(
      await callExpectReject(makeRequest({ responseFormat: { type: 'json-object' } })),
    ).toBeInstanceOf(TypeError);

    // Audio & video inputs
    expect(
      await callExpectReject(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'audio/mpeg',
                  data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
                },
              ],
            },
          ],
        }),
      ),
    ).toBeInstanceOf(TypeError);
    expect(
      await callExpectReject(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'video/mp4',
                  data: { type: 'url', url: new URL('https://example.com/clip.mp4') },
                },
              ],
            },
          ],
        }),
      ),
    ).toBeInstanceOf(TypeError);

    // Unsupported image subtype and foreign file reference
    expect(
      await callExpectReject(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'image/bmp',
                  data: { type: 'data', data: new Uint8Array([1, 2]) },
                },
              ],
            },
          ],
        }),
      ),
    ).toBeInstanceOf(TypeError);
    expect(
      await callExpectReject(
        makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'application/pdf',
                  data: { type: 'reference', reference: { openai: 'file_abc' } },
                },
              ],
            },
          ],
        }),
      ),
    ).toBeInstanceOf(TypeError);

    expect(fetchCalls).toBe(0);
  });
});

describe('anthropic-messages: encoding, turns, thinking, media, tools, and cache control', () => {
  test('encodes system, merged user/tool turns, bijective cross-provider IDs, and deterministic JSON', () => {
    const foreignId =
      'fc_01|with.dots:and:colons:123456789012345678901234567890123456789012345';
    const validId = 'toolu_01Valid-Id_99';
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 2048 },
      request: makeRequest({
        settings: {},
        instructions: [
          { role: 'system', content: 'Primary instructions' },
          { role: 'system', content: '' },
        ],
        messages: [
          { role: 'system', content: 'Inline system note' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: 'Run tools' },
            ],
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: '' },
              { type: 'text', text: 'Checking both' },
            ],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: foreignId,
                toolName: 'lookup',
                input: { q: 'a' },
              },
              {
                type: 'tool-call',
                toolCallId: validId,
                toolName: 'check',
                input: { ok: true },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: foreignId,
                toolName: 'lookup',
                output: { type: 'json', value: { z: 1, a: 2 } },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: validId,
                toolName: 'check',
                output: { type: 'execution-denied', reason: 'Denied by policy' },
              },
            ],
          },
          { role: 'user', content: 'Now summarize' },
        ],
      }),
    });

    expect(built.body.system).toEqual([
      { type: 'text', text: 'Primary instructions' },
      { type: 'text', text: 'Inline system note' },
    ]);
    // Empty request.tools WITH tool traffic emits `tools: []`
    expect(built.body.tools).toEqual([]);

    const messages = built.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);

    // Adjacent assistant turns merged (text before tool_use, empty text dropped)
    const assistantBlocks = messages[1]?.content ?? [];
    expect(assistantBlocks.map((b) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(assistantBlocks[0]).toEqual({ type: 'text', text: 'Checking both' });
    const mappedForeignId = String(assistantBlocks[1]?.id ?? '');
    expect(mappedForeignId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(mappedForeignId).not.toBe(foreignId);
    expect(assistantBlocks[2]?.id).toBe(validId);

    // Adjacent tool + tool + user merged into one user turn with tool_results strictly FIRST
    const mergedUser = messages[2]?.content ?? [];
    expect(mergedUser.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(mergedUser[0]).toEqual({
      type: 'tool_result',
      tool_use_id: mappedForeignId,
      content: '{"a":2,"z":1}',
    });
    expect(mergedUser[1]).toEqual({
      type: 'tool_result',
      tool_use_id: validId,
      content: 'Denied by policy',
      is_error: true,
    });
    expect(mergedUser[2]).toEqual({ type: 'text', text: 'Now summarize' });
  });

  test('splitErrorToolResultImages moves images out of is_error tool_result after all tool_results', () => {
    const imgBlock = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AQID' },
    };
    const direct = splitErrorToolResultImages([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_err',
        is_error: true,
        content: [{ type: 'text', text: 'Screenshot failed' }, imgBlock],
      },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_ok',
        content: [imgBlock],
      },
      { type: 'text', text: 'User follow-up' },
    ]);

    expect(direct.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text', 'image']);
    expect(direct[0]?.content).toEqual([{ type: 'text', text: 'Screenshot failed' }]);
    // Non-error tool_result keeps its embedded image untouched (negative control)
    expect(direct[1]?.content).toEqual([imgBlock]);
    expect(direct[3]).toEqual(imgBlock);

    // End-to-end via buildAnthropicRequest with error-flagged content tool output
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 1024 },
      request: makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'snap', input: {} },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'toolu_1',
                toolName: 'snap',
                providerOptions: { anthropic: { isError: true } },
                output: {
                  type: 'content',
                  value: [
                    {
                      type: 'file',
                      mediaType: 'image/png',
                      data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
    const userTurn =
      (built.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]
        ?.content ?? [];
    expect(userTurn.map((b) => b.type)).toEqual(['tool_result', 'image']);
    expect(userTurn[0]?.is_error).toBe(true);
    expect(typeof userTurn[0]?.content).toBe('string');
  });

  test('preserves verbatim multi-block thinking + redacted_thinking, skips foreign/unsigned, never caches thinking', () => {
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: {
        maxOutputTokens: 4096,
        thinking: { type: 'enabled', budgetTokens: 2048 },
      },
      request: makeRequest({
        settings: { temperature: 1 },
        messages: [
          { role: 'user', content: 'Solve carefully' },
          {
            role: 'assistant',
            cacheControl: { type: 'ephemeral' },
            content: [
              {
                type: 'reasoning',
                text: 'Line 1\n  indented verbatim',
                cacheControl: { type: 'ephemeral' },
                providerOptions: { anthropic: { type: 'thinking', signature: 'sig_alpha' } },
              },
              {
                type: 'reasoning',
                text: '',
                cacheControl: { type: 'ephemeral' },
                providerOptions: {
                  anthropic: { type: 'redacted_thinking', data: 'Cm0K_opaque' },
                },
              },
              {
                type: 'reasoning',
                text: 'OpenAI thought should drop',
                providerOptions: { openai: { encrypted_content: 'enc_1' } },
              },
              {
                type: 'reasoning',
                text: 'Unsigned thought should drop',
              },
              { type: 'text', text: 'Final answer' },
            ],
          },
          { role: 'user', content: 'Thanks' },
        ],
      }),
    });

    const assistantBlocks =
      (
        built.body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
      )[1]?.content ?? [];
    expect(assistantBlocks).toEqual([
      { type: 'thinking', thinking: 'Line 1\n  indented verbatim', signature: 'sig_alpha' },
      { type: 'redacted_thinking', data: 'Cm0K_opaque' },
      { type: 'text', text: 'Final answer', cache_control: { type: 'ephemeral' } },
    ]);
    expect(built.autoBetas).toContain('interleaved-thinking-2025-05-14');
    expect(built.body.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  test('encodes multimodal images (strips data: prefix), PDFs, and text/plain documents', () => {
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 1024 },
      request: makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: 'data:image/png;base64,AQID' },
              },
              {
                type: 'file',
                mediaType: 'image/webp',
                data: { type: 'url', url: new URL('https://example.com/pic.webp') },
              },
              {
                type: 'file',
                mediaType: 'application/pdf',
                filename: 'spec.pdf',
                data: { type: 'data', data: new Uint8Array([37, 80, 68, 70]) },
              },
              {
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'url', url: new URL('https://example.com/doc.pdf') },
              },
              {
                type: 'file',
                mediaType: 'text/plain',
                data: { type: 'text', text: 'Plain notes' },
              },
              {
                type: 'file',
                mediaType: 'text/plain',
                data: { type: 'data', data: new TextEncoder().encode('UTF-8 bytes') },
              },
            ],
          },
        ],
      }),
    });

    const blocks =
      (built.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0]
        ?.content ?? [];
    expect(blocks).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } },
      { type: 'image', source: { type: 'url', url: 'https://example.com/pic.webp' } },
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERg==' },
        title: 'spec.pdf',
      },
      { type: 'document', source: { type: 'url', url: 'https://example.com/doc.pdf' } },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'Plain notes' },
      },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: 'UTF-8 bytes' },
      },
    ]);
  });

  test('encodes tools, eagerInputStreaming, tool_choice, output_config (effort + json_schema), and cache budgeting + TTL order', () => {
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: {
        maxOutputTokens: 2048,
        effort: 'high',
        eagerInputStreaming: true,
        disableParallelToolUse: true,
        serviceTier: 'standard_only',
      },
      request: makeRequest({
        instructions: [
          { role: 'system', content: 'Sys 1', cacheControl: { type: 'ephemeral', ttl: '1h' } },
        ],
        tools: [
          {
            name: 'search',
            description: 'Find docs',
            inputSchema: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
            },
            cacheControl: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        toolChoice: { type: 'tool', toolName: 'search' },
        responseFormat: {
          type: 'json-schema',
          name: 'Answer',
          schema: {
            type: 'object',
            properties: {
              slug: { type: 'string', minLength: 3, pattern: '^[a-z]+$' },
            },
            required: ['slug'],
          },
        },
        messages: [
          { role: 'user', content: 'm1', cacheControl: { type: 'ephemeral', ttl: '5m' } },
          { role: 'assistant', content: 'a1', cacheControl: { type: 'ephemeral', ttl: '5m' } },
          { role: 'user', content: 'm2', cacheControl: { type: 'ephemeral', ttl: '5m' } },
        ],
      }),
    });

    expect(built.autoBetas).toContain('fine-grained-tool-streaming-2025-05-14');
    expect(built.body.service_tier).toBe('standard_only');
    expect(built.body.tool_choice).toEqual({
      type: 'tool',
      name: 'search',
      disable_parallel_tool_use: true,
    });
    expect(built.body.tools).toEqual([
      {
        name: 'search',
        description: 'Find docs',
        input_schema: {
          type: 'object',
          properties: { q: { type: 'string' } },
          required: ['q'],
        },
        eager_input_streaming: true,
        cache_control: { type: 'ephemeral', ttl: '1h' },
      },
    ]);
    expect(built.body.output_config).toEqual({
      effort: 'high',
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            slug: {
              type: 'string',
              description: 'Constraints: minLength=3, pattern="^[a-z]+$"',
            },
          },
          required: ['slug'],
        },
      },
    });

    // 5 planned explicit breakpoints (1 tool + 1 system + 3 messages) budgeted to 4:
    // tool + system + latest 2 messages (m1 dropped, a1 + m2 kept)
    const msgs = built.body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0]?.content[0]?.cache_control).toBeUndefined();
    expect(msgs[1]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    expect(msgs[2]?.content[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });

    // Negative control: 5m before 1h fails fast with TypeError
    expect(() =>
      buildAnthropicRequest({
        modelId: 'claude-sonnet-4-5',
        policy: { maxOutputTokens: 1024 },
        request: makeRequest({
          instructions: [
            {
              role: 'system',
              content: 'Short TTL',
              cacheControl: { type: 'ephemeral', ttl: '5m' },
            },
          ],
          messages: [
            {
              role: 'user',
              content: 'Long TTL',
              cacheControl: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        }),
      }),
    ).toThrow(/1h/);
  });

  test('places tool-turn cache_control ONLY on the last tool_result and omits disable_parallel_tool_use on none', () => {
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: {
        maxOutputTokens: 1024,
        disableParallelToolUse: true,
        cacheControl: { type: 'ephemeral', ttl: '5m' },
      },
      request: makeRequest({
        tools: [{ name: 't', inputSchema: { type: 'object', properties: {} } }],
        toolChoice: 'none',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'toolu_1', toolName: 't', input: {} },
              { type: 'tool-call', toolCallId: 'toolu_2', toolName: 't', input: {} },
            ],
          },
          {
            role: 'tool',
            cacheControl: { type: 'ephemeral', ttl: '1h' },
            content: [
              {
                type: 'tool-result',
                toolCallId: 'toolu_1',
                toolName: 't',
                cacheControl: { type: 'ephemeral', ttl: '1h' },
                output: { type: 'text', value: 'first' },
              },
              {
                type: 'tool-result',
                toolCallId: 'toolu_2',
                toolName: 't',
                output: { type: 'text', value: 'second' },
              },
            ],
          },
        ],
      }),
    });

    expect(built.body.tool_choice).toEqual({ type: 'none' });
    expect(built.body.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
    const toolTurn =
      (built.body.messages as Array<{ content: Array<Record<string, unknown>> }>)[1]
        ?.content ?? [];
    expect(toolTurn[0]?.cache_control).toBeUndefined();
    expect(toolTurn[1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
  });

  test('repairs orphan tool-calls with synthetic error tool_result placed before following user text', () => {
    const built = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 1024 },
      request: makeRequest({
        messages: [
          { role: 'user', content: 'Start' },
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'toolu_orphan', toolName: 'run', input: {} },
            ],
          },
          { role: 'user', content: 'Never mind, continue' },
        ],
      }),
    });

    const messages = built.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const turn2 = messages[2]?.content ?? [];
    expect(turn2.map((b) => b.type)).toEqual(['tool_result', 'text']);
    expect(turn2[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_orphan',
      is_error: true,
    });
    expect(turn2[1]).toEqual({ type: 'text', text: 'Never mind, continue' });
  });
});

describe('anthropic-response: usage normalization, error classification, and JSON fallback', () => {
  test('computes total inputTokens with computed provenance when cache counters are positive', () => {
    const cached = normalizeAnthropicUsage({
      input_tokens: 100,
      cache_read_input_tokens: 500,
      cache_creation_input_tokens: 200,
      output_tokens: 75,
      output_tokens_details: { thinking_tokens: 30 },
    });
    expect(cached).toEqual({
      inputTokens: { value: 800, provenance: 'computed' },
      outputTokens: { value: 75, provenance: 'provider-reported' },
      reasoningTokens: { value: 30, provenance: 'provider-reported' },
      cacheReadTokens: { value: 500, provenance: 'provider-reported' },
      cacheWriteTokens: { value: 200, provenance: 'provider-reported' },
      cost: { provenance: 'unavailable' },
    });

    // Uncached keeps provider-reported provenance
    const plain = normalizeAnthropicUsage({ input_tokens: 120, output_tokens: 40 });
    expect(plain.inputTokens).toEqual({ value: 120, provenance: 'provider-reported' });
    expect(plain.cacheReadTokens).toEqual({ provenance: 'unavailable' });
    expect(plain.cacheWriteTokens).toEqual({ provenance: 'unavailable' });
    expect(plain.reasoningTokens).toEqual({ provenance: 'unavailable' });

    // Nested cache_creation breakdown fallback when cache_creation_input_tokens is absent
    const nested = normalizeAnthropicUsage({
      input_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 150, ephemeral_5m_input_tokens: 50 },
      output_tokens: 10,
    });
    expect(nested.cacheWriteTokens).toEqual({ value: 200, provenance: 'computed' });
    expect(nested.inputTokens).toEqual({ value: 250, provenance: 'computed' });

    // Absent usage remains unavailable (never synthetic 0)
    const absent = normalizeAnthropicUsage(undefined);
    expect(absent.inputTokens).toEqual({ provenance: 'unavailable' });
    expect(absent.outputTokens).toEqual({ provenance: 'unavailable' });
  });

  test('classifies Anthropic HTTP errors and redacts leaked API keys', async () => {
    const makeErrorDriver = (
      status: number,
      body: unknown,
      headers: Record<string, string> = {},
    ) =>
      anthropicProvider({
        apiKey: 'sk-ant-secret1234567890',
        fetch: mockFetch(
          async () =>
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json', ...headers },
            }),
        ),
      }).create('claude-sonnet-4-5');

    const overloaded = await makeErrorDriver(529, {
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded sk-ant-secret1234567890' },
    })
      .stream(makeRequest(), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(overloaded).toBeInstanceOf(AgentProviderError);
    expect((overloaded as AgentProviderError).message).not.toContain(
      'sk-ant-secret1234567890',
    );
    expect(classifyProviderFailure(overloaded)).toMatchObject({
      reason: 'overloaded',
      status: 529,
      retryable: true,
      evidence: 'code',
    });

    const rateLimited = await makeErrorDriver(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
      { 'retry-after': '4' },
    )
      .stream(makeRequest(), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(classifyProviderFailure(rateLimited)).toMatchObject({
      reason: 'rate-limited',
      status: 429,
      retryAfterMs: 4000,
      retryable: true,
      evidence: 'code',
    });

    const serverErr = await makeErrorDriver(500, {
      type: 'error',
      error: { type: 'api_error', message: 'Internal failure' },
    })
      .stream(makeRequest(), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(classifyProviderFailure(serverErr)).toMatchObject({
      reason: 'server-error',
      status: 500,
      retryable: true,
      evidence: 'code',
    });

    const noCredits = await makeErrorDriver(400, {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'Your credit balance is too low to access the Anthropic API.',
      },
    })
      .stream(makeRequest(), new AbortController().signal)
      .catch((e: unknown) => e);
    expect(classifyProviderFailure(noCredits)).toMatchObject({
      reason: 'insufficient-credits',
      status: 400,
      retryable: false,
      evidence: 'code',
    });
  });

  test('handles non-streaming 200 JSON response fallback and 200 JSON error envelope', async () => {
    const okDriver = anthropicProvider({
      apiKey: 'test-key',
      fetch: mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              id: 'msg_json_1',
              type: 'message',
              role: 'assistant',
              model: 'claude-sonnet-4-5-20250929',
              content: [
                { type: 'thinking', thinking: 'Let me check', signature: 'sig_j1' },
                { type: 'redacted_thinking', data: 'red_data_1' },
                { type: 'text', text: 'Done!' },
                { type: 'tool_use', id: 'toolu_j1', name: 'ping', input: { ok: true } },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 10, cache_read_input_tokens: 40, output_tokens: 20 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    }).create('claude-sonnet-4-5');

    const stream = await okDriver.stream(makeRequest(), new AbortController().signal);
    const parts = await collectParts(stream.parts);
    expect(parts.some((p) => p.type === 'response-metadata' && p.id === 'msg_json_1')).toBe(
      true,
    );
    expect(
      parts.some(
        (p) =>
          p.type === 'reasoning-end' &&
          p.provider?.data.type === 'thinking' &&
          p.provider.data.signature === 'sig_j1',
      ),
    ).toBe(true);
    expect(
      parts.some(
        (p) =>
          p.type === 'reasoning-end' &&
          p.provider?.data.type === 'redacted_thinking' &&
          p.provider.data.data === 'red_data_1',
      ),
    ).toBe(true);
    expect(
      parts.some(
        (p) =>
          p.type === 'tool-call' &&
          p.toolCallId === 'toolu_j1' &&
          p.toolName === 'ping' &&
          p.input === '{"ok":true}',
      ),
    ).toBe(true);
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.type === 'finish' && finish.finishReason).toBe('tool-calls');
    expect(finish?.type === 'finish' && finish.usage.inputTokens).toEqual({
      value: 50,
      provenance: 'computed',
    });

    const errDriver = anthropicProvider({
      apiKey: 'test-key',
      fetch: mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              type: 'error',
              error: { type: 'overloaded_error', message: 'Busy right now' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    }).create('claude-sonnet-4-5');
    const errStream = await errDriver.stream(makeRequest(), new AbortController().signal);
    await expect(collectParts(errStream.parts)).rejects.toBeInstanceOf(AgentProviderError);
  });
});

describe('anthropic-sse & anthropicProvider: streaming state machine, headers, and fault injection', () => {
  test('streams multi-block thinking, redacted_thinking, text, streamed + zero-arg tools, ping, and merged usage', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const settings: AnthropicProviderSettings = {
      apiKey: 'sk-ant-live-key',
      baseUrl: 'https://proxy.example.com/v1/',
      apiVersion: '2023-06-01',
      betas: ['custom-beta-1'],
      headers: { 'Anthropic-Beta': 'header-beta-0', 'x-trace': 'trace-1' },
      extraBody: { metadata: { user_id: 'usr_9' } },
      fetch: mockFetch(async (input, init) => {
        capturedUrl = String(input);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(
          [
            ': keepalive comment\n\n',
            sseFrame('ping', { type: 'ping' }),
            sseFrame('message_start', {
              type: 'message_start',
              message: {
                id: 'msg_sse_1',
                type: 'message',
                role: 'assistant',
                model: 'claude-sonnet-4-5-20250929',
                content: [],
                usage: {
                  input_tokens: 100,
                  cache_creation_input_tokens: 50,
                  cache_read_input_tokens: 300,
                  output_tokens: 1,
                },
              },
            }),
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'Step 1 ' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: 'Step 2' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig_part_1_' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'signature_delta', signature: 'sig_part_2' },
            }),
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'redacted_thinking', data: 'opaque_blob_xyz' },
            }),
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: 2,
              content_block: { type: 'text', text: '' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 2,
              delta: { type: 'text_delta', text: 'Calling tools now' },
            }),
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 2 }),
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: 3,
              content_block: { type: 'tool_use', id: 'toolu_args', name: 'search', input: {} },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 3,
              delta: { type: 'input_json_delta', partial_json: '{"q":' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 3,
              delta: { type: 'input_json_delta', partial_json: '"hello"}' },
            }),
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 3 }),
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: 4,
              content_block: { type: 'tool_use', id: 'toolu_empty', name: 'now', input: {} },
            }),
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 4 }),
            sseFrame('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use' },
              usage: { input_tokens: null, output_tokens: 88 },
            }),
            sseFrame('message_stop', { type: 'message_stop' }),
          ],
          17, // Split frames across odd byte boundaries
        );
      }),
    };

    const driver = anthropicProvider(settings, {
      resolvePolicy: () => ({
        maxOutputTokens: 4096,
        thinking: { type: 'enabled', budgetTokens: 1024 },
        eagerInputStreaming: true,
        betas: ['policy-beta-2', 'custom-beta-1'],
      }),
    }).create('claude-sonnet-4-5');

    const stream = await driver.stream(
      makeRequest({
        settings: {},
        tools: [{ name: 'search', inputSchema: { type: 'object', properties: {} } }],
      }),
      new AbortController().signal,
    );
    const parts = await collectParts(stream.parts);

    expect(capturedUrl).toBe('https://proxy.example.com/v1/messages');
    expect(capturedHeaders?.get('x-api-key')).toBe('sk-ant-live-key');
    expect(capturedHeaders?.get('anthropic-version')).toBe('2023-06-01');
    expect(capturedHeaders?.get('x-trace')).toBe('trace-1');
    expect(capturedHeaders?.get('anthropic-beta')).toBe(
      'header-beta-0,custom-beta-1,policy-beta-2,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    );
    expect(capturedBody?.metadata).toEqual({ user_id: 'usr_9' });

    expect(parts.filter((p) => p.type === 'ping')).toHaveLength(2);
    expect(parts.find((p) => p.type === 'response-metadata')).toEqual({
      type: 'response-metadata',
      id: 'msg_sse_1',
      modelId: 'claude-sonnet-4-5-20250929',
    });

    // Thinking signature concatenated across signature_delta chunks
    const thinkingEnd = parts.find(
      (p) => p.type === 'reasoning-end' && p.id === 'reasoning-0',
    );
    expect(thinkingEnd).toEqual({
      type: 'reasoning-end',
      id: 'reasoning-0',
      provider: {
        schemaVersion: 1,
        provider: 'anthropic',
        data: { type: 'thinking', signature: 'sig_part_1_sig_part_2' },
      },
    });

    // Redacted thinking emitted exactly once (not duplicated on content_block_stop)
    const redactedEnds = parts.filter(
      (p) => p.type === 'reasoning-end' && p.id === 'reasoning-1',
    );
    expect(redactedEnds).toEqual([
      {
        type: 'reasoning-end',
        id: 'reasoning-1',
        provider: {
          schemaVersion: 1,
          provider: 'anthropic',
          data: { type: 'redacted_thinking', data: 'opaque_blob_xyz' },
        },
      },
    ]);

    // Streamed tool_use did NOT prepend "{}" and zero-arg tool_use defaulted to "{}"
    const toolCalls = parts.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'toolu_args',
        toolName: 'search',
        input: '{"q":"hello"}',
      },
      { type: 'tool-call', toolCallId: 'toolu_empty', toolName: 'now', input: '{}' },
    ]);

    // message_delta null input_tokens did NOT overwrite message_start input/cache counts
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish).toEqual({
      type: 'finish',
      finishReason: 'tool-calls',
      rawFinishReason: 'tool_use',
      usage: {
        inputTokens: { value: 450, provenance: 'computed' },
        outputTokens: { value: 88, provenance: 'provider-reported' },
        reasoningTokens: { provenance: 'unavailable' },
        cacheReadTokens: { value: 300, provenance: 'provider-reported' },
        cacheWriteTokens: { value: 50, provenance: 'provider-reported' },
        cost: { provenance: 'unavailable' },
      },
      response: { id: 'msg_sse_1', modelId: 'claude-sonnet-4-5-20250929' },
    });
  });

  test('maps every Anthropic stop_reason accurately', async () => {
    const cases: readonly [string, AgentModelFinishReason][] = [
      ['end_turn', 'stop'],
      ['stop_sequence', 'stop'],
      ['max_tokens', 'length'],
      ['model_context_window_exceeded', 'length'],
      ['tool_use', 'tool-calls'],
      ['refusal', 'content-filter'],
      ['pause_turn', 'other'],
    ];

    for (const [rawReason, expected] of cases) {
      const driver = anthropicProvider({
        apiKey: 'test-key',
        fetch: mockFetch(async () =>
          sseResponse([
            sseFrame('message_start', {
              type: 'message_start',
              message: { id: 'm', model: 'c', usage: { input_tokens: 1, output_tokens: 0 } },
            }),
            sseFrame('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: rawReason },
              usage: { output_tokens: 1 },
            }),
            sseFrame('message_stop', { type: 'message_stop' }),
          ]),
        ),
      }).create('claude-sonnet-4-5');
      const stream = await driver.stream(makeRequest(), new AbortController().signal);
      const parts = await collectParts(stream.parts);
      const finish = parts.find((p) => p.type === 'finish');
      expect(finish?.type === 'finish' && finish.finishReason).toBe(expected);
      expect(finish?.type === 'finish' && finish.rawFinishReason).toBe(rawReason);
    }
  });

  test('mid-stream error event emits error part and never emits truncated tool calls', async () => {
    const driver = anthropicProvider({
      apiKey: 'test-key',
      fetch: mockFetch(async () =>
        sseResponse([
          sseFrame('message_start', {
            type: 'message_start',
            message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 5 } },
          }),
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_cut', name: 'edit', input: {} },
          }),
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"path":"/tmp' },
          }),
          sseFrame('error', {
            type: 'error',
            error: { type: 'overloaded_error', message: 'Overloaded mid-stream' },
          }),
        ]),
      ),
    }).create('claude-sonnet-4-5');

    const stream = await driver.stream(makeRequest(), new AbortController().signal);
    const parts = await collectParts(stream.parts);
    expect(parts.some((p) => p.type === 'tool-call')).toBe(false);
    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart?.type === 'error' && errPart.error).toBeInstanceOf(AgentProviderError);
    expect(
      classifyProviderFailure(errPart?.type === 'error' ? errPart.error : undefined),
    ).toMatchObject({
      reason: 'overloaded',
      retryable: true,
      evidence: 'code',
    });
  });

  test('stream EOF without message_stop throws AgentProviderStreamCutError without emitting truncated tool calls', async () => {
    const driver = anthropicProvider({
      apiKey: 'test-key',
      fetch: mockFetch(async () =>
        sseResponse([
          sseFrame('message_start', {
            type: 'message_start',
            message: { id: 'm1', model: 'claude-sonnet-4-5', usage: { input_tokens: 5 } },
          }),
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: 'toolu_eof', name: 'edit', input: {} },
          }),
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: '{"truncated":true' },
          }),
        ]),
      ),
    }).create('claude-sonnet-4-5');

    const stream = await driver.stream(makeRequest(), new AbortController().signal);
    const seen: AgentModelStreamPart[] = [];
    let caught: unknown;
    try {
      for await (const part of stream.parts) seen.push(part);
    } catch (error) {
      caught = error;
    }
    expect(seen.some((p) => p.type === 'tool-call')).toBe(false);
    expect(caught).toBeInstanceOf(AgentProviderStreamCutError);
    expect(classifyProviderFailure(caught)).toEqual({
      reason: 'stream-cut',
      retryable: true,
      evidence: 'code',
    });
  });

  test('integrates with createFaultProviderServer across HTTP errors, stream-cut, bad-json, and abort', async () => {
    const server = await createFaultProviderServer({
      scenario: [
        { kind: 'http-error', status: 529 },
        { kind: 'stream-cut', afterBytes: 12 },
        { kind: 'bad-json' },
        { kind: 'timeout-before-first-byte', milliseconds: 5_000 },
      ],
    });
    try {
      const baseUrl = new URL('/v1', server.url).toString();
      const driver = anthropicProvider({ apiKey: 'test-key', baseUrl }).create(
        'claude-sonnet-4-5',
      );

      // 1. HTTP 529
      const err529 = await driver
        .stream(makeRequest(), new AbortController().signal)
        .catch((e: unknown) => e);
      expect(err529).toBeInstanceOf(AgentProviderError);
      expect(classifyProviderFailure(err529)).toMatchObject({
        reason: 'overloaded',
        status: 529,
        retryable: true,
      });

      // 2. stream-cut mid-SSE frame
      const cutStream = await driver.stream(makeRequest(), new AbortController().signal);
      await expect(collectParts(cutStream.parts)).rejects.toBeInstanceOf(
        AgentProviderStreamCutError,
      );

      // 3. malformed SSE JSON
      const badJsonStream = await driver.stream(makeRequest(), new AbortController().signal);
      await expect(collectParts(badJsonStream.parts)).rejects.toBeInstanceOf(
        AgentProviderStreamCutError,
      );

      // 4. abort while waiting for first byte from server
      const timeoutErr = await driver
        .stream(makeRequest(), AbortSignal.timeout(40))
        .catch((e: unknown) => e);
      expect(timeoutErr).toBeInstanceOf(Error);
      expect(server.calls()).toBe(4);
    } finally {
      await server.close();
    }
  });

  test('protocol regressions: interleaved-thinking order, providerOptions.anthropic + betas, error:null 200 OK, surrogates/title/custom, SSE block.input/message_stop flush, and topP validation', async () => {
    // 1. Interleaved thinking preserves exact [thinking_1, tool_use_1, thinking_2, tool_use_2] order
    const interleaved = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 4096, thinking: { type: 'enabled', budgetTokens: 1024 } },
      request: makeRequest({
        settings: {},
        messages: [
          { role: 'user', content: 'Run two steps' },
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'First thought',
                providerOptions: { anthropic: { type: 'thinking', signature: 'sig_1' } },
              },
              {
                type: 'tool-call',
                toolCallId: 'toolu_1',
                toolName: 'step_a',
                input: { bad: 'hi\ud800there' },
              },
              {
                type: 'reasoning',
                text: 'Second thought',
                providerOptions: { anthropic: { type: 'thinking', signature: 'sig_2' } },
              },
              {
                type: 'tool-call',
                toolCallId: 'toolu_2',
                toolName: 'step_b',
                input: { ok: true },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'toolu_1',
                toolName: 'step_a',
                output: { type: 'json', value: { note: 'bad\udc00surrogate' } },
              },
              {
                type: 'tool-result',
                toolCallId: 'toolu_2',
                toolName: 'step_b',
                output: {
                  type: 'content',
                  value: [
                    {
                      type: 'file',
                      data: { type: 'text', text: 'plain' },
                      mediaType: 'text/plain',
                      filename: '',
                    },
                    {
                      type: 'file',
                      data: { type: 'text', text: 'doc' },
                      mediaType: 'text/plain',
                      filename: 'bad\ud800name.txt',
                    },
                    { type: 'custom', providerOptions: { demo: { k: 'v' } } },
                  ],
                },
              },
            ],
          },
        ],
      }),
    });
    const wireMsgs = interleaved.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(wireMsgs[1]?.content.map((b) => b.type)).toEqual([
      'thinking',
      'tool_use',
      'thinking',
      'tool_use',
    ]);
    // Unpaired surrogates sanitized inside tool_use.input and tool_result json
    expect(wireMsgs[1]?.content[1]?.input).toEqual({ bad: 'hi\ufffdthere' });
    expect(wireMsgs[2]?.content[0]?.content).toBe('{"note":"bad\ufffdsurrogate"}');
    // Empty filename omits title; lone surrogate filename is sanitized; custom part serialized
    const secondResultBlocks = wireMsgs[2]?.content[1]?.content as Array<
      Record<string, unknown>
    >;
    expect('title' in (secondResultBlocks[0] ?? {})).toBe(false);
    expect(secondResultBlocks[1]?.title).toBe('bad\ufffdname.txt');
    expect(secondResultBlocks[2]).toEqual({
      type: 'text',
      text: '{"providerOptions":{"demo":{"k":"v"}},"type":"custom"}',
    });

    // 2. request.providerOptions.anthropic overrides policy and forwards merged betas header
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const provider = anthropicProvider(
      {
        apiKey: 'test-key',
        betas: ['base-beta-1'],
        fetch: mockFetch(async (_url, init) => {
          capturedHeaders = new Headers(init?.headers);
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({
            id: 'msg_ok_null_err',
            type: 'message',
            role: 'assistant',
            model: 'claude-sonnet-4-5',
            error: null,
            content: [{ type: 'text', text: 'ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 5, output_tokens: 2 },
          });
        }),
      },
      { defaultPolicy: { maxOutputTokens: 2048, betas: ['policy-beta-2'] } },
    );
    const stepParts = await collectParts(
      (
        await provider.create('claude-sonnet-4-5').stream(
          makeRequest({
            settings: {},
            providerOptions: {
              anthropic: {
                maxOutputTokens: 4096,
                thinking: { type: 'enabled', budgetTokens: 1024 },
                effort: 'high',
                serviceTier: 'standard_only',
                disableParallelToolUse: true,
                eagerInputStreaming: true,
                cacheControl: { type: 'ephemeral' },
                betas: ['step-beta-3'],
              },
            },
            tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
          }),
          new AbortController().signal,
        )
      ).parts,
    );
    // 200 OK JSON response with `error: null` succeeded cleanly!
    expect(stepParts.find((p) => p.type === 'text-delta')).toMatchObject({ delta: 'ok' });
    expect(capturedBody?.max_tokens).toBe(4096);
    expect(capturedBody?.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 });
    expect(capturedBody?.output_config).toEqual({ effort: 'high' });
    expect(capturedBody?.service_tier).toBe('standard_only');
    expect(capturedBody?.tool_choice).toEqual({
      type: 'auto',
      disable_parallel_tool_use: true,
    });
    expect(capturedBody?.cache_control).toEqual({ type: 'ephemeral' });
    expect(capturedHeaders?.get('anthropic-beta')).toBe(
      'base-beta-1,policy-beta-2,step-beta-3,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14',
    );

    // Negative control: unknown key in providerOptions.anthropic rejected
    await expect(
      provider.create('claude-sonnet-4-5').stream(
        makeRequest({
          settings: {},
          providerOptions: { anthropic: { bogusKey: true } },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();

    // 3. topP validation (temperature + topP forbidden; topP < 0.95 with thinking forbidden; topP 0.95 allowed)
    expect(() =>
      buildAnthropicRequest({
        modelId: 'claude-sonnet-4-5',
        policy: { maxOutputTokens: 1024 },
        request: makeRequest({ settings: { temperature: 0.5, topP: 0.9 } }),
      }),
    ).toThrow(TypeError);
    expect(() =>
      buildAnthropicRequest({
        modelId: 'claude-sonnet-4-5',
        policy: { maxOutputTokens: 4096, thinking: { type: 'enabled', budgetTokens: 1024 } },
        request: makeRequest({ settings: { topP: 0.9 } }),
      }),
    ).toThrow(TypeError);
    const validTopP = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 4096, thinking: { type: 'enabled', budgetTokens: 1024 } },
      request: makeRequest({ settings: { topP: 0.95 } }),
    });
    expect(validTopP.body.top_p).toBe(0.95);

    // 4. SSE: non-empty initial block.input, whitespace-only args -> '{}', unclosed text/thinking flushed on message_stop
    const sseDriver = anthropicProvider({
      apiKey: 'test-key',
      fetch: mockFetch(async () =>
        sseResponse([
          sseFrame('message_start', {
            type: 'message_start',
            message: {
              id: 'msg_sse_reg',
              model: 'claude-sonnet-4-5',
              usage: { input_tokens: 10 },
            },
          }),
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: {
              type: 'tool_use',
              id: 'toolu_prefilled',
              name: 'fetch_url',
              input: { url: 'https://example.com' },
            },
          }),
          sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: 'toolu_ws', name: 'noop', input: {} },
          }),
          sseFrame('content_block_delta', {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'input_json_delta', partial_json: '   \n ' },
          }),
          sseFrame('content_block_stop', { type: 'content_block_stop', index: 1 }),
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 2,
            content_block: {
              type: 'thinking',
              thinking: 'open thought',
              signature: 'sig_open',
            },
          }),
          sseFrame('content_block_start', {
            type: 'content_block_start',
            index: 3,
            content_block: { type: 'text', text: 'open text' },
          }),
          // Intentionally omit content_block_stop for indices 2 and 3 before message_stop
          sseFrame('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 12 },
          }),
          sseFrame('message_stop', { type: 'message_stop' }),
        ]),
      ),
    }).create('claude-sonnet-4-5');

    const regSseParts = await collectParts(
      (await sseDriver.stream(makeRequest(), new AbortController().signal)).parts,
    );
    expect(regSseParts.filter((p) => p.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'toolu_prefilled',
        toolName: 'fetch_url',
        input: '{"url":"https://example.com"}',
      },
      {
        type: 'tool-call',
        toolCallId: 'toolu_ws',
        toolName: 'noop',
        input: '{}',
      },
    ]);
    expect(regSseParts.find((p) => p.type === 'reasoning-end')).toEqual({
      type: 'reasoning-end',
      id: 'reasoning-2',
      provider: {
        schemaVersion: 1,
        provider: 'anthropic',
        data: { type: 'thinking', signature: 'sig_open' },
      },
    });
    expect(regSseParts.find((p) => p.type === 'text-end')).toEqual({
      type: 'text-end',
      id: 'text-3',
    });
  });

  test('validates step thinking.budgetTokens against settings.maxOutputTokens (not stale defaultPolicy) and handles tool spec.strict natively', async () => {
    let fetchCalls = 0;
    let capturedBody: Record<string, unknown> | undefined;
    let capturedBeta = '';
    const provider = anthropicProvider(
      {
        apiKey: 'sk-ant-test',
        fetch: async (_url, init) => {
          fetchCalls += 1;
          capturedBody = JSON.parse(String(init?.body ?? '{}'));
          capturedBeta = new Headers(init?.headers).get('anthropic-beta') ?? '';
          return sseResponse([
            sseFrame('message_start', {
              type: 'message_start',
              message: {
                id: 'msg_budget',
                model: 'claude-sonnet-4-5',
                usage: { input_tokens: 10, output_tokens: 0 },
              },
            }),
            sseFrame('content_block_start', {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            }),
            sseFrame('content_block_delta', {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'ok' },
            }),
            sseFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
            sseFrame('message_delta', {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 2 },
            }),
            sseFrame('message_stop', { type: 'message_stop' }),
          ]);
        },
      },
      { defaultPolicy: { maxOutputTokens: 1024 } },
    ).create('claude-sonnet-4-5');

    // 1. defaultPolicy.maxOutputTokens: 1024 + settings.maxOutputTokens: 4096 + step thinking.budgetTokens: 2048 succeeds
    const parts = await collectParts(
      (
        await provider.stream(
          makeRequest({
            settings: { maxOutputTokens: 4096 },
            providerOptions: {
              anthropic: {
                thinking: { type: 'enabled', budgetTokens: 2048 },
                betas: ['custom-step-beta'],
              },
            },
          }),
          new AbortController().signal,
        )
      ).parts,
    );
    expect(fetchCalls).toBe(1);
    expect(capturedBody?.max_tokens).toBe(4096);
    expect(capturedBody?.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect(capturedBeta).toContain('custom-step-beta');
    expect(capturedBeta).toContain('interleaved-thinking-2025-05-14');
    expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({ delta: 'ok' });

    // 1b. Negative control: without settings.maxOutputTokens override, effective 1024 <= 2048 fails fast before fetch
    await expect(
      provider.stream(
        makeRequest({
          settings: {},
          providerOptions: {
            anthropic: { thinking: { type: 'enabled', budgetTokens: 2048 } },
          },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(TypeError);
    expect(fetchCalls).toBe(1);

    // 2. Tool spec.strict: true prepares input_schema via prepareAnthropicJsonSchema and emits strict: true
    const strictToolBuilt = buildAnthropicRequest({
      modelId: 'claude-sonnet-4-5',
      policy: { maxOutputTokens: 1024 },
      request: makeRequest({
        tools: [
          {
            name: 'strict_tool',
            description: 'Strict schema tool',
            strict: true,
            inputSchema: {
              type: 'object',
              additionalProperties: true,
              properties: { q: { type: 'string', minLength: 3 } },
              required: ['q'],
            },
          },
          {
            name: 'loose_tool',
            strict: false,
            inputSchema: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
          {
            name: 'default_tool',
            inputSchema: { type: 'object', properties: { a: { type: 'string' } } },
          },
        ],
      }),
    });
    const wireTools = strictToolBuilt.body.tools as Array<Record<string, unknown>>;
    expect(wireTools[0]).toEqual({
      name: 'strict_tool',
      description: 'Strict schema tool',
      strict: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        properties: { q: { type: 'string', description: 'Constraints: minLength=3' } },
        required: ['q'],
      },
    });
    expect(wireTools[1]).toEqual({
      name: 'loose_tool',
      strict: false,
      input_schema: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
    });
    expect(wireTools[2]).toEqual({
      name: 'default_tool',
      input_schema: { type: 'object', properties: { a: { type: 'string' } } },
    });
    expect('strict' in (wireTools[2] ?? {})).toBe(false);

    // 2b. Negative control: spec.strict: true fails fast on dynamic record schema or recursive $ref
    expect(() =>
      buildAnthropicRequest({
        modelId: 'claude-sonnet-4-5',
        policy: { maxOutputTokens: 1024 },
        request: makeRequest({
          tools: [
            {
              name: 'bad_record_tool',
              strict: true,
              inputSchema: { type: 'object', additionalProperties: { type: 'number' } },
            },
          ],
        }),
      }),
    ).toThrow(TypeError);
  });
});
