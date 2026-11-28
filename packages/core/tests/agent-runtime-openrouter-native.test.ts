import { describe, expect, test } from 'bun:test';
import { createFaultProviderServer } from '../src/agent-runtime/fault-bench';
import type {
  AgentModelRequest,
  AgentModelStreamPart,
} from '../src/agent-runtime/models-driver';
import { parseOpenRouterError } from '../src/agent-runtime/openrouter-response';
import { budgetCacheBreakpoints } from '../src/agent-runtime/provider-cache';
import {
  AgentProviderError,
  AgentProviderStreamCutError,
  classifyProviderFailure,
} from '../src/agent-runtime/provider-failure';
import { envelopeToProviderOptions } from '../src/agent-runtime/provider-media';
import { buildOpenAiChatRequestBody } from '../src/agent-runtime/provider-openai-chat';
import {
  decodeOpenAiChatJsonResponse,
  decodeOpenAiChatSseStream,
  mergeReasoningDetail,
} from '../src/agent-runtime/provider-openai-chat-sse';
import * as openRouterEntrypoint from '../src/entrypoints/agent-runtime/openrouter';
import {
  normalizeOpenRouterUsage,
  OpenRouterRequestPolicySchema,
  openRouterProvider,
} from '../src/entrypoints/agent-runtime/openrouter';

function makeRequest(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    instructions: [{ role: 'system', content: 'You are helpful.' }],
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    settings: {},
    correlation: {
      conversationId: 'conv-1',
      attemptId: 'att-1',
      step: 0,
    },
    ...overrides,
  };
}

function sseResponse(
  frames: readonly string[],
  headers: Record<string, string> = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', ...headers },
  });
}

function sseData(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

async function collectParts(
  stream: AsyncIterable<AgentModelStreamPart>,
): Promise<AgentModelStreamPart[]> {
  const parts: AgentModelStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

interface CapturedCall {
  readonly url: string;
  readonly headers: Headers;
  readonly redirect?: RequestRedirect;
  readonly body: Record<string, unknown>;
}

function mockFetch(respond: (call: CapturedCall) => Response | Promise<Response>): {
  readonly calls: CapturedCall[];
  readonly fetcher: typeof fetch;
} {
  const calls: CapturedCall[] = [];
  const fetcher = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      const rawBody =
        input instanceof Request ? await input.text() : String(init?.body ?? '{}');
      const call: CapturedCall = {
        url,
        headers: new Headers(init?.headers),
        ...(init?.redirect !== undefined && { redirect: init.redirect }),
        body: JSON.parse(rawBody),
      };
      calls.push(call);
      return respond(call);
    },
    { preconnect: () => undefined },
  );
  return { calls, fetcher };
}

describe('openRouterProvider settings, policy validation, and per-request overrides', () => {
  test('uses camelCase baseUrl/providerApiKeys, sets headers, and enforces redirect: error', async () => {
    const { calls, fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-1',
          model: 'anthropic/claude-sonnet-4.5',
          provider: 'Anthropic',
          choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.001 },
        }),
        sseData('[DONE]'),
      ]),
    );
    const factory = openRouterProvider({
      apiKey: 'sk-or-test-secret-1234567890',
      baseUrl: 'https://gateway.example.test/api/v1/',
      appName: 'DemoApp',
      appUrl: 'https://demo.example.test',
      providerApiKeys: { anthropic: 'sk-ant-byok' },
      headers: { 'x-custom': 'yes' },
      fetch: fetcher,
    });
    const stream = await factory
      .create('anthropic/claude-sonnet-4.5')
      .stream(makeRequest(), new AbortController().signal);
    const parts = await collectParts(stream.parts);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gateway.example.test/api/v1/chat/completions');
    expect(calls[0]?.redirect).toBe('error');
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-or-test-secret-1234567890');
    expect(calls[0]?.headers.get('http-referer')).toBe('https://demo.example.test');
    expect(calls[0]?.headers.get('x-openrouter-title')).toBe('DemoApp');
    expect(calls[0]?.headers.get('x-provider-api-keys')).toBe(
      JSON.stringify({ anthropic: 'sk-ant-byok' }),
    );
    expect(calls[0]?.headers.get('x-custom')).toBe('yes');
    expect(parts.find((p) => p.type === 'text-delta')).toEqual({
      type: 'text-delta',
      id: 'text-0',
      delta: 'hi',
    });
  });

  test('validates defaultPolicy fail-fast and refuses extraBody clashes across all POLICY_KEYS', () => {
    expect(() =>
      openRouterProvider(
        { apiKey: 'k' },
        { defaultPolicy: { sessionId: 's1', provider: { order: ['Anthropic'] } } },
      ),
    ).toThrow();

    for (const key of [
      'provider',
      'reasoning',
      'session_id',
      'usage',
      'cache_control',
      'model',
      'stream',
      'messages',
      'response_format',
    ]) {
      expect(() => openRouterProvider({ apiKey: 'k', extraBody: { [key]: 'bad' } })).toThrow(
        TypeError,
      );
    }
  });

  test('sessionPerConversation works without invocations, hashes >256 keys, and yields to provider.order', async () => {
    const { calls, fetcher } = mockFetch(() =>
      Response.json({
        id: 'gen-s',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const factory = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      {
        sessionPerConversation: true,
        resolvePolicy: (id) =>
          id === 'pinned/model' ? { provider: { order: ['DeepInfra'] } } : undefined,
      },
    );

    const shortReq = makeRequest({
      correlation: { conversationId: 'conv-no-invocations', attemptId: 'a1', step: 0 },
    });
    await collectParts(
      (
        await factory
          .create('anthropic/claude-sonnet-4.5')
          .stream(shortReq, new AbortController().signal)
      ).parts,
    );
    expect(calls[0]?.body.session_id).toBe('conv-no-invocations');

    const longConv = 'c'.repeat(300);
    await collectParts(
      (
        await factory.create('anthropic/claude-sonnet-4.5').stream(
          makeRequest({
            correlation: { conversationId: longConv, attemptId: 'a2', step: 0 },
          }),
          new AbortController().signal,
        )
      ).parts,
    );
    expect(typeof calls[1]?.body.session_id).toBe('string');
    expect(String(calls[1]?.body.session_id)).toMatch(/^[a-f0-9]{64}$/u);

    // Negative control: pinned provider.order suppresses session_id.
    await collectParts(
      (await factory.create('pinned/model').stream(shortReq, new AbortController().signal))
        .parts,
    );
    expect(calls[2]?.body.session_id).toBeUndefined();
    expect(calls[2]?.body.provider).toEqual({ order: ['DeepInfra'] });
  });

  test('per-request providerOptions.openrouter overrides policy cleanly', async () => {
    const { calls, fetcher } = mockFetch(() =>
      Response.json({
        id: 'gen-a3',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const factory = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      {
        defaultPolicy: {
          sessionId: 'policy-session',
          reasoning: { effort: 'low' },
          cacheControl: { type: 'ephemeral', ttl: '5m' },
        },
      },
    );
    const req = makeRequest({
      tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }],
      providerOptions: {
        openrouter: {
          provider: { allowFallbacks: false, dataCollection: 'deny' },
          looseTools: true,
          reasoning: { maxTokens: 4096, exclude: true },
          sessionId: 'req-session',
          cacheControl: { type: 'ephemeral', ttl: '1h' },
          extraBody: { transforms: ['middle-out'] },
        },
      },
    });
    await collectParts(
      (
        await factory
          .create('anthropic/claude-sonnet-4.5')
          .stream(req, new AbortController().signal)
      ).parts,
    );
    expect(calls[0]?.body.provider).toEqual({
      allow_fallbacks: false,
      data_collection: 'deny',
    });
    expect(calls[0]?.body.reasoning).toEqual({ max_tokens: 4096, exclude: true });
    expect(calls[0]?.body.session_id).toBe('req-session');
    expect(calls[0]?.body.sessionId).toBeUndefined();
    expect(calls[0]?.body.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(calls[0]?.body.transforms).toEqual(['middle-out']);
    const sentTools = Array.isArray(calls[0]?.body.tools) ? calls[0]?.body.tools : [];
    expect(
      (sentTools[0] as { function?: { strict?: boolean } } | undefined)?.function?.strict,
    ).toBe(false);

    // When provider.order is set per-request, defaultPolicy sessionId must NOT be emitted.
    const pinnedReq = makeRequest({
      providerOptions: {
        openrouter: {
          provider: { order: ['Anthropic'] },
          reasoning: { enabled: false },
        },
      },
    });
    await collectParts(
      (
        await factory
          .create('anthropic/claude-sonnet-4.5')
          .stream(pinnedReq, new AbortController().signal)
      ).parts,
    );
    expect(calls[1]?.body.session_id).toBeUndefined();
    expect(calls[1]?.body.provider).toEqual({ order: ['Anthropic'] });
    expect(calls[1]?.body.reasoning).toEqual({ enabled: false });

    // Negative controls: conflicting reasoning.effort + maxTokens, sessionId + provider.order, unknown key
    expect(
      OpenRouterRequestPolicySchema.safeParse({
        reasoning: { effort: 'high', maxTokens: 1024 },
      }).success,
    ).toBe(false);
    await expect(
      factory.create('anthropic/claude-sonnet-4.5').stream(
        makeRequest({
          providerOptions: {
            openrouter: { sessionId: 'conflict', provider: { order: ['Anthropic'] } },
          },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      factory
        .create('anthropic/claude-sonnet-4.5')
        .stream(
          makeRequest({ providerOptions: { openrouter: { unknownTypo: true } } }),
          new AbortController().signal,
        ),
    ).rejects.toThrow();
  });

  test('entrypoint exposes canonical exports without removed OpenRouterDriverError/OpenRouterCacheControlSchema', () => {
    expect(typeof openRouterEntrypoint.openRouterProvider).toBe('function');
    expect(typeof openRouterEntrypoint.normalizeOpenRouterUsage).toBe('function');
    expect('OpenRouterDriverError' in openRouterEntrypoint).toBe(false);
    expect('OpenRouterCacheControlSchema' in openRouterEntrypoint).toBe(false);
  });
});

describe('OpenAI-Chat wire encoding: cache control, strict tools, responseFormat, history hygiene', () => {
  test('6 parallel tool calls attach cache_control ONLY to the last tool-result inside content array (never at root)', () => {
    const toolResults = Array.from({ length: 6 }, (_, i) => ({
      type: 'tool-result' as const,
      toolCallId: `call_${i}`,
      toolName: `tool_${i}`,
      output: { type: 'text' as const, value: `result-${i}` },
      cacheControl: { type: 'ephemeral' as const },
    }));
    const body = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({
        messages: [
          {
            role: 'assistant',
            content: toolResults.map((tr) => ({
              type: 'tool-call' as const,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              input: { b: 2, a: 1 },
            })),
          },
          {
            role: 'tool',
            cacheControl: { type: 'ephemeral' },
            content: toolResults,
          },
        ],
      }),
      hooks: {
        providerKey: 'openrouter',
        supportsInlineCacheControl: true,
        usageInclusion: 'openrouter',
      },
    });

    const wireMessages = body.messages as Record<string, unknown>[];
    const toolMessages = wireMessages.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(6);
    for (let i = 0; i < 6; i += 1) {
      expect(toolMessages[i]?.cache_control).toBeUndefined();
      if (i < 5) {
        expect(toolMessages[i]?.content).toBe(`result-${i}`);
      } else {
        expect(toolMessages[i]?.content).toEqual([
          { type: 'text', text: 'result-5', cache_control: { type: 'ephemeral' } },
        ]);
      }
    }
    // Deterministic JSON key sorting on tool arguments.
    const assistantMsg = wireMessages.find((m) => m.role === 'assistant');
    const calls = assistantMsg?.tool_calls as Array<{ function: { arguments: string } }>;
    expect(calls[0]?.function.arguments).toBe('{"a":1,"b":2}');
  });

  test('supports cacheControl on assistant (never dropped), image-only user fallback, and budgets <= 4 breakpoints', () => {
    const body = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({
        instructions: [
          {
            role: 'system',
            content: 'Sys prompt',
            cacheControl: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        tools: [
          {
            name: 'lookup',
            inputSchema: { type: 'object', properties: {} },
            cacheControl: { type: 'ephemeral', ttl: '1h' },
          },
        ],
        messages: [
          { role: 'user', content: 'old-1', cacheControl: { type: 'ephemeral' } },
          { role: 'assistant', content: 'old-assistant', cacheControl: { type: 'ephemeral' } },
          {
            role: 'user',
            cacheControl: { type: 'ephemeral' },
            content: [
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
              },
            ],
          },
          {
            role: 'assistant',
            cacheControl: { type: 'ephemeral' },
            content: [{ type: 'text', text: 'kept-assistant' }],
          },
        ],
      }),
      hooks: {
        providerKey: 'openrouter',
        supportsInlineCacheControl: true,
        usageInclusion: 'openrouter',
      },
    });

    const wireMessages = body.messages as Record<string, unknown>[];
    const wireTools = body.tools as Record<string, unknown>[];
    // Tools (1) + System (1) + last 2 messages (image-only user + assistant) = 4 total!
    expect(wireTools[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(wireMessages[0]?.content).toEqual([
      { type: 'text', text: 'Sys prompt', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    // Earlier message breakpoints trimmed by budgetCacheBreakpoints.
    expect(wireMessages[1]?.content).toBe('old-1');
    expect(wireMessages[2]?.content).toBe('old-assistant');
    // Image-only user fell back to its last non-text part.
    expect(wireMessages[3]?.content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AQID' },
        cache_control: { type: 'ephemeral' },
      },
    ]);
    // Assistant cache_control preserved on last text block!
    expect(wireMessages[4]?.content).toEqual([
      { type: 'text', text: 'kept-assistant', cache_control: { type: 'ephemeral' } },
    ]);
  });

  test('gates auto policy cache_control via openRouterAllowsInlineCacheControl (never attaches to google/gemini*)', async () => {
    const { calls, fetcher } = mockFetch(() =>
      Response.json({
        id: 'gen-cc',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    );
    const factory = openRouterProvider(
      { apiKey: 'k', fetch: fetcher },
      { defaultPolicy: { cacheControl: { type: 'ephemeral' } } },
    );
    await collectParts(
      (
        await factory
          .create('anthropic/claude-sonnet-4.5')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    await collectParts(
      (
        await factory
          .create('google/gemini-2.5-pro')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(calls[0]?.body.cache_control).toEqual({ type: 'ephemeral' });
    expect(calls[1]?.body.cache_control).toBeUndefined();
  });

  test('looseTools preserves explicit strict: true, handles tools:[] on tool history, skips providerExecuted calls, and guards empty content', () => {
    const body = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({
        tools: [
          { name: 'strict_tool', inputSchema: { type: 'object' }, strict: true },
          { name: 'default_tool', inputSchema: { type: 'object' } },
        ],
        messages: [
          { role: 'user', content: '', cacheControl: { type: 'ephemeral' } },
          { role: 'assistant', content: '' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'srv-1',
                toolName: 'web_search',
                input: { q: 'news' },
                providerExecuted: true,
              },
              {
                type: 'tool-call',
                toolCallId: 'cli-1',
                toolName: 'strict_tool',
                input: { x: 1 },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'cli-1',
                toolName: 'strict_tool',
                output: { type: 'text', value: '' },
              },
            ],
          },
        ],
      }),
      hooks: { providerKey: 'openrouter', looseTools: true, supportsInlineCacheControl: true },
    });

    const wireTools = body.tools as Array<{ function: { name: string; strict?: boolean } }>;
    expect(wireTools[0]?.function.strict).toBe(true);
    expect(wireTools[1]?.function.strict).toBe(false);

    const wireMessages = body.messages as Record<string, unknown>[];
    // Empty string user does NOT get `{ type: 'text', text: '', cache_control }`.
    expect(wireMessages[1]).toEqual({ role: 'user', content: '' });
    // Empty string assistant without tool calls is omitted completely.
    const assistants = wireMessages.filter((m) => m.role === 'assistant');
    expect(assistants).toHaveLength(1);
    const assistantCalls = assistants[0]?.tool_calls as Array<{ id: string }>;
    expect(assistantCalls.map((c) => c.id)).toEqual(['cli-1']);
    // Empty tool output replaced with `(no tool output)`.
    const toolMsg = wireMessages.find((m) => m.role === 'tool');
    expect(toolMsg?.content).toBe('(no tool output)');

    // When tools.length === 0 but history has tool traffic, emit `tools: []`.
    const noToolsWithHistory = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({
        tools: [],
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'f', input: {} }],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'c1',
                toolName: 'f',
                output: { type: 'text', value: 'ok' },
              },
            ],
          },
        ],
      }),
      hooks: { providerKey: 'openrouter' },
    });
    expect(noToolsWithHistory.tools).toEqual([]);

    // Negative control: no tools and no tool traffic omits `tools`.
    const noToolsPlain = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({ tools: [] }),
      hooks: { providerKey: 'openrouter' },
    });
    expect(noToolsPlain.tools).toBeUndefined();
  });

  test('encodes structured outputs (responseFormat) and fallback file naming', () => {
    const schemaBody = buildOpenAiChatRequestBody({
      modelId: 'openai/gpt-4.1',
      request: makeRequest({
        responseFormat: {
          type: 'json-schema',
          name: 'answer_payload',
          description: 'Structured answer',
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
          },
        },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'data', data: new Uint8Array([37, 80, 68, 70]) },
              },
            ],
          },
        ],
      }),
      hooks: { providerKey: 'openrouter' },
    });
    expect(schemaBody.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer_payload',
        description: 'Structured answer',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
        strict: true,
      },
    });
    const userMsg = (schemaBody.messages as Record<string, unknown>[])[1];
    expect(userMsg?.content).toEqual([
      {
        type: 'file',
        file: { filename: 'file.pdf', file_data: 'data:application/pdf;base64,JVBERg==' },
      },
    ]);

    const jsonObjBody = buildOpenAiChatRequestBody({
      modelId: 'openai/gpt-4.1',
      request: makeRequest({ responseFormat: { type: 'json-object' } }),
      hooks: { providerKey: 'openrouter' },
    });
    expect(jsonObjBody.response_format).toEqual({ type: 'json_object' });
  });
});

describe('SSE & JSON decoding, reasoning round-trip, Gemini thought_signature, and error safety', () => {
  test('guards error:null, emits ping on keepalive comments, validates URL citations, and tags generated images', async () => {
    const { fetcher } = mockFetch(() =>
      sseResponse([
        ': OPENROUTER PROCESSING\n\n',
        sseData({
          id: 'gen-ok',
          model: 'google/gemini-2.5-flash-image',
          provider: 'Google',
          error: null,
          choices: [
            {
              index: 0,
              delta: {
                content: 'Here it is',
                images: [{ image_url: { url: 'data:image/png;base64,AAAA' } }],
                annotations: [
                  {
                    type: 'url_citation',
                    url_citation: { url: 'https://example.com/a', title: 'Valid' },
                  },
                  {
                    type: 'url_citation',
                    url_citation: { url: 'not a valid url', title: 'Invalid' },
                  },
                ],
              },
              finish_reason: 'stop',
              native_finish_reason: 'STOP',
            },
          ],
          usage: { prompt_tokens: 15, completion_tokens: 5, cost: 0.002 },
        }),
        sseData('[DONE]'),
      ]),
    );

    const stream = await openRouterProvider({ apiKey: 'k', fetch: fetcher })
      .create('google/gemini-2.5-flash-image')
      .stream(makeRequest(), new AbortController().signal);
    const parts = await collectParts(stream.parts);

    expect(parts.some((p) => p.type === 'ping')).toBe(true);
    expect(parts.filter((p) => p.type === 'error')).toEqual([]);
    expect(parts.find((p) => p.type === 'file')).toEqual({
      type: 'file',
      mediaType: 'image/png',
      data: { type: 'data', data: 'AAAA' },
    });
    const sources = parts.filter((p) => p.type === 'source');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.type === 'source' && sources[0].source.url).toBe(
      'https://example.com/a',
    );
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.type === 'finish' && finish.finishReason).toBe('stop');
    expect(finish?.type === 'finish' && finish.rawFinishReason).toBe('STOP');
  });

  test('computes BYOK total cost with provenance=computed and populates costDetails', async () => {
    const byokUsage = {
      prompt_tokens: 1000,
      completion_tokens: 200,
      is_byok: true,
      cost: 0.0005,
      cost_details: {
        upstream_inference_cost: 0.012,
        upstream_inference_prompt_cost: 0.008,
        upstream_inference_completions_cost: 0.004,
      },
      prompt_tokens_details: { cached_tokens: 400 },
      completion_tokens_details: { reasoning_tokens: 50 },
    };
    const direct = normalizeOpenRouterUsage(byokUsage);
    expect(direct.cost).toEqual({ value: 0.0125, currency: 'USD', provenance: 'computed' });
    expect(direct.cacheWriteTokens).toEqual({ provenance: 'unavailable' });

    // Fallback when upstream_inference_cost is absent: prompt_cost + completions_cost.
    const fallbackByok = normalizeOpenRouterUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      is_byok: true,
      cost: 0.001,
      cost_details: { prompt_cost: 0.002, completions_cost: 0.003 },
    });
    expect(fallbackByok.cost).toEqual({
      value: 0.006,
      currency: 'USD',
      provenance: 'computed',
    });

    // Negative control: non-BYOK stays provider-reported.
    const nonByok = normalizeOpenRouterUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      is_byok: false,
      cost: 0.004,
    });
    expect(nonByok.cost).toEqual({
      value: 0.004,
      currency: 'USD',
      provenance: 'provider-reported',
    });

    // End-to-end stream emits costDetails on finish part.
    const { fetcher } = mockFetch(() =>
      Response.json({
        id: 'gen-byok',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: byokUsage,
      }),
    );
    const parts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: fetcher })
          .create('anthropic/claude-sonnet-4.5')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.type === 'finish' && finish.costDetails).toEqual({
      promptCostUsd: 0.008,
      outputCostUsd: 0.004,
      isByok: true,
    });
    expect(finish?.type === 'finish' && finish.usage.cost).toEqual({
      value: 0.0125,
      currency: 'USD',
      provenance: 'computed',
    });
  });

  test('native_finish_reason guard surfaces retryable AgentProviderError on empty abnormal stop', async () => {
    for (const nativeReason of [
      'MALFORMED_RESPONSE',
      'OTHER',
      'insufficient_system_resource',
      'ERROR',
    ]) {
      const { fetcher } = mockFetch(() =>
        sseResponse([
          sseData({
            id: `gen-${nativeReason}`,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
                native_finish_reason: nativeReason,
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 0 },
          }),
          sseData('[DONE]'),
        ]),
      );
      const parts = await collectParts(
        (
          await openRouterProvider({ apiKey: 'k', fetch: fetcher })
            .create('google/gemini-2.5-pro')
            .stream(makeRequest(), new AbortController().signal)
        ).parts,
      );
      const errPart = parts.find((p) => p.type === 'error');
      expect(errPart?.type).toBe('error');
      if (errPart?.type === 'error') {
        expect(errPart.error).toBeInstanceOf(AgentProviderError);
        const failure = classifyProviderFailure(errPart.error);
        expect(failure.reason).toBe('stream-cut');
        expect(failure.retryable).toBe(true);
      }
      const finish = parts.find((p) => p.type === 'finish');
      expect(finish?.type === 'finish' ? finish.finishReason : undefined).toBe('error');
    }

    // Negative control: non-empty response with native_finish_reason 'OTHER' is NOT errored.
    const { fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-valid',
          choices: [
            {
              index: 0,
              delta: { content: 'Valid answer' },
              finish_reason: 'stop',
              native_finish_reason: 'OTHER',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    const validParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: fetcher })
          .create('google/gemini-2.5-pro')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(validParts.filter((p) => p.type === 'error')).toEqual([]);
    const validFinish = validParts.find((p) => p.type === 'finish');
    expect(validFinish?.type === 'finish' && validFinish.finishReason).toBe('stop');
  });

  test('mid-stream error preserves usage on same chunk and NEVER emits partial tool calls', async () => {
    const { fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-err',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_partial',
                    type: 'function',
                    function: { name: 'search', arguments: '{"q":"hel' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-err',
          error: {
            code: 502,
            message: 'Provider returned error',
            metadata: {
              provider_name: 'Anthropic',
              raw: {
                error: {
                  type: 'overloaded_error',
                  message: 'Overloaded for Bearer sk-ant-secret123456',
                },
              },
            },
          },
          usage: { prompt_tokens: 40, completion_tokens: 12, cost: 0.0008 },
        }),
        sseData('[DONE]'),
      ]),
    );

    const parts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: fetcher })
          .create('anthropic/claude-sonnet-4.5')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(parts.filter((p) => p.type === 'tool-call')).toEqual([]);
    const errPart = parts.find((p) => p.type === 'error');
    expect(errPart?.type).toBe('error');
    if (errPart?.type === 'error') {
      expect(errPart.error).toBeInstanceOf(AgentProviderError);
      const err = errPart.error as AgentProviderError;
      expect(err.message).toContain('[Anthropic]');
      expect(err.message).not.toContain('sk-ant-secret123456');
      expect(classifyProviderFailure(err).reason).toBe('overloaded');
    }
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.type === 'finish' && finish.finishReason).toBe('error');
    expect(finish?.type === 'finish' && finish.usage.inputTokens.value).toBe(40);
    expect(finish?.type === 'finish' && finish.usage.cost?.value).toBe(0.0008);
  });

  test('200 OK { error } and non-2xx HTTP errors unwrap metadata.raw, redact secrets, and carry Retry-After', async () => {
    // 200 OK JSON error envelope with nested JSON string metadata.raw
    const okErr = mockFetch(() =>
      Response.json({
        error: {
          code: 429,
          message: 'Provider returned error',
          metadata: {
            provider_name: 'DeepInfra',
            raw: JSON.stringify({
              error: {
                code: 'rate_limit_exceeded',
                message: 'Slow down sk-or-v1-abc123456789',
              },
            }),
          },
        },
      }),
    );
    const driver1 = openRouterProvider({ apiKey: 'k', fetch: okErr.fetcher }).create(
      'meta/llama',
    );
    let caught1: unknown;
    try {
      await collectParts(
        (await driver1.stream(makeRequest(), new AbortController().signal)).parts,
      );
    } catch (error) {
      caught1 = error;
    }
    expect(caught1).toBeInstanceOf(AgentProviderError);
    if (caught1 instanceof AgentProviderError) {
      expect(caught1.message).toContain('[DeepInfra]');
      expect(caught1.message).not.toContain('sk-or-v1-abc123456789');
      expect(caught1.code).toBe('rate_limit_exceeded');
      expect(classifyProviderFailure(caught1).reason).toBe('rate-limited');
    }

    // Non-2xx HTTP 502 with huge HTML snippet in metadata.raw and Retry-After header
    const bigHtml = `<!DOCTYPE html><html><body>${'x'.repeat(4000)} Bearer secret-token-abc</body></html>`;
    const httpErr = mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: 502,
              message: 'Provider returned error',
              metadata: { provider_name: 'Cloudflare', raw: bigHtml },
            },
          }),
          {
            status: 502,
            headers: {
              'content-type': 'application/json',
              'retry-after': '3',
              'x-request-id': 'req-502',
            },
          },
        ),
    );
    const driver2 = openRouterProvider({ apiKey: 'k', fetch: httpErr.fetcher }).create(
      'meta/llama',
    );
    let caught2: unknown;
    try {
      await driver2.stream(makeRequest(), new AbortController().signal);
    } catch (error) {
      caught2 = error;
    }
    expect(caught2).toBeInstanceOf(AgentProviderError);
    if (caught2 instanceof AgentProviderError) {
      expect(caught2.statusCode).toBe(502);
      expect(caught2.retryAfterMs).toBe(3000);
      expect(caught2.requestId).toBe('req-502');
      expect(caught2.message.length).toBeLessThanOrEqual(600);
      expect(caught2.message).not.toContain('secret-token-abc');
      expect(classifyProviderFailure(caught2).retryAfterMs).toBe(3000);
    }
  });

  test('reasoning.encrypted-only turns emit reasoning-start/end, distinct blocks stay unmerged, and DeepSeek unsigned reasoning replays intact', async () => {
    // 1. Encrypted-only turn with text (no visible reasoning text, no tool calls)
    const { fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-enc',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  {
                    type: 'reasoning.encrypted',
                    id: 'enc_1',
                    format: 'openai-responses-v1',
                    data: 'CIPHERTEXT',
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-enc',
          choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
        }),
        sseData('[DONE]'),
      ]),
    );
    const parts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: fetcher })
          .create('openai/o3')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    const rStart = parts.find((p) => p.type === 'reasoning-start');
    const rEnd = parts.find((p) => p.type === 'reasoning-end');
    expect(rStart).toBeDefined();
    expect(rEnd?.type === 'reasoning-end' && rEnd.provider?.data.reasoning_details).toEqual([
      {
        type: 'reasoning.encrypted',
        id: 'enc_1',
        format: 'openai-responses-v1',
        data: 'CIPHERTEXT',
      },
    ]);

    // 2. Merging preserves distinct blocks by (type, format, index, id)
    const acc: Record<string, unknown>[] = [];
    mergeReasoningDetail(acc, {
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      id: 'a',
      text: 'one',
    });
    mergeReasoningDetail(acc, {
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      id: 'a',
      text: ' two',
      signature: 'sig-a',
    });
    mergeReasoningDetail(acc, {
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      id: 'b',
      text: 'separate',
    });
    expect(acc).toHaveLength(2);
    expect(acc[0]).toEqual({
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      id: 'a',
      text: 'one two',
      signature: 'sig-a',
    });
    expect(acc[1]).toEqual({
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      id: 'b',
      text: 'separate',
    });

    // 3. Replay keeps unsigned DeepSeek/Qwen/xAI reasoning.text while filtering unsigned Anthropic/Gemini
    const replayBody = buildOpenAiChatRequestBody({
      modelId: 'deepseek/deepseek-r1',
      request: makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'deep thought',
                providerOptions: {
                  openrouter: {
                    reasoning_details: [
                      { type: 'reasoning.text', text: 'deepseek unsigned (no format)' },
                      {
                        type: 'reasoning.text',
                        format: 'anthropic-claude-v1',
                        text: 'drop unsigned claude',
                      },
                      {
                        type: 'reasoning.text',
                        format: 'anthropic-claude-v1',
                        text: 'keep signed claude',
                        signature: 'sig-1',
                      },
                    ],
                  },
                },
              },
              { type: 'text', text: 'Final' },
            ],
          },
        ],
      }),
      hooks: { providerKey: 'openrouter', supportsReasoningDetails: true },
    });
    const assistant = (replayBody.messages as Record<string, unknown>[])[1];
    expect(assistant?.reasoning_details).toEqual([
      { type: 'reasoning.text', text: 'deepseek unsigned (no format)' },
      {
        type: 'reasoning.text',
        format: 'anthropic-claude-v1',
        text: 'keep signed claude',
        signature: 'sig-1',
      },
    ]);
  });

  test('captures Gemini extra_content.google.thought_signature on tool calls, handles missing tc.index, skips empty toolName, and echoes thought_signature on replay', async () => {
    const { fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-gem',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    id: 'call_a',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"a"}' },
                    extra_content: { google: { thought_signature: 'sig-gemini-1' } },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-gem',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  // Missing tc.index with new tc.id -> opens new slot!
                  {
                    id: 'call_b',
                    type: 'function',
                    function: { name: 'lookup', arguments: '{"q":"b"}' },
                    extra_content: { google: { thought_signature: 'sig-gemini-2' } },
                  },
                  // Malformed empty tool name -> must never emit!
                  {
                    index: 999_999,
                    id: 'call_empty',
                    type: 'function',
                    function: { name: '', arguments: '{}' },
                  },
                ],
              },
              finish_reason: 'stop',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );

    const parts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: fetcher })
          .create('google/gemini-2.5-pro')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    const toolCalls = parts.filter((p) => p.type === 'tool-call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]?.type === 'tool-call' && toolCalls[0].toolCallId).toBe('call_a');
    expect(toolCalls[1]?.type === 'tool-call' && toolCalls[1].toolCallId).toBe('call_b');
    const finish = parts.find((p) => p.type === 'finish');
    // Normalized 'stop' -> 'tool-calls' when tool calls exist.
    expect(finish?.type === 'finish' && finish.finishReason).toBe('tool-calls');

    // Replay echoed thought_signature via envelopeToProviderOptions
    const call0Options =
      toolCalls[0]?.type === 'tool-call'
        ? envelopeToProviderOptions(toolCalls[0].provider)
        : undefined;
    const replay = buildOpenAiChatRequestBody({
      modelId: 'google/gemini-2.5-pro',
      request: makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call_a',
                toolName: 'lookup',
                input: { q: 'a' },
                ...(call0Options && { providerOptions: call0Options }),
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call_a',
                toolName: 'lookup',
                output: { type: 'text', value: 'res' },
              },
            ],
          },
        ],
      }),
      hooks: { providerKey: 'openrouter', supportsToolExtraContent: true },
    });
    const replayedAssistant = (replay.messages as Record<string, unknown>[])[1];
    const replayedCalls = replayedAssistant?.tool_calls as Array<Record<string, unknown>>;
    expect(replayedCalls[0]?.extra_content).toEqual({
      google: { thought_signature: 'sig-gemini-1' },
    });
  });

  test('works end-to-end against createFaultProviderServer (pass, stream-cut, bad-json, http-error)', async () => {
    const server = await createFaultProviderServer({
      scenario: [
        { kind: 'pass', text: 'hello loopback' },
        { kind: 'stream-cut', afterBytes: 25 },
        { kind: 'bad-json' },
        { kind: 'http-error', status: 429 },
      ],
    });
    try {
      const driver = openRouterProvider({ apiKey: 'test-key', baseUrl: server.url }).create(
        'demo/m',
      );

      const passParts = await collectParts(
        (await driver.stream(makeRequest(), new AbortController().signal)).parts,
      );
      expect(
        passParts
          .filter((p) => p.type === 'text-delta')
          .map((p) => (p.type === 'text-delta' ? p.delta : '')),
      ).toEqual(['hello loopback']);

      let cutErr: unknown;
      try {
        await collectParts(
          (await driver.stream(makeRequest(), new AbortController().signal)).parts,
        );
      } catch (error) {
        cutErr = error;
      }
      expect(cutErr).toBeDefined();
      expect(classifyProviderFailure(cutErr)).toMatchObject({
        reason: 'stream-cut',
        retryable: true,
      });

      await expect(
        collectParts((await driver.stream(makeRequest(), new AbortController().signal)).parts),
      ).rejects.toBeInstanceOf(AgentProviderStreamCutError);

      let rateErr: unknown;
      try {
        await driver.stream(makeRequest(), new AbortController().signal);
      } catch (error) {
        rateErr = error;
      }
      expect(rateErr).toBeInstanceOf(AgentProviderError);
      expect(classifyProviderFailure(rateErr)).toMatchObject({
        reason: 'rate-limited',
        status: 429,
        retryable: true,
      });
    } finally {
      await server.close();
    }
  });

  test('pure reasoning.encrypted-only turn (no text, no tool calls), JSON images/error:null, and max tool-call cap', async () => {
    // Pure encrypted-only SSE turn with no visible text and no tool calls
    const { fetcher: encFetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-enc-only',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  { type: 'reasoning.encrypted', id: 'enc_only', data: 'OPAQUE' },
                ],
              },
              finish_reason: 'stop',
              native_finish_reason: 'STOP',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    const encParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: encFetcher })
          .create('openai/o3')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(encParts.some((p) => p.type === 'reasoning-start')).toBe(true);
    const encEnd = encParts.find((p) => p.type === 'reasoning-end');
    expect(
      encEnd?.type === 'reasoning-end' && encEnd.provider?.data.reasoning_details,
    ).toEqual([{ type: 'reasoning.encrypted', id: 'enc_only', data: 'OPAQUE' }]);

    // Non-streaming JSON response with error:null, message.images, and Gemini tool extra_content
    const { fetcher: jsonFetcher } = mockFetch(() =>
      Response.json({
        id: 'gen-json-img',
        error: null,
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Generated',
              images: [{ image_url: { url: 'data:image/webp;base64,BBBB' } }],
              tool_calls: [
                {
                  id: 'call_json_1',
                  type: 'function',
                  function: { name: 'inspect', arguments: '{"k":"v"}' },
                  extra_content: { google: { thought_signature: 'sig-json-1' } },
                },
              ],
            },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    const jsonParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: jsonFetcher })
          .create('google/gemini-2.5-flash')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(jsonParts.find((p) => p.type === 'file')).toEqual({
      type: 'file',
      mediaType: 'image/webp',
      data: { type: 'data', data: 'BBBB' },
    });
    const jsonTool = jsonParts.find((p) => p.type === 'tool-call');
    expect(jsonTool?.type === 'tool-call' && jsonTool.provider?.data.extra_content).toEqual({
      google: { thought_signature: 'sig-json-1' },
    });
    const jsonFinish = jsonParts.find((p) => p.type === 'finish');
    expect(jsonFinish?.type === 'finish' && jsonFinish.finishReason).toBe('tool-calls');

    // Audio URL refused fail-fast; orphan tool call gets synthetic tool result; >256 tool calls refused
    expect(() =>
      buildOpenAiChatRequestBody({
        modelId: 'openai/gpt-4o-audio',
        request: makeRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'audio/mp3',
                  data: { type: 'url', url: new URL('https://example.com/a.mp3') },
                },
              ],
            },
          ],
        }),
        hooks: { providerKey: 'openrouter' },
      }),
    ).toThrow(TypeError);

    const orphanBody = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'tool-call', toolCallId: 'orphan-1', toolName: 'run', input: {} },
            ],
          },
          { role: 'user', content: 'next turn' },
        ],
      }),
      hooks: { providerKey: 'openrouter' },
    });
    const orphanMessages = orphanBody.messages as Record<string, unknown>[];
    expect(
      orphanMessages.some((m) => m.role === 'tool' && m.tool_call_id === 'orphan-1'),
    ).toBe(true);

    const tooManyCalls = Array.from({ length: 257 }, (_, index) => ({
      index,
      id: `call_${index}`,
      type: 'function',
      function: { name: 'noop', arguments: '{}' },
    }));
    const { fetcher: capFetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-cap',
          choices: [
            { index: 0, delta: { tool_calls: tooManyCalls }, finish_reason: 'tool_calls' },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    await expect(
      collectParts(
        (
          await openRouterProvider({ apiKey: 'k', fetch: capFetcher })
            .create('openai/gpt-4.1')
            .stream(makeRequest(), new AbortController().signal)
        ).parts,
      ),
    ).rejects.toBeInstanceOf(AgentProviderError);
  });

  test('decodeOpenAiChatSseStream throws AgentProviderStreamCutError on silent EOF without [DONE] or finish_reason', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseData({
              id: 'cut-1',
              choices: [{ index: 0, delta: { content: 'half' }, finish_reason: null }],
            }),
          ),
        );
        controller.close();
      },
    });
    await expect(
      collectParts(
        decodeOpenAiChatSseStream(body, {
          provider: 'openrouter',
          parseError: () => ({ message: 'err' }),
          normalizeUsage: () => ({ usage: normalizeOpenRouterUsage(undefined) }),
        }),
      ),
    ).rejects.toBeInstanceOf(AgentProviderStreamCutError);
  });

  test('protocol regressions: limit_source/reason, metadata.raw sentinels, normalizeJsonSchema, cache TTL & tail tools, reasoning-only content, index:0 collisions, refusal, reasoning_content, signature guard, and whitespace args', async () => {
    // 1. Preserve error.metadata.limit_source and reason on both HTTP and SSE errors;
    //    never overwrite meaningful outerMessage with "null", "[]", or HTML raw metadata.
    const parsedLimit = parseOpenRouterError({
      error: {
        code: 402,
        message: 'Key credit limit exceeded',
        metadata: {
          provider_name: 'OpenRouter',
          limit_source: 'key',
          reason: 'credit_limit',
          raw: 'null',
        },
      },
    });
    expect(parsedLimit.message).toBe('[OpenRouter] Key credit limit exceeded');
    expect(parsedLimit.metadata).toEqual({
      provider_name: 'OpenRouter',
      limit_source: 'key',
      reason: 'credit_limit',
    });
    expect(
      parseOpenRouterError({
        error: {
          code: 502,
          message: 'Upstream gateway timeout',
          metadata: { raw: '<!DOCTYPE html><html><body>502</body></html>' },
        },
      }).message,
    ).toBe('Upstream gateway timeout');
    expect(
      parseOpenRouterError({
        error: { code: 500, message: 'Server overloaded', metadata: { raw: '[]' } },
      }).message,
    ).toBe('Server overloaded');

    // Verify SSE error frame carries limit_source and reason on AgentProviderError.metadata
    const { fetcher: sseErrFetch } = mockFetch(() =>
      sseResponse([
        sseData({
          error: {
            code: 402,
            message: 'Account balance exhausted',
            metadata: { limit_source: 'account', reason: 'insufficient_credits' },
          },
        }),
      ]),
    );
    const sseErrParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: sseErrFetch })
          .create('openai/gpt-4.1')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    const sseErrPart = sseErrParts.find((p) => p.type === 'error');
    expect(sseErrPart?.type === 'error' && sseErrPart.error).toBeInstanceOf(
      AgentProviderError,
    );
    if (sseErrPart?.type === 'error' && sseErrPart.error instanceof AgentProviderError) {
      expect(sseErrPart.error.metadata).toEqual({
        limit_source: 'account',
        reason: 'insufficient_credits',
      });
      expect(classifyProviderFailure(sseErrPart.error).retryable).toBe(false);
    }

    // 2. openRouterProvider enables normalizeJsonSchema: true on strict responseFormat & tools
    const { calls: schemaCalls, fetcher: schemaFetch } = mockFetch(() =>
      Response.json({
        id: 'gen-schema',
        choices: [
          {
            message: { role: 'assistant', content: '{"a":"x","b":null}' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: schemaFetch })
          .create('openai/gpt-4.1')
          .stream(
            makeRequest({
              responseFormat: {
                type: 'json-schema',
                name: 'out',
                schema: {
                  $schema: 'https://json-schema.org/draft/2020-12/schema',
                  type: 'object',
                  properties: { a: { type: 'string' }, b: { type: 'string' } },
                  required: ['a'],
                },
              },
            }),
            new AbortController().signal,
          )
      ).parts,
    );
    const wireRf = schemaCalls[0]?.body.response_format as {
      json_schema: { schema: Record<string, unknown> };
    };
    expect(wireRf.json_schema.schema.$schema).toBeUndefined();
    expect(wireRf.json_schema.schema.additionalProperties).toBe(false);
    expect(wireRf.json_schema.schema.required).toEqual(['a', 'b']);

    // 3. assertValidCacheTtlOrder rejects 5m before 1h; budgetCacheBreakpoints keeps tail-most 4 tools
    expect(() =>
      buildOpenAiChatRequestBody({
        modelId: 'anthropic/claude-sonnet-4.5',
        request: makeRequest({
          instructions: [
            {
              role: 'system',
              content: 'short',
              cacheControl: { type: 'ephemeral', ttl: '5m' },
            },
          ],
          messages: [
            { role: 'user', content: 'long', cacheControl: { type: 'ephemeral', ttl: '1h' } },
          ],
        }),
        hooks: { providerKey: 'openrouter', supportsInlineCacheControl: true },
      }),
    ).toThrow(TypeError);

    const sixTools = Array.from({ length: 6 }, (_, i) => ({
      slot: 'tools' as const,
      control: { type: 'ephemeral' as const },
      target: `tool-${i}`,
    }));
    expect(budgetCacheBreakpoints(sixTools, 4).map((item) => item.target)).toEqual([
      'tool-2',
      'tool-3',
      'tool-4',
      'tool-5',
    ]);

    // 4. Reasoning-only assistant message (no tool_calls) emits content: '' instead of content: null
    const reasoningOnlyBody = buildOpenAiChatRequestBody({
      modelId: 'anthropic/claude-sonnet-4.5',
      request: makeRequest({
        messages: [
          { role: 'user', content: 'think' },
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'deep thought',
                providerOptions: {
                  openrouter: {
                    reasoning_details: [
                      {
                        type: 'reasoning.text',
                        format: 'xai-responses-v1',
                        text: 'deep thought',
                      },
                    ],
                  },
                },
              },
            ],
          },
          { role: 'user', content: 'continue' },
        ],
      }),
      hooks: { providerKey: 'openrouter', supportsReasoningDetails: true },
    });
    const reasoningOnlyMsg = (reasoningOnlyBody.messages as Record<string, unknown>[])[2];
    expect(reasoningOnlyMsg?.content).toBe('');
    expect(reasoningOnlyMsg?.tool_calls).toBeUndefined();

    // 5. SSE: index:0 collision on repeated/empty rawId + new fn.name, delta.reasoning_content,
    //    delta.refusal -> content-filter, empty signature guard, whitespace-only args -> '{}'
    const acc: Record<string, unknown>[] = [];
    mergeReasoningDetail(acc, {
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      text: 'part1',
      signature: 'sig_keep',
    });
    mergeReasoningDetail(acc, {
      type: 'reasoning.text',
      format: 'anthropic-claude-v1',
      index: 0,
      text: 'part2',
      signature: '',
    });
    expect(acc[0]?.signature).toBe('sig_keep');

    const { fetcher: collisionFetch } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-col',
          choices: [{ index: 0, delta: { reasoning_content: 'Step A' }, finish_reason: null }],
        }),
        sseData({
          id: 'gen-col',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'dup_id', function: { name: 'tool_one', arguments: '   ' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-col',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'dup_id',
                    function: { name: 'tool_two', arguments: '{"b":2}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-col',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, function: { name: 'tool_three', arguments: '{"c":3}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    const colParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: collisionFetch })
          .create('deepseek/deepseek-r1')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(colParts.find((p) => p.type === 'reasoning-delta')).toMatchObject({
      delta: 'Step A',
    });
    const colCalls = colParts.filter((p) => p.type === 'tool-call');
    expect(colCalls).toHaveLength(3);
    expect(colCalls.map((c) => ({ name: c.toolName, input: c.input }))).toEqual([
      { name: 'tool_one', input: '{}' },
      { name: 'tool_two', input: '{"b":2}' },
      { name: 'tool_three', input: '{"c":3}' },
    ]);
    // Duplicate wire id got deduplicated into unique toolCallIds
    expect(new Set(colCalls.map((c) => c.toolCallId)).size).toBe(3);

    // Non-streaming JSON response with multiple tool_calls without `index` + refusal -> content-filter
    const jsonMultiCalls = await collectParts(
      decodeOpenAiChatJsonResponse(
        {
          id: 'gen-jmc',
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'c1', type: 'function', function: { name: 'a', arguments: '' } },
                  {
                    id: 'c2',
                    type: 'function',
                    function: { name: 'b', arguments: '{"x":1}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        {
          provider: 'openrouter',
          parseError: () => ({ message: 'err' }),
          normalizeUsage: () => ({ usage: normalizeOpenRouterUsage(undefined) }),
        },
      ),
    );
    expect(jsonMultiCalls.filter((p) => p.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: '{}' },
      { type: 'tool-call', toolCallId: 'c2', toolName: 'b', input: '{"x":1}' },
    ]);

    const refusalParts = await collectParts(
      decodeOpenAiChatJsonResponse(
        {
          id: 'gen-refusal',
          choices: [
            {
              message: { role: 'assistant', content: null, refusal: 'I cannot comply.' },
              finish_reason: 'stop',
            },
          ],
        },
        {
          provider: 'openrouter',
          parseError: () => ({ message: 'err' }),
          normalizeUsage: () => ({ usage: normalizeOpenRouterUsage(undefined) }),
        },
      ),
    );
    expect(refusalParts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'content-filter',
    });
  });

  test('round-2 wire regressions: repeated (id,name) continuation, multi-chunk index:0 collision, non-concatenating reasoning.encrypted, step sessionId vs defaultPolicy.provider.order, reserved OPENROUTER_POLICY_KEYS, and normalizeMime', async () => {
    // 1. Repeated (rawId, name) on continuation chunks assembles ONE tool call (never splits)
    const { fetcher: repeatFetch } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-rep',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_rep',
                    function: { name: 'search', arguments: '{"q":' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-rep',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_rep',
                    function: { name: 'search', arguments: '"tokyo"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-rep',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_rep', function: { name: 'search', arguments: '' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    const repeatParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: repeatFetch })
          .create('openai/gpt-4o-mini')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(repeatParts.filter((p) => p.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_rep',
        toolName: 'search',
        input: '{"q":"tokyo"}',
      },
    ]);

    // 1b. Negative control: repeated (rawId, name) AFTER complete JSON object + new '{' splits into 2 calls
    const { fetcher: dupCompleteFetch } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-dup2',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_dup',
                    function: { name: 'search', arguments: '{"q":"one"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-dup2',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_dup',
                    function: { name: 'search', arguments: '{"q":"two"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    const dupCompleteCalls = (
      await collectParts(
        (
          await openRouterProvider({ apiKey: 'k', fetch: dupCompleteFetch })
            .create('openai/gpt-4o-mini')
            .stream(makeRequest(), new AbortController().signal)
        ).parts,
      )
    ).filter((p) => p.type === 'tool-call');
    expect(dupCompleteCalls).toHaveLength(2);
    expect(dupCompleteCalls.map((c) => ({ name: c.toolName, input: c.input }))).toEqual([
      { name: 'search', input: '{"q":"one"}' },
      { name: 'search', input: '{"q":"two"}' },
    ]);
    expect(new Set(dupCompleteCalls.map((c) => c.toolCallId)).size).toBe(2);

    // 2. Multi-chunk index:0 collision routes arg-only continuation chunks to call_2 without corrupting call_1
    const { fetcher: multiCollisionFetch } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-mc',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'tool_a', arguments: '{"a":1}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-mc',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_2', function: { name: 'tool_b', arguments: '{"b":' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-mc',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '2,"c":' } }],
              },
              finish_reason: null,
            },
          ],
        }),
        sseData({
          id: 'gen-mc',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '3}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
        sseData('[DONE]'),
      ]),
    );
    const multiCollisionParts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: multiCollisionFetch })
          .create('google/gemini-2.5-flash')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(multiCollisionParts.filter((p) => p.type === 'tool-call')).toEqual([
      { type: 'tool-call', toolCallId: 'call_1', toolName: 'tool_a', input: '{"a":1}' },
      { type: 'tool-call', toolCallId: 'call_2', toolName: 'tool_b', input: '{"b":2,"c":3}' },
    ]);

    // 3. mergeReasoningDetail NEVER concatenates reasoning.encrypted base64 ciphertext
    const encAcc: Record<string, unknown>[] = [];
    mergeReasoningDetail(encAcc, {
      type: 'reasoning.encrypted',
      id: 'enc_1',
      format: 'openai-responses-v1',
      index: 0,
      data: 'CIPHER_V1==',
    });
    mergeReasoningDetail(encAcc, {
      type: 'reasoning.encrypted',
      id: 'enc_1',
      format: 'openai-responses-v1',
      index: 0,
      data: 'CIPHER_V2==',
    });
    expect(encAcc).toEqual([
      {
        type: 'reasoning.encrypted',
        id: 'enc_1',
        format: 'openai-responses-v1',
        index: 0,
        data: 'CIPHER_V2==',
      },
    ]);
    // Without id: distinct blobs stay separate; exact duplicate is deduplicated
    const noIdAcc: Record<string, unknown>[] = [];
    mergeReasoningDetail(noIdAcc, {
      type: 'reasoning.encrypted',
      format: 'google-gemini-v1',
      index: 0,
      data: 'BLOB_A==',
    });
    mergeReasoningDetail(noIdAcc, {
      type: 'reasoning.encrypted',
      format: 'google-gemini-v1',
      index: 0,
      data: 'BLOB_B==',
    });
    mergeReasoningDetail(noIdAcc, {
      type: 'reasoning.encrypted',
      format: 'google-gemini-v1',
      index: 0,
      data: 'BLOB_A==',
    });
    expect(noIdAcc).toEqual([
      { type: 'reasoning.encrypted', format: 'google-gemini-v1', index: 0, data: 'BLOB_A==' },
      { type: 'reasoning.encrypted', format: 'google-gemini-v1', index: 0, data: 'BLOB_B==' },
    ]);

    // 4. Step providerOptions.openrouter.sessionId clears inherited defaultPolicy.provider.order
    const { fetcher: sessionFetch, calls: sessionCaptured } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-sess',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        }),
        sseData('[DONE]'),
      ]),
    );
    const orderedProvider = openRouterProvider(
      { apiKey: 'k', fetch: sessionFetch },
      { defaultPolicy: { provider: { order: ['Anthropic'], allowFallbacks: false } } },
    ).create('anthropic/claude-haiku-4.5');
    await collectParts(
      (
        await orderedProvider.stream(
          makeRequest({ providerOptions: { openrouter: { sessionId: 'step-session-99' } } }),
          new AbortController().signal,
        )
      ).parts,
    );
    expect(sessionCaptured[0]?.body.session_id).toBe('step-session-99');
    expect(sessionCaptured[0]?.body.provider).toEqual({ allow_fallbacks: false });

    // Only order on defaultPolicy -> provider omitted completely when step sets sessionId
    const orderOnlyProvider = openRouterProvider(
      { apiKey: 'k', fetch: sessionFetch },
      { defaultPolicy: { provider: { order: ['Anthropic'] } } },
    ).create('anthropic/claude-haiku-4.5');
    await collectParts(
      (
        await orderOnlyProvider.stream(
          makeRequest({ providerOptions: { openrouter: { sessionId: 'step-only-sess' } } }),
          new AbortController().signal,
        )
      ).parts,
    );
    expect(sessionCaptured[1]?.body.session_id).toBe('step-only-sess');
    expect(sessionCaptured[1]?.body.provider).toBeUndefined();

    // Negative control: step setting BOTH sessionId and provider.order fails fast
    await expect(
      orderedProvider.stream(
        makeRequest({
          providerOptions: {
            openrouter: { sessionId: 'conflict', provider: { order: ['OpenAI'] } },
          },
        }),
        new AbortController().signal,
      ),
    ).rejects.toThrow();

    // 5. Newly reserved OPENROUTER_POLICY_KEYS rejected in extraBody
    for (const key of [
      'tools',
      'tool_choice',
      'max_tokens',
      'temperature',
      'top_p',
      'top_k',
      'presence_penalty',
      'frequency_penalty',
      'seed',
      'stop',
    ]) {
      expect(() => openRouterProvider({ apiKey: 'k', extraBody: { [key]: 'bad' } })).toThrow(
        TypeError,
      );
    }

    // 6. normalizeMime handles uppercase / parameters / image/jpg in Chat Completions encoding
    const mediaBody = buildOpenAiChatRequestBody({
      modelId: 'openai/gpt-4o-mini',
      request: makeRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'IMAGE/JPG; charset=binary',
                data: { type: 'data', data: 'AQID' },
              },
              {
                type: 'file',
                mediaType: 'AUDIO/MPEG; charset=binary',
                data: { type: 'data', data: 'BAUG' },
              },
            ],
          },
        ],
      }),
      hooks: { providerKey: 'openrouter' },
    });
    const userMsg = (mediaBody.messages as Array<{ content: unknown[] }>)[1];
    expect(userMsg?.content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
      { type: 'input_audio', input_audio: { data: 'BAUG', format: 'mp3' } },
    ]);
  });

  test('mergeReasoningDetail preserves distinct reasoning.encrypted blocks with id: null while deduplicating exact duplicates and replacing non-empty ids', async () => {
    // Positive: two distinct reasoning.encrypted blocks with id: null are BOTH preserved
    const nullIdAcc: Record<string, unknown>[] = [];
    mergeReasoningDetail(nullIdAcc, {
      type: 'reasoning.encrypted',
      id: null,
      format: 'google-gemini-v1',
      index: 0,
      data: 'BLOB_A==',
    });
    mergeReasoningDetail(nullIdAcc, {
      type: 'reasoning.encrypted',
      id: null,
      format: 'google-gemini-v1',
      index: 1,
      data: 'BLOB_B==',
    });
    // Exact duplicate with id: null + same data is deduplicated
    mergeReasoningDetail(nullIdAcc, {
      type: 'reasoning.encrypted',
      id: null,
      format: 'google-gemini-v1',
      index: 2,
      data: 'BLOB_A==',
    });
    expect(nullIdAcc).toEqual([
      {
        type: 'reasoning.encrypted',
        id: null,
        format: 'google-gemini-v1',
        index: 0,
        data: 'BLOB_A==',
      },
      {
        type: 'reasoning.encrypted',
        id: null,
        format: 'google-gemini-v1',
        index: 1,
        data: 'BLOB_B==',
      },
    ]);

    // Empty-string id is treated the same as missing/null id (distinct blobs preserved)
    const emptyIdAcc: Record<string, unknown>[] = [];
    mergeReasoningDetail(emptyIdAcc, {
      type: 'reasoning.encrypted',
      id: '',
      format: 'google-gemini-v1',
      data: 'E1==',
    });
    mergeReasoningDetail(emptyIdAcc, {
      type: 'reasoning.encrypted',
      id: '',
      format: 'google-gemini-v1',
      data: 'E2==',
    });
    expect(emptyIdAcc).toHaveLength(2);

    // Negative control: same non-empty id replaces data without duplicating or colliding with id: null
    const mixedAcc: Record<string, unknown>[] = [];
    mergeReasoningDetail(mixedAcc, {
      type: 'reasoning.encrypted',
      id: 'enc_1',
      format: 'openai-responses-v1',
      data: 'CIPHER_1==',
    });
    mergeReasoningDetail(mixedAcc, {
      type: 'reasoning.encrypted',
      id: 'enc_1',
      format: 'openai-responses-v1',
      data: 'CIPHER_2==',
    });
    mergeReasoningDetail(mixedAcc, {
      type: 'reasoning.encrypted',
      id: null,
      format: 'openai-responses-v1',
      data: 'CIPHER_2==',
    });
    expect(mixedAcc).toEqual([
      {
        type: 'reasoning.encrypted',
        id: 'enc_1',
        format: 'openai-responses-v1',
        data: 'CIPHER_2==',
      },
      {
        type: 'reasoning.encrypted',
        id: null,
        format: 'openai-responses-v1',
        data: 'CIPHER_2==',
      },
    ]);

    // End-to-end SSE stream with two id: null reasoning.encrypted deltas retains both blocks
    const { fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-enc-null',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  {
                    type: 'reasoning.encrypted',
                    id: null,
                    format: 'google-gemini-v1',
                    index: 0,
                    data: 'SIG_FIRST==',
                  },
                ],
              },
            },
          ],
        }),
        sseData({
          id: 'gen-enc-null',
          choices: [
            {
              index: 0,
              delta: {
                reasoning_details: [
                  {
                    type: 'reasoning.encrypted',
                    id: null,
                    format: 'google-gemini-v1',
                    index: 1,
                    data: 'SIG_SECOND==',
                  },
                ],
              },
            },
          ],
        }),
        sseData({
          id: 'gen-enc-null',
          choices: [{ index: 0, delta: { content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }),
        sseData('[DONE]'),
      ]),
    );
    const parts = await collectParts(
      (
        await openRouterProvider({ apiKey: 'k', fetch: fetcher })
          .create('google/gemini-2.5-pro')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    const reasoningEnd = parts.find((p) => p.type === 'reasoning-end');
    expect(reasoningEnd?.type).toBe('reasoning-end');
    if (reasoningEnd?.type === 'reasoning-end') {
      expect(reasoningEnd.provider?.data.reasoning_details).toEqual([
        {
          type: 'reasoning.encrypted',
          id: null,
          format: 'google-gemini-v1',
          index: 0,
          data: 'SIG_FIRST==',
        },
        {
          type: 'reasoning.encrypted',
          id: null,
          format: 'google-gemini-v1',
          index: 1,
          data: 'SIG_SECOND==',
        },
      ]);
    }
  });

  test('decodeOpenAiChatSseStream wraps mid-stream socket errors in retryable AgentProviderStreamCutError while preserving aborts and refusing blank apiKey', async () => {
    const encoder = new TextEncoder();
    const socketCause = new TypeError('The socket was closed unexpectedly');
    const brokenStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseData({
              id: 'gen-cut',
              choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }],
            }),
          ),
        );
        controller.error(socketCause);
      },
    });
    const decodeOpts = {
      provider: 'openrouter',
      parseError: (payload: unknown) => parseOpenRouterError(payload),
      normalizeUsage: (rawUsage: unknown) => ({ usage: normalizeOpenRouterUsage(rawUsage) }),
    };

    let caught: unknown;
    try {
      await collectParts(decodeOpenAiChatSseStream(brokenStream, decodeOpts));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentProviderStreamCutError);
    if (caught instanceof AgentProviderStreamCutError) {
      expect(caught.provider).toBe('openrouter');
      expect(caught.cause).toBe(socketCause);
      expect(classifyProviderFailure(caught)).toMatchObject({
        reason: 'stream-cut',
        retryable: true,
      });
    }

    // Negative control 1: AbortError thrown mid-stream is NOT wrapped as AgentProviderStreamCutError
    const abortErr = new DOMException('aborted', 'AbortError');
    const abortStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(abortErr);
      },
    });
    let caughtAbort: unknown;
    try {
      await collectParts(decodeOpenAiChatSseStream(abortStream, decodeOpts));
    } catch (error) {
      caughtAbort = error;
    }
    expect(caughtAbort).toBe(abortErr);
    expect(caughtAbort).not.toBeInstanceOf(AgentProviderStreamCutError);

    // Negative control 2: aborted signal rethrows raw error without wrapping as stream-cut
    const ac = new AbortController();
    ac.abort(new Error('user cancelled'));
    const cancelledStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('socket closed during abort'));
      },
    });
    let caughtCancelled: unknown;
    try {
      await collectParts(
        decodeOpenAiChatSseStream(cancelledStream, { ...decodeOpts, signal: ac.signal }),
      );
    } catch (error) {
      caughtCancelled = error;
    }
    expect(caughtCancelled).not.toBeInstanceOf(AgentProviderStreamCutError);

    // Negative control 3: blank/whitespace apiKey fails fast with TypeError; surrounding whitespace is trimmed
    const { calls, fetcher } = mockFetch(() =>
      sseResponse([
        sseData({
          id: 'gen-trim',
          choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
        }),
        sseData('[DONE]'),
      ]),
    );
    await expect(
      openRouterProvider({ apiKey: '   ', fetch: fetcher })
        .create('openai/gpt-4o-mini')
        .stream(makeRequest(), new AbortController().signal),
    ).rejects.toThrow(TypeError);
    await expect(
      openRouterProvider({ apiKey: async () => '\t\n', fetch: fetcher })
        .create('openai/gpt-4o-mini')
        .stream(makeRequest(), new AbortController().signal),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);

    await collectParts(
      (
        await openRouterProvider({ apiKey: '  sk-or-trimmed  ', fetch: fetcher })
          .create('openai/gpt-4o-mini')
          .stream(makeRequest(), new AbortController().signal)
      ).parts,
    );
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sk-or-trimmed');
  });
});
