import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type {
  AgentModelRequest,
  AgentModelStreamPart,
} from '../src/agent-runtime/models-driver';
import { buildOpenAiRequestBody } from '../src/agent-runtime/openai-messages';
import { resolveOpenAiPolicy } from '../src/agent-runtime/openai-options';
import {
  decodeOpenAiJsonResponse,
  parseOpenAiError,
} from '../src/agent-runtime/openai-response';
import { decodeOpenAiSseStream } from '../src/agent-runtime/openai-sse';
import {
  AgentProviderError,
  AgentProviderStreamCutError,
  classifyProviderFailure,
} from '../src/agent-runtime/provider-failure';
import { envelopeToProviderOptions } from '../src/agent-runtime/provider-media';
import { completeText } from '../src/entrypoints/agent-runtime';
import {
  normalizeOpenAiUsage,
  type OpenAiProviderAccess,
  type OpenAiProviderSettings,
  type OpenAiReasoningPolicy,
  OpenAiReasoningPolicySchema,
  type OpenAiRequestPolicy,
  OpenAiRequestPolicySchema,
  openAiProvider,
} from '../src/entrypoints/agent-runtime/openai';
import { createFaultProviderServer } from '../src/entrypoints/agent-runtime/testing';

function baseRequest(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    instructions: [{ role: 'system', content: 'You are a helpful assistant.' }],
    messages: [{ role: 'user', content: 'Hello' }],
    tools: [],
    settings: {},
    correlation: {
      conversationId: 'conv-1',
      attemptId: 'att-1',
      step: 1,
    },
    ...overrides,
  };
}

function sseStreamFromChunks(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function sseEvent(event: string, payload: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function collectParts(
  stream: AsyncIterable<AgentModelStreamPart>,
): Promise<AgentModelStreamPart[]> {
  const parts: AgentModelStreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe('stitchkit/agent-runtime/openai options & entrypoint', () => {
  test('validates OpenAiReasoningPolicySchema and OpenAiRequestPolicySchema strictly', () => {
    const reasoning: OpenAiReasoningPolicy = OpenAiReasoningPolicySchema.parse({
      effort: 'xhigh',
      summary: 'detailed',
    });
    expect(reasoning).toEqual({ effort: 'xhigh', summary: 'detailed' });

    const policy: OpenAiRequestPolicy = OpenAiRequestPolicySchema.parse({
      store: true,
      reasoning: { effort: 'medium', summary: 'auto' },
      serviceTier: 'priority',
      truncation: 'auto',
      promptCacheKey: 'key-123',
      promptCacheRetention: '24h',
      parallelToolCalls: false,
      strictTools: true,
      include: ['reasoning.encrypted_content'],
      user: 'user-42',
    });
    expect(policy.store).toBe(true);
    expect(policy.promptCacheRetention).toBe('24h');

    // Negative controls: invalid enum, oversize cache key, unknown fields rejected
    expect(() => OpenAiReasoningPolicySchema.parse({ effort: 'ultra' })).toThrow();
    expect(() =>
      OpenAiReasoningPolicySchema.parse({ effort: 'low', extraField: true }),
    ).toThrow();
    expect(() =>
      OpenAiRequestPolicySchema.parse({ promptCacheKey: 'x'.repeat(65) }),
    ).toThrow();
    expect(() => OpenAiRequestPolicySchema.parse({ promptCacheKey: '' })).toThrow();
    expect(() => OpenAiRequestPolicySchema.parse({ unknownOption: 1 })).toThrow();
  });

  test('openAiProvider validates defaultPolicy up front and rejects extraBody clashes', () => {
    const badSettings: OpenAiProviderSettings = {
      apiKey: 'sk-test',
      extraBody: { store: true },
    };
    expect(() => openAiProvider(badSettings)).toThrow(TypeError);

    expect(() =>
      openAiProvider({ apiKey: 'sk-test', extraBody: { reasoning: { effort: 'high' } } }),
    ).toThrow(TypeError);

    expect(() =>
      openAiProvider({ apiKey: 'sk-test', extraBody: { prompt_cache_key: 'abc' } }),
    ).toThrow(TypeError);

    const badAccess: OpenAiProviderAccess = {
      defaultPolicy: JSON.parse('{"unknownField":true}'),
    };
    expect(() => openAiProvider({ apiKey: 'sk-test' }, badAccess)).toThrow();
  });
});

describe('openai-messages Responses API encoder', () => {
  test('defaults to store: false and auto-includes encrypted reasoning appropriately', () => {
    // 1. store: false + explicit reasoning => auto-adds reasoning.encrypted_content
    const withReasoning = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest(),
      policy: resolveOpenAiPolicy({ reasoning: { effort: 'medium', summary: 'concise' } }),
      cachePerConversation: false,
    });
    expect(withReasoning.store).toBe(false);
    expect(withReasoning.stream).toBe(true);
    expect(withReasoning.reasoning).toEqual({ effort: 'medium', summary: 'concise' });
    expect(withReasoning.include).toEqual(['reasoning.encrypted_content']);

    // 2. store: false + reasoning model (gpt-5 / o3) without explicit reasoning => auto-adds
    const gpt5Default = buildOpenAiRequestBody({
      modelId: 'gpt-5',
      request: baseRequest(),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: false,
    });
    expect(gpt5Default.store).toBe(false);
    expect(gpt5Default.include).toEqual(['reasoning.encrypted_content']);

    const o3Default = buildOpenAiRequestBody({
      modelId: 'o3-mini',
      request: baseRequest(),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: false,
    });
    expect(o3Default.include).toEqual(['reasoning.encrypted_content']);

    // 3. store: false + non-reasoning model without reasoning => omitted
    const gpt4oDefault = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest(),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: false,
    });
    expect(gpt4oDefault.include).toBeUndefined();

    // 4. store: false + reasoning.effort === 'none' on gpt-5 => NOT auto-added
    const effortNone = buildOpenAiRequestBody({
      modelId: 'gpt-5.1',
      request: baseRequest({ settings: { temperature: 0.7, topP: 0.9 } }),
      policy: resolveOpenAiPolicy({ reasoning: { effort: 'none' } }),
      cachePerConversation: false,
    });
    expect(effortNone.include).toBeUndefined();
    expect(effortNone.temperature).toBe(0.7);
    expect(effortNone.top_p).toBe(0.9);

    // 5. store: true => NOT auto-added even with reasoning configured
    const stateful = buildOpenAiRequestBody({
      modelId: 'o3',
      request: baseRequest(),
      policy: resolveOpenAiPolicy({ store: true, reasoning: { effort: 'high' } }),
      cachePerConversation: false,
    });
    expect(stateful.store).toBe(true);
    expect(stateful.include).toBeUndefined();

    // 6. Deduplicates user-provided include entries
    const dedup = buildOpenAiRequestBody({
      modelId: 'gpt-5',
      request: baseRequest(),
      policy: resolveOpenAiPolicy({
        include: ['reasoning.encrypted_content', 'web_search_call.action.sources'],
      }),
      cachePerConversation: false,
    });
    expect(dedup.include).toEqual([
      'reasoning.encrypted_content',
      'web_search_call.action.sources',
    ]);
  });

  test('I9 fail-fast throws TypeError before HTTP call on unsupported settings', async () => {
    let fetchCalls = 0;
    const mockFetch: typeof fetch = Object.assign(
      async () => {
        fetchCalls += 1;
        return new Response('', { status: 200 });
      },
      { preconnect: fetch.preconnect },
    );

    const factory = openAiProvider({ apiKey: 'sk-test', fetch: mockFetch });
    const driver = factory.create('gpt-4o');
    const signal = new AbortController().signal;

    const badSettingsList = [
      { topK: 40 },
      { presencePenalty: 0.5 },
      { frequencyPenalty: 0.2 },
      { seed: 42 },
      { stopSequences: ['END'] },
    ];
    for (const settings of badSettingsList) {
      await expect(driver.stream(baseRequest({ settings }), signal)).rejects.toThrow(
        TypeError,
      );
    }

    // Reasoning effort !== 'none' rejects temperature & topP
    const reasoningDriver = openAiProvider(
      { apiKey: 'sk-test', fetch: mockFetch },
      { defaultPolicy: { reasoning: { effort: 'medium' } } },
    ).create('gpt-5');

    await expect(
      reasoningDriver.stream(baseRequest({ settings: { temperature: 0.5 } }), signal),
    ).rejects.toThrow(TypeError);
    await expect(
      reasoningDriver.stream(baseRequest({ settings: { topP: 0.9 } }), signal),
    ).rejects.toThrow(TypeError);

    // Step-level providerOptions.openai reasoning also triggers fail-fast
    await expect(
      driver.stream(
        baseRequest({
          settings: { temperature: 0.2 },
          providerOptions: { openai: { reasoning: { effort: 'low' } } },
        }),
        signal,
      ),
    ).rejects.toThrow(TypeError);

    expect(fetchCalls).toBe(0);
  });

  test('encodes developer instructions, directional user/assistant parts, media, and phases', () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const pdfBytes = new Uint8Array([37, 80, 68, 70]);
    const body = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest({
        instructions: [{ role: 'system', content: 'Top instruction' }],
        messages: [
          { role: 'system', content: 'Inline system note' },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect these files' },
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: pngBytes },
                providerOptions: { openai: { detail: 'high' } },
              },
              {
                type: 'file',
                mediaType: 'image/jpeg',
                data: { type: 'url', url: new URL('https://example.com/pic.jpg') },
              },
              {
                type: 'file',
                mediaType: 'image/webp',
                data: { type: 'reference', reference: { openai: 'file_img_1' } },
              },
              {
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'data', data: pdfBytes },
              },
              {
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'url', url: new URL('https://example.com/doc.pdf') },
              },
              {
                type: 'file',
                mediaType: 'application/pdf',
                data: { type: 'reference', reference: { openai: 'file_pdf_2' } },
              },
              {
                type: 'file',
                mediaType: 'text/plain',
                data: { type: 'text', text: 'Inline doc text' },
              },
            ],
          },
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Working on it...',
                providerOptions: { openai: { phase: 'commentary' } },
              },
              {
                type: 'text',
                text: 'Here is the answer.',
                providerOptions: { openai: { phase: 'final_answer' } },
              },
            ],
          },
        ],
      }),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: false,
    });

    expect(body.input).toEqual([
      { role: 'developer', content: 'Top instruction' },
      { role: 'developer', content: 'Inline system note' },
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Inspect these files' },
          { type: 'input_image', image_url: 'data:image/png;base64,iVBORw==', detail: 'high' },
          { type: 'input_image', image_url: 'https://example.com/pic.jpg' },
          { type: 'input_image', file_id: 'file_img_1' },
          {
            type: 'input_file',
            filename: 'file.pdf',
            file_data: 'data:application/pdf;base64,JVBERg==',
          },
          { type: 'input_file', file_url: 'https://example.com/doc.pdf' },
          { type: 'input_file', file_id: 'file_pdf_2' },
          { type: 'input_text', text: 'Inline doc text' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Working on it...' }],
        phase: 'commentary',
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Here is the answer.' }],
        phase: 'final_answer',
      },
    ]);

    // Negative control: file reference missing openai key fails fast
    expect(() =>
      buildOpenAiRequestBody({
        modelId: 'gpt-4o',
        request: baseRequest({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'file',
                  mediaType: 'application/pdf',
                  data: { type: 'reference', reference: { anthropic: 'file_wrong' } },
                },
              ],
            },
          ],
        }),
        policy: resolveOpenAiPolicy(),
        cachePerConversation: false,
      }),
    ).toThrow(TypeError);
  });

  test('round-trips multi-block OpenAI reasoning, ignores foreign reasoning, and handles call_id vs fc_*', () => {
    const messages: AgentModelRequest['messages'] = [
      { role: 'user', content: 'Check weather' },
      {
        role: 'assistant',
        content: [
          // Foreign provider reasoning must be ignored cleanly
          {
            type: 'reasoning',
            text: 'Anthropic thinking',
            providerOptions: { anthropic: { signature: 'sig_foreign' } },
          },
          // First OpenAI reasoning block with summary + encrypted_content
          {
            type: 'reasoning',
            text: 'Checking city weather',
            providerOptions: {
              openai: {
                id: 'rs_1',
                summary: [{ type: 'summary_text', text: 'Checking city weather' }],
                encrypted_content: 'enc_block_1',
              },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_weather_1',
            toolName: 'get_weather',
            input: { units: 'c', city: 'Paris' },
            providerOptions: { openai: { itemId: 'fc_item_1' } },
          },
          // Second OpenAI reasoning block with empty summary + encrypted_content
          {
            type: 'reasoning',
            text: '',
            providerOptions: {
              openai: {
                id: 'rs_2',
                summary: [],
                encrypted_content: 'enc_block_2',
              },
            },
          },
          {
            type: 'tool-call',
            toolCallId: 'call_weather_2',
            toolName: 'get_weather',
            input: { city: 'Tokyo' },
            // Non-fc_ itemId must NEVER be placed in wire `id` even when store: true
            providerOptions: { openai: { itemId: 'call_weather_2' } },
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_weather_1',
            toolName: 'get_weather',
            output: { type: 'json', value: { temp: 20, city: 'Paris' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'call_weather_2',
            toolName: 'get_weather',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Tokyo forecast chart' },
                {
                  type: 'file',
                  mediaType: 'image/png',
                  data: { type: 'url', url: new URL('https://example.com/chart.png') },
                },
              ],
            },
          },
        ],
      },
    ];

    // Stateless (`store: false`): NEVER emit fc_* `id`, DO emit both reasoning blocks + encrypted_content
    const statelessBody = buildOpenAiRequestBody({
      modelId: 'gpt-5',
      request: baseRequest({ messages }),
      policy: resolveOpenAiPolicy({ store: false }),
      cachePerConversation: false,
    });
    expect(statelessBody.input).toEqual([
      { role: 'developer', content: 'You are a helpful assistant.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Check weather' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Checking city weather' }],
        encrypted_content: 'enc_block_1',
      },
      {
        type: 'function_call',
        call_id: 'call_weather_1',
        name: 'get_weather',
        arguments: '{"city":"Paris","units":"c"}',
      },
      {
        type: 'reasoning',
        id: 'rs_2',
        summary: [],
        encrypted_content: 'enc_block_2',
      },
      {
        type: 'function_call',
        call_id: 'call_weather_2',
        name: 'get_weather',
        arguments: '{"city":"Tokyo"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather_1',
        output: '{"city":"Paris","temp":20}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_weather_2',
        output: [
          { type: 'input_text', text: 'Tokyo forecast chart' },
          { type: 'input_image', image_url: 'https://example.com/chart.png' },
        ],
      },
    ]);

    // Stateful (`store: true`): emit `id: 'fc_item_1'` ONLY for fc_* itemId, NEVER for call_*
    const statefulBody = buildOpenAiRequestBody({
      modelId: 'gpt-5',
      request: baseRequest({ messages }),
      policy: resolveOpenAiPolicy({ store: true }),
      cachePerConversation: false,
    });
    const inputItems = Array.isArray(statefulBody.input) ? statefulBody.input : [];
    expect(inputItems[3]).toEqual({
      type: 'function_call',
      id: 'fc_item_1',
      call_id: 'call_weather_1',
      name: 'get_weather',
      arguments: '{"city":"Paris","units":"c"}',
    });
    expect(inputItems[5]).toEqual({
      type: 'function_call',
      call_id: 'call_weather_2',
      name: 'get_weather',
      arguments: '{"city":"Tokyo"}',
    });
  });

  test('encodes tools with strict: false default, structured outputs, history hygiene, and prompt_cache_key', () => {
    const toolSchema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
      },
      required: ['query'],
    };

    const body = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest({
        messages: [
          { role: 'user', content: 'Broken surrogate \ud800 here' },
          {
            role: 'assistant',
            content: [
              {
                type: 'tool-call',
                toolCallId: 'orphan_1',
                toolName: 'search',
                input: { q: 'hi' },
              },
            ],
          },
          { role: 'user', content: 'Continue anyway' },
        ],
        tools: [
          { name: 'search', description: 'Search docs', inputSchema: toolSchema },
          { name: 'strict_tool', inputSchema: toolSchema, strict: true },
        ],
        toolChoice: { type: 'tool', toolName: 'search' },
        responseFormat: {
          type: 'json-schema',
          name: 'search_result_v1',
          description: 'Structured result',
          schema: {
            type: 'object',
            properties: {
              answer: { type: 'string' },
              confidence: { type: 'number' },
            },
            required: ['answer'],
          },
        },
        correlation: {
          conversationId: `${'a'.repeat(64)}-suffix-one`,
          attemptId: 'att-1',
          step: 1,
        },
      }),
      policy: resolveOpenAiPolicy({
        parallelToolCalls: false,
        serviceTier: 'flex',
        truncation: 'auto',
        promptCacheRetention: '24h',
        user: 'u-1',
      }),
      cachePerConversation: true,
    });

    // Tools: default strict is false (optional `limit` stays optional); strict_tool makes `limit` nullable + required
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'search',
        description: 'Search docs',
        strict: false,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: 'integer' },
          },
          required: ['query'],
        },
      },
      {
        type: 'function',
        name: 'strict_tool',
        strict: true,
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            limit: { type: ['integer', 'null'] },
          },
          required: ['query', 'limit'],
          additionalProperties: false,
        },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', name: 'search' });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.service_tier).toBe('flex');
    expect(body.truncation).toBe('auto');
    expect(body.prompt_cache_retention).toBe('24h');
    expect(body.user).toBe('u-1');

    // Structured output normalized with strict: true
    expect(body.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'search_result_v1',
        description: 'Structured result',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            confidence: { type: ['number', 'null'] },
          },
          required: ['answer', 'confidence'],
          additionalProperties: false,
        },
      },
    });

    // Prompt cache key clamped/hashed to <= 64 chars and distinct for different suffixes
    expect(typeof body.prompt_cache_key).toBe('string');
    const keyOne = String(body.prompt_cache_key);
    expect(keyOne.length).toBeGreaterThan(0);
    expect(keyOne.length).toBeLessThanOrEqual(64);

    const bodyTwo = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest({
        correlation: {
          conversationId: `${'a'.repeat(64)}-suffix-two`,
          attemptId: 'att-1',
          step: 1,
        },
      }),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: true,
    });
    expect(bodyTwo.prompt_cache_key).not.toBe(keyOne);

    // Explicit policy.promptCacheKey wins over cachePerConversation
    const explicitKeyBody = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest(),
      policy: resolveOpenAiPolicy({ promptCacheKey: 'pinned-key' }),
      cachePerConversation: true,
    });
    expect(explicitKeyBody.prompt_cache_key).toBe('pinned-key');

    // Orphan tool call received synthetic function_call_output, lone surrogate sanitized
    const wireInput = Array.isArray(body.input) ? body.input : [];
    expect(wireInput[1]).toEqual({
      role: 'user',
      content: [{ type: 'input_text', text: 'Broken surrogate \ufffd here' }],
    });
    expect(wireInput[3]).toEqual({
      type: 'function_call_output',
      call_id: 'orphan_1',
      output: 'Tool result missing (call was interrupted before completion)',
    });

    // json-object responseFormat
    const jsonObjBody = buildOpenAiRequestBody({
      modelId: 'gpt-4o',
      request: baseRequest({ responseFormat: { type: 'json-object' } }),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: false,
    });
    expect(jsonObjBody.text).toEqual({ format: { type: 'json_object' } });

    // Negative control: invalid json-schema name rejected before HTTP
    expect(() =>
      buildOpenAiRequestBody({
        modelId: 'gpt-4o',
        request: baseRequest({
          responseFormat: {
            type: 'json-schema',
            name: 'bad name.with spaces!',
            schema: { type: 'object' },
          },
        }),
        policy: resolveOpenAiPolicy(),
        cachePerConversation: false,
      }),
    ).toThrow(TypeError);
  });
});

describe('openai-sse Responses API SSE decoder', () => {
  test('decodes reasoning, commentary/final phases, citations, parallel tool calls (fc_* -> call_id), and usage', async () => {
    const rawSse = [
      ': keepalive\n\n',
      sseEvent('response.created', {
        type: 'response.created',
        response: { id: 'resp_1', model: 'gpt-5-2026' },
      }),
      sseEvent('response.in_progress', {
        type: 'response.in_progress',
        response: { id: 'resp_1', model: 'gpt-5-2026' },
      }),
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [] },
      }),
      sseEvent('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'Plan: ',
      }),
      sseEvent('response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'call both tools.',
      }),
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Plan: call both tools.' }],
          encrypted_content: 'gAAAA_enc_payload',
        },
      }),
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'message', id: 'msg_1', phase: 'commentary', content: [] },
      }),
      sseEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        delta: 'Checking now',
      }),
      sseEvent('response.output_text.annotation.added', {
        type: 'response.output_text.annotation.added',
        item_id: 'msg_1',
        output_index: 1,
        annotation: { type: 'url_citation', url: 'https://example.com/ref', title: 'Ref' },
      }),
      sseEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: 'msg_1',
        output_index: 1,
        text: 'Checking now',
      }),
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', id: 'fc_alpha', call_id: 'call_alpha', name: 'tool_a' },
      }),
      sseEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: 3,
        item: { type: 'function_call', id: 'fc_beta', call_id: 'call_beta', name: 'tool_b' },
      }),
      // Interleaved argument deltas reference item_id (fc_*), NOT call_id!
      sseEvent('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_alpha',
        output_index: 2,
        delta: '{"a":',
      }),
      sseEvent('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_beta',
        output_index: 3,
        delta: '{"b":2}',
      }),
      sseEvent('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_alpha',
        output_index: 2,
        delta: '1}',
      }),
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          type: 'function_call',
          id: 'fc_alpha',
          call_id: 'call_alpha',
          name: 'tool_a',
          arguments: '{"a":1}',
        },
      }),
      sseEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: 3,
        item: {
          type: 'function_call',
          id: 'fc_beta',
          call_id: 'call_beta',
          name: 'tool_b',
          arguments: '{"b":2}',
        },
      }),
      sseEvent('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-5-2026',
          status: 'completed',
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 600 },
            output_tokens: 250,
            output_tokens_details: { reasoning_tokens: 100 },
          },
        },
      }),
    ].join('');

    // Split across tiny chunks to exercise arbitrary SSE framing boundaries
    const tinyChunks: string[] = [];
    for (let i = 0; i < rawSse.length; i += 17) {
      tinyChunks.push(rawSse.slice(i, i + 17));
    }

    const parts = await collectParts(decodeOpenAiSseStream(sseStreamFromChunks(tinyChunks)));

    expect(parts[0]).toEqual({ type: 'ping' });
    expect(parts.filter((p) => p.type === 'response-metadata')).toEqual([
      { type: 'response-metadata', id: 'resp_1', modelId: 'gpt-5-2026' },
    ]);

    const reasoningEnd = parts.find((p) => p.type === 'reasoning-end');
    expect(reasoningEnd).toEqual({
      type: 'reasoning-end',
      id: 'rs_1',
      provider: {
        schemaVersion: 1,
        provider: 'openai',
        data: {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Plan: call both tools.' }],
          encrypted_content: 'gAAAA_enc_payload',
        },
      },
    });

    const textEnd = parts.find((p) => p.type === 'text-end');
    expect(textEnd).toEqual({
      type: 'text-end',
      id: 'msg_1',
      provider: { schemaVersion: 1, provider: 'openai', data: { phase: 'commentary' } },
    });

    const source = parts.find((p) => p.type === 'source');
    expect(source?.type === 'source' && source.source.url).toBe('https://example.com/ref');

    expect(parts.filter((p) => p.type === 'tool-input-delta')).toEqual([
      { type: 'tool-input-delta', toolCallId: 'call_alpha', delta: '{"a":' },
      { type: 'tool-input-delta', toolCallId: 'call_beta', delta: '{"b":2}' },
      { type: 'tool-input-delta', toolCallId: 'call_alpha', delta: '1}' },
    ]);

    expect(parts.filter((p) => p.type === 'tool-call')).toEqual([
      {
        type: 'tool-call',
        toolCallId: 'call_alpha',
        toolName: 'tool_a',
        input: '{"a":1}',
        provider: { schemaVersion: 1, provider: 'openai', data: { itemId: 'fc_alpha' } },
      },
      {
        type: 'tool-call',
        toolCallId: 'call_beta',
        toolName: 'tool_b',
        input: '{"b":2}',
        provider: { schemaVersion: 1, provider: 'openai', data: { itemId: 'fc_beta' } },
      },
    ]);

    const finish = parts.at(-1);
    expect(finish).toEqual({
      type: 'finish',
      finishReason: 'tool-calls',
      rawFinishReason: 'completed',
      response: { id: 'resp_1', modelId: 'gpt-5-2026' },
      usage: {
        inputTokens: { value: 1000, provenance: 'provider-reported' },
        outputTokens: { value: 250, provenance: 'provider-reported' },
        cacheReadTokens: { value: 600, provenance: 'provider-reported' },
        reasoningTokens: { value: 100, provenance: 'provider-reported' },
        cacheWriteTokens: { provenance: 'unavailable' },
        cost: { provenance: 'unavailable' },
      },
    });

    // End-to-end round-trip via envelopeToProviderOptions back into step 2 wire input
    const reasoningOpts =
      reasoningEnd?.type === 'reasoning-end'
        ? envelopeToProviderOptions(reasoningEnd.provider)
        : undefined;
    const textOpts =
      textEnd?.type === 'text-end' ? envelopeToProviderOptions(textEnd.provider) : undefined;
    const firstCall = parts.find((p) => p.type === 'tool-call');
    const callOpts =
      firstCall?.type === 'tool-call'
        ? envelopeToProviderOptions(firstCall.provider)
        : undefined;

    const step2Body = buildOpenAiRequestBody({
      modelId: 'gpt-5-2026',
      request: baseRequest({
        messages: [
          { role: 'user', content: 'Hi' },
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: 'Plan: call both tools.',
                providerOptions: reasoningOpts,
              },
              { type: 'text', text: 'Checking now', providerOptions: textOpts },
              {
                type: 'tool-call',
                toolCallId: 'call_alpha',
                toolName: 'tool_a',
                input: { a: 1 },
                providerOptions: callOpts,
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 'call_alpha',
                toolName: 'tool_a',
                output: { type: 'text', value: 'done' },
              },
            ],
          },
        ],
      }),
      policy: resolveOpenAiPolicy({ store: false }),
      cachePerConversation: false,
    });
    expect(step2Body.input).toEqual([
      { role: 'developer', content: 'You are a helpful assistant.' },
      { role: 'user', content: [{ type: 'input_text', text: 'Hi' }] },
      {
        type: 'reasoning',
        id: 'rs_1',
        summary: [{ type: 'summary_text', text: 'Plan: call both tools.' }],
        encrypted_content: 'gAAAA_enc_payload',
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Checking now' }],
        phase: 'commentary',
      },
      {
        type: 'function_call',
        call_id: 'call_alpha',
        name: 'tool_a',
        arguments: '{"a":1}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_alpha',
        output: 'done',
      },
    ]);
  });

  test('emits reasoning-start + reasoning-end for empty summary and backfills encrypted_content from response.completed', async () => {
    // 1. Empty summary with encrypted_content directly in output_item.done
    const emptySummaryParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_silent', summary: [] },
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'rs_silent',
              summary: [],
              encrypted_content: 'enc_silent_123',
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: { id: 'resp_s', status: 'completed', output: [], usage: {} },
          }),
        ]),
      ),
    );
    expect(emptySummaryParts.slice(0, 2)).toEqual([
      { type: 'reasoning-start', id: 'rs_silent' },
      {
        type: 'reasoning-end',
        id: 'rs_silent',
        provider: {
          schemaVersion: 1,
          provider: 'openai',
          data: {
            type: 'reasoning',
            id: 'rs_silent',
            summary: [],
            encrypted_content: 'enc_silent_123',
          },
        },
      },
    ]);

    // 2. encrypted_content missing on output_item.done, backfilled from response.completed.output
    const backfillParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_late', summary: [] },
          }),
          sseEvent('response.reasoning_summary_text.delta', {
            type: 'response.reasoning_summary_text.delta',
            item_id: 'rs_late',
            output_index: 0,
            delta: 'Thinking',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'rs_late',
              summary: [{ type: 'summary_text', text: 'Thinking' }],
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_b',
              status: 'completed',
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_late',
                  summary: [{ type: 'summary_text', text: 'Thinking' }],
                  encrypted_content: 'enc_from_completed',
                },
              ],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          }),
        ]),
      ),
    );
    const reasoningEnds = backfillParts.filter((p) => p.type === 'reasoning-end');
    expect(reasoningEnds).toHaveLength(1);
    expect(reasoningEnds[0]).toEqual({
      type: 'reasoning-end',
      id: 'rs_late',
      provider: {
        schemaVersion: 1,
        provider: 'openai',
        data: {
          type: 'reasoning',
          id: 'rs_late',
          summary: [{ type: 'summary_text', text: 'Thinking' }],
          encrypted_content: 'enc_from_completed',
        },
      },
    });
  });

  test('maps refusal-only to content-filter, response.incomplete to length/content-filter/other, and never emits truncated tool calls on failure', async () => {
    // 1. Refusal-only -> content-filter
    const refusalOnly = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.refusal.delta', {
            type: 'response.refusal.delta',
            delta: 'Cannot.',
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'r1',
              status: 'completed',
              usage: { input_tokens: 5, output_tokens: 2 },
            },
          }),
        ]),
      ),
    );
    expect(refusalOnly.at(-1)?.type === 'finish' && refusalOnly.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'content-filter',
    });

    // Negative control: refusal + normal text stays 'stop'
    const textAndRefusal = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: 0,
            delta: 'Safe answer',
          }),
          sseEvent('response.refusal.delta', {
            type: 'response.refusal.delta',
            delta: 'Partial.',
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'r2',
              status: 'completed',
              usage: { input_tokens: 5, output_tokens: 4 },
            },
          }),
        ]),
      ),
    );
    expect(textAndRefusal.at(-1)?.type === 'finish' && textAndRefusal.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
    });

    // 2. response.incomplete (max_output_tokens -> length, NOT stream-cut; truncated tool NOT emitted)
    const incompleteParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_cut', call_id: 'call_cut', name: 'run' },
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_cut',
            output_index: 0,
            delta: '{"partial":',
          }),
          sseEvent('response.incomplete', {
            type: 'response.incomplete',
            response: {
              id: 'r3',
              status: 'incomplete',
              incomplete_details: { reason: 'max_output_tokens' },
              usage: { input_tokens: 100, output_tokens: 50 },
            },
          }),
        ]),
      ),
    );
    expect(incompleteParts.some((p) => p.type === 'tool-call')).toBe(false);
    expect(incompleteParts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'length',
      rawFinishReason: 'max_output_tokens',
      usage: {
        inputTokens: { value: 100, provenance: 'provider-reported' },
        outputTokens: { value: 50, provenance: 'provider-reported' },
      },
    });

    // 3. response.failed emits error part and suppresses in-progress truncated tool calls
    const failedParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_fail', call_id: 'call_fail', name: 'boom' },
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_fail',
            output_index: 0,
            delta: '{"x":',
          }),
          sseEvent('response.failed', {
            type: 'response.failed',
            response: {
              id: 'r4',
              status: 'failed',
              error: {
                code: 'server_error',
                message: 'Upstream failed with Bearer sk-secret123456789',
              },
            },
          }),
        ]),
      ),
    );
    expect(failedParts.some((p) => p.type === 'tool-call')).toBe(false);
    const errPart = failedParts.at(-1);
    expect(errPart?.type).toBe('error');
    if (errPart?.type === 'error') {
      expect(errPart.error).toBeInstanceOf(AgentProviderError);
      const err = errPart.error;
      if (err instanceof AgentProviderError) {
        expect(err.failureReason).toBe('server-error');
        expect(err.message).not.toContain('sk-secret123456789');
      }
    }

    // 4. Stream ending without terminal event -> AgentProviderStreamCutError
    await expect(
      collectParts(
        decodeOpenAiSseStream(
          sseStreamFromChunks([
            sseEvent('response.output_text.delta', {
              type: 'response.output_text.delta',
              output_index: 0,
              delta: 'cut mid-way',
            }),
          ]),
        ),
      ),
    ).rejects.toBeInstanceOf(AgentProviderStreamCutError);

    // 5. Malformed JSON frame -> AgentProviderStreamCutError
    await expect(
      collectParts(decodeOpenAiSseStream(sseStreamFromChunks(['data: {"truncated"\n\n']))),
    ).rejects.toBeInstanceOf(AgentProviderStreamCutError);

    // 6. response.incomplete with content_filter and unknown reason
    const incompleteFilter = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.incomplete', {
            type: 'response.incomplete',
            response: {
              id: 'r5',
              status: 'incomplete',
              incomplete_details: { reason: 'content_filter' },
              usage: {},
            },
          }),
        ]),
      ),
    );
    expect(incompleteFilter.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'content-filter',
      rawFinishReason: 'content_filter',
    });

    const incompleteOther = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.incomplete', {
            type: 'response.incomplete',
            response: {
              id: 'r6',
              status: 'incomplete',
              incomplete_details: { reason: 'turn_limit' },
              usage: {},
            },
          }),
        ]),
      ),
    );
    expect(incompleteOther.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'other',
      rawFinishReason: 'turn_limit',
    });

    // 7. Top-level SSE `error` event suppresses truncated tool calls and maps code
    const sseErrParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'function_call', id: 'fc_e', call_id: 'call_e', name: 'op' },
          }),
          sseEvent('error', {
            type: 'error',
            code: 'rate_limit_exceeded',
            message: 'Too many requests',
          }),
        ]),
      ),
    );
    expect(sseErrParts.some((p) => p.type === 'tool-call')).toBe(false);
    const sseErr = sseErrParts.at(-1);
    expect(sseErr?.type).toBe('error');
    if (sseErr?.type === 'error' && sseErr.error instanceof AgentProviderError) {
      expect(sseErr.error.failureReason).toBe('rate-limited');
    }

    // 8. reasoning_text.delta + empty function_call arguments default to '{}'
    const reasoningTextAndEmptyArgs = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_raw', summary: [] },
          }),
          sseEvent('response.reasoning_text.delta', {
            type: 'response.reasoning_text.delta',
            item_id: 'rs_raw',
            output_index: 0,
            delta: 'Raw thought',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'reasoning',
              id: 'rs_raw',
              summary: [],
              encrypted_content: 'enc_raw',
            },
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'fc_empty',
              call_id: 'call_empty',
              name: 'ping',
            },
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'fc_empty',
              call_id: 'call_empty',
              name: 'ping',
              arguments: '',
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'r7',
              status: 'completed',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          }),
        ]),
      ),
    );
    expect(reasoningTextAndEmptyArgs.find((p) => p.type === 'reasoning-delta')).toEqual({
      type: 'reasoning-delta',
      id: 'rs_raw',
      delta: 'Raw thought',
    });
    expect(reasoningTextAndEmptyArgs.find((p) => p.type === 'tool-call')).toEqual({
      type: 'tool-call',
      toolCallId: 'call_empty',
      toolName: 'ping',
      input: '{}',
      provider: { schemaVersion: 1, provider: 'openai', data: { itemId: 'fc_empty' } },
    });
  });
});

describe('openai-response usage, error classification, and JSON fallback', () => {
  test('normalizeOpenAiUsage preserves totals, degrades corrupted sub-counters, and never invents zeros', () => {
    expect(
      normalizeOpenAiUsage({
        input_tokens: 500,
        input_tokens_details: { cached_tokens: 200 },
        output_tokens: 120,
        output_tokens_details: { reasoning_tokens: 80 },
      }),
    ).toEqual({
      inputTokens: { value: 500, provenance: 'provider-reported' },
      outputTokens: { value: 120, provenance: 'provider-reported' },
      cacheReadTokens: { value: 200, provenance: 'provider-reported' },
      reasoningTokens: { value: 80, provenance: 'provider-reported' },
      cacheWriteTokens: { provenance: 'unavailable' },
      cost: { provenance: 'unavailable' },
    });

    // Absent usage stays unavailable (never synthetic 0)
    expect(normalizeOpenAiUsage(undefined)).toEqual({
      inputTokens: { provenance: 'unavailable' },
      outputTokens: { provenance: 'unavailable' },
      cacheReadTokens: { provenance: 'unavailable' },
      reasoningTokens: { provenance: 'unavailable' },
      cacheWriteTokens: { provenance: 'unavailable' },
      cost: { provenance: 'unavailable' },
    });

    // Corrupted sub-counters exceeding totals degrade cleanly to unavailable
    const corrupted = normalizeOpenAiUsage({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 500 },
      output_tokens: 50,
      output_tokens_details: { reasoning_tokens: 90 },
    });
    expect(corrupted.cacheReadTokens).toEqual({ provenance: 'unavailable' });
    expect(corrupted.reasoningTokens).toEqual({ provenance: 'unavailable' });
  });

  test('parseOpenAiError maps insufficient_quota on 429 to insufficient-credits and other codes accurately', () => {
    const quota = parseOpenAiError(
      {
        error: {
          message: 'You exceeded your current quota',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      },
      '',
      429,
    );
    expect(quota.failureReason).toBe('insufficient-credits');

    const providerErr = new AgentProviderError(quota.message, {
      provider: 'openai',
      statusCode: 429,
      code: quota.code,
      errorType: quota.errorType,
      failureReason: quota.failureReason,
    });
    expect(classifyProviderFailure(providerErr)).toMatchObject({
      reason: 'insufficient-credits',
      status: 429,
      evidence: 'code',
    });

    expect(
      parseOpenAiError(
        { error: { message: 'Too long', code: 'context_length_exceeded' } },
        '',
        400,
      ).failureReason,
    ).toBe('context-overflow');

    expect(
      parseOpenAiError(
        { error: { message: 'Slow down', code: 'rate_limit_exceeded' } },
        '',
        429,
      ).failureReason,
    ).toBe('rate-limited');

    expect(
      parseOpenAiError(
        { error: { message: 'Internal failure', code: 'server_error' } },
        '',
        500,
      ).failureReason,
    ).toBe('server-error');
  });

  test('decodeOpenAiJsonResponse decodes 200 JSON responses and throws on 200 error envelopes', async () => {
    const parts = await collectParts(
      decodeOpenAiJsonResponse({
        id: 'resp_json_1',
        model: 'gpt-5',
        status: 'completed',
        output: [
          {
            type: 'reasoning',
            id: 'rs_j1',
            summary: [{ type: 'summary_text', text: 'Thought' }],
            encrypted_content: 'enc_j1',
          },
          {
            type: 'message',
            id: 'msg_j1',
            phase: 'final_answer',
            content: [
              {
                type: 'output_text',
                text: 'Done!',
                annotations: [
                  { type: 'url_citation', url: 'https://example.com/a', title: 'A' },
                ],
              },
            ],
          },
        ],
        usage: { input_tokens: 40, output_tokens: 15 },
      }),
    );

    expect(parts.find((p) => p.type === 'text-delta')).toEqual({
      type: 'text-delta',
      id: 'msg_j1',
      delta: 'Done!',
    });
    expect(parts.find((p) => p.type === 'text-end')).toEqual({
      type: 'text-end',
      id: 'msg_j1',
      provider: { schemaVersion: 1, provider: 'openai', data: { phase: 'final_answer' } },
    });
    expect(parts.at(-1)).toMatchObject({
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'completed',
    });

    await expect(
      collectParts(
        decodeOpenAiJsonResponse({
          error: { code: 'insufficient_quota', message: 'Quota exceeded' },
        }),
      ),
    ).rejects.toMatchObject({
      name: 'AgentProviderError',
      failureReason: 'insufficient-credits',
    });
  });
});

describe('openAiProvider HTTP transport & createFaultProviderServer integration', () => {
  test('sends auth/org/project/custom headers, posts to /responses, and refuses redirects', async () => {
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};

    const server = createServer((req, res) => {
      capturedUrl = req.url ?? '';
      capturedHeaders = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') capturedHeaders[k.toLowerCase()] = v;
      }
      const chunks: Uint8Array[] = [];
      req.on('data', (chunk: Uint8Array) => chunks.push(chunk));
      req.on('end', () => {
        const raw = new TextDecoder().decode(
          chunks.reduce((acc, next) => {
            const merged = new Uint8Array(acc.byteLength + next.byteLength);
            merged.set(acc, 0);
            merged.set(next, acc.byteLength);
            return merged;
          }, new Uint8Array()),
        );
        capturedBody = JSON.parse(raw);

        if (capturedBody.metadata && capturedHeaders['x-test-redirect'] === 'yes') {
          res.writeHead(302, { location: 'https://evil.example/steal' });
          res.end();
          return;
        }
        if (capturedHeaders['x-test-quota'] === 'yes') {
          res.writeHead(429, {
            'content-type': 'application/json',
            'retry-after': '7',
            'x-request-id': 'req_quota_1',
          });
          res.end(
            JSON.stringify({
              error: {
                message: 'Quota exceeded for Bearer sk-leaked99999999',
                type: 'insufficient_quota',
                code: 'insufficient_quota',
              },
            }),
          );
          return;
        }

        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          sseEvent('response.created', {
            type: 'response.created',
            response: { id: 'resp_live', model: 'gpt-5' },
          }),
        );
        res.write(
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            output_index: 0,
            delta: 'Hello live!',
          }),
        );
        res.write(
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_live',
              model: 'gpt-5',
              status: 'completed',
              usage: { input_tokens: 12, output_tokens: 4 },
            },
          }),
        );
        res.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');
    const baseUrl = `http://127.0.0.1:${addr.port}/v1/`;

    try {
      const driver = openAiProvider(
        {
          apiKey: 'sk-live-test',
          baseUrl,
          organization: 'org-123',
          project: 'proj-456',
          headers: { 'X-Custom': 'yes' },
          extraBody: { metadata: { env: 'test' } },
        },
        {
          resolvePolicy: (id) =>
            id === 'gpt-5' ? { reasoning: { effort: 'low' } } : undefined,
          cachePerConversation: true,
        },
      ).create('gpt-5');

      const stream = await driver.stream(baseRequest(), new AbortController().signal);
      const parts = await collectParts(stream.parts);

      expect(capturedUrl).toBe('/v1/responses');
      expect(capturedHeaders.authorization).toBe('Bearer sk-live-test');
      expect(capturedHeaders['openai-organization']).toBe('org-123');
      expect(capturedHeaders['openai-project']).toBe('proj-456');
      expect(capturedHeaders['x-custom']).toBe('yes');
      expect(capturedBody.metadata).toEqual({ env: 'test' });
      expect(capturedBody.prompt_cache_key).toBe('conv-1');
      expect(capturedBody.store).toBe(false);
      expect(capturedBody.include).toEqual(['reasoning.encrypted_content']);
      expect(parts.find((p) => p.type === 'text-delta')).toMatchObject({
        delta: 'Hello live!',
      });

      // Quota 429 error carries requestId, retryAfterMs, insufficient-credits, and redacted body
      const quotaDriver = openAiProvider({
        apiKey: 'sk-live-test',
        baseUrl,
        headers: { 'x-test-quota': 'yes' },
      }).create('gpt-5');
      let caughtQuota: unknown;
      try {
        await quotaDriver.stream(baseRequest(), new AbortController().signal);
      } catch (error) {
        caughtQuota = error;
      }
      expect(caughtQuota).toBeInstanceOf(AgentProviderError);
      if (caughtQuota instanceof AgentProviderError) {
        expect(caughtQuota.statusCode).toBe(429);
        expect(caughtQuota.requestId).toBe('req_quota_1');
        expect(caughtQuota.retryAfterMs).toBe(7000);
        expect(caughtQuota.failureReason).toBe('insufficient-credits');
        expect(caughtQuota.message).not.toContain('sk-leaked99999999');
        expect(classifyProviderFailure(caughtQuota).reason).toBe('insufficient-credits');
      }

      // Redirect refusal (redirect: 'error') prevents API key exfiltration
      const redirectDriver = openAiProvider({
        apiKey: 'sk-live-test',
        baseUrl,
        headers: { 'x-test-redirect': 'yes' },
        extraBody: { metadata: { redirect: true } },
      }).create('gpt-5');
      await expect(
        redirectDriver.stream(baseRequest(), new AbortController().signal),
      ).rejects.toThrow();

      // End-to-end 200 application/json fallback via custom fetch
      const jsonFetch: typeof fetch = Object.assign(
        async () =>
          new Response(
            JSON.stringify({
              id: 'resp_json_e2e',
              model: 'gpt-4o',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'msg_e2e',
                  content: [{ type: 'output_text', text: 'JSON fallback OK' }],
                },
              ],
              usage: { input_tokens: 8, output_tokens: 3 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        { preconnect: fetch.preconnect },
      );
      const jsonDriver = openAiProvider(
        { apiKey: 'sk-json', fetch: jsonFetch },
        { defaultPolicy: { strictTools: true } },
      ).create('gpt-4o');
      const jsonStream = await jsonDriver.stream(
        baseRequest({
          tools: [
            {
              name: 'loose_override',
              strict: false,
              inputSchema: {
                type: 'object',
                properties: { a: { type: 'string' }, opt: { type: 'number' } },
                required: ['a'],
              },
            },
          ],
        }),
        new AbortController().signal,
      );
      const jsonParts = await collectParts(jsonStream.parts);
      expect(jsonParts.find((p) => p.type === 'text-delta')).toEqual({
        type: 'text-delta',
        id: 'msg_e2e',
        delta: 'JSON fallback OK',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('handles HTTP errors, bad-json, stream-cut, connection-refused, and timeout via createFaultProviderServer', async () => {
    const server = await createFaultProviderServer({
      scenario: [
        { kind: 'http-error', status: 503 },
        { kind: 'bad-json' },
        { kind: 'stream-cut', afterBytes: 24 },
        { kind: 'connection-refused' },
        { kind: 'timeout-before-first-byte', milliseconds: 5_000 },
        { kind: 'pass', text: 'wrong-protocol' },
      ],
    });

    try {
      const driver = openAiProvider({
        apiKey: 'sk-fault-test',
        baseUrl: server.url,
      }).create('gpt-4o');

      // 1. HTTP 503 -> AgentProviderError classified as server-error
      let err503: unknown;
      try {
        await driver.stream(baseRequest(), new AbortController().signal);
      } catch (error) {
        err503 = error;
      }
      expect(err503).toBeInstanceOf(AgentProviderError);
      expect(classifyProviderFailure(err503)).toMatchObject({
        reason: 'server-error',
        status: 503,
        retryable: true,
      });

      // 2. bad-json -> AgentProviderStreamCutError
      const badJsonStream = await driver.stream(baseRequest(), new AbortController().signal);
      await expect(collectParts(badJsonStream.parts)).rejects.toBeInstanceOf(
        AgentProviderStreamCutError,
      );

      // 3. stream-cut -> classified as stream-cut
      let cutError: unknown;
      try {
        const cutStream = await driver.stream(baseRequest(), new AbortController().signal);
        await collectParts(cutStream.parts);
      } catch (error) {
        cutError = error;
      }
      expect(cutError).toBeDefined();
      expect(classifyProviderFailure(cutError).reason).toBe('stream-cut');

      // 4. connection-refused -> rejects cleanly
      await expect(
        driver.stream(baseRequest(), new AbortController().signal),
      ).rejects.toThrow();

      // 5. timeout-before-first-byte -> aborts on caller signal
      await expect(driver.stream(baseRequest(), AbortSignal.timeout(40))).rejects.toThrow();

      // 6. Negative control: non-Responses SSE (Chat Completions `pass`) fails as stream-cut
      const wrongProtocol = await driver.stream(baseRequest(), new AbortController().signal);
      await expect(collectParts(wrongProtocol.parts)).rejects.toBeInstanceOf(
        AgentProviderStreamCutError,
      );

      expect(server.calls()).toBe(6);
    } finally {
      await server.close();
    }
  });

  test('protocol regressions: store:false drops rs_* without encrypted_content, -chat skips auto-include, resolved mediaType, URL.canParse citation, whitespace args, and multi-text content_index', async () => {
    // 1. store:false drops rs_* reasoning lacking encrypted_content; store:true keeps it
    const reasoningMsg = {
      role: 'assistant' as const,
      content: [
        {
          type: 'reasoning' as const,
          text: 'Internal thought',
          providerOptions: {
            openai: {
              type: 'reasoning',
              id: 'rs_no_enc',
              summary: [{ type: 'summary_text', text: 'Internal thought' }],
            },
          },
        },
        { type: 'text' as const, text: 'Answer' },
      ],
    };
    const statelessBody = buildOpenAiRequestBody({
      modelId: 'gpt-5-mini',
      request: baseRequest({ messages: [{ role: 'user', content: 'hi' }, reasoningMsg] }),
      policy: resolveOpenAiPolicy({ store: false }),
      cachePerConversation: false,
    });
    expect(
      (statelessBody.input as Array<Record<string, unknown>>).some(
        (i) => i.type === 'reasoning',
      ),
    ).toBe(false);

    const statefulBody = buildOpenAiRequestBody({
      modelId: 'gpt-5-mini',
      request: baseRequest({ messages: [{ role: 'user', content: 'hi' }, reasoningMsg] }),
      policy: resolveOpenAiPolicy({ store: true }),
      cachePerConversation: false,
    });
    expect(
      (statefulBody.input as Array<Record<string, unknown>>).some(
        (i) => i.type === 'reasoning' && i.id === 'rs_no_enc',
      ),
    ).toBe(true);

    // 2. -chat models (e.g. gpt-5-chat-latest) do NOT auto-add reasoning.encrypted_content
    const chatModelBody = buildOpenAiRequestBody({
      modelId: 'gpt-5-chat-latest',
      request: baseRequest(),
      policy: resolveOpenAiPolicy({ store: false }),
      cachePerConversation: false,
    });
    expect(chatModelBody.include).toBeUndefined();

    // 3. Resolved data-URL mediaType overrides raw declared mediaType
    const mediaBody = buildOpenAiRequestBody({
      modelId: 'gpt-4.1',
      request: baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'application/octet-stream',
                data: { type: 'data', data: 'data:image/png;base64,AQID' },
              },
              {
                type: 'file',
                mediaType: 'image/png',
                filename: 'doc.pdf',
                data: { type: 'data', data: 'data:application/pdf;base64,JVBERg==' },
              },
            ],
          },
        ],
      }),
      policy: resolveOpenAiPolicy(),
      cachePerConversation: false,
    });
    const userMsg = (
      mediaBody.input as Array<{ role?: string; content?: Array<Record<string, unknown>> }>
    ).find((entry) => entry.role === 'user');
    const userContent = Array.isArray(userMsg?.content) ? userMsg.content : [];
    expect(userContent[0]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,AQID',
    });
    expect(userContent[1]).toEqual({
      type: 'input_file',
      filename: 'doc.pdf',
      file_data: 'data:application/pdf;base64,JVBERg==',
    });

    // 4. Invalid citation URL dropped; valid citation URL kept; whitespace-only args -> '{}'; multi-text content_index
    const sseParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: 'msg_multi', content: [] },
          }),
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_multi',
            output_index: 0,
            content_index: 0,
            delta: 'First',
          }),
          sseEvent('response.output_text.annotation.added', {
            type: 'response.output_text.annotation.added',
            item_id: 'msg_multi',
            output_index: 0,
            annotation: { type: 'url_citation', url: 'not-a-valid-url', title: 'Bad' },
          }),
          sseEvent('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: 'msg_multi',
            output_index: 0,
            content_index: 0,
          }),
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_multi',
            output_index: 0,
            content_index: 1,
            delta: 'Second',
          }),
          sseEvent('response.output_text.done', {
            type: 'response.output_text.done',
            item_id: 'msg_multi',
            output_index: 0,
            content_index: 1,
          }),
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 1,
            item: { type: 'function_call', id: 'fc_ws', call_id: 'call_ws', name: 'noop' },
          }),
          sseEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_ws',
            output_index: 1,
            delta: '   \n\t ',
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              type: 'function_call',
              id: 'fc_ws',
              call_id: 'call_ws',
              name: 'noop',
              arguments: '   ',
            },
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_m',
              status: 'completed',
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          }),
        ]),
      ),
    );

    expect(sseParts.filter((p) => p.type === 'source')).toEqual([]);
    expect(sseParts.filter((p) => p.type === 'text-start').map((p) => p.id)).toEqual([
      'msg_multi:0',
      'msg_multi:1',
    ]);
    expect(sseParts.filter((p) => p.type === 'text-end').map((p) => p.id)).toEqual([
      'msg_multi:0',
      'msg_multi:1',
    ]);
    expect(sseParts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call_ws',
      toolName: 'noop',
      input: '{}',
    });

    // Non-streaming JSON whitespace-only tool args -> '{}' and malformed citation dropped
    const jsonParts = await collectParts(
      decodeOpenAiJsonResponse({
        id: 'resp_jws',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'msg_jws',
            content: [
              {
                type: 'output_text',
                text: 'Hi',
                annotations: [{ type: 'url_citation', url: 'bad url' }],
              },
            ],
          },
          {
            type: 'function_call',
            id: 'fc_jws',
            call_id: 'call_jws',
            name: 'noop',
            arguments: '  \n ',
          },
        ],
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    );
    expect(jsonParts.filter((p) => p.type === 'source')).toEqual([]);
    expect(jsonParts.find((p) => p.type === 'tool-call')).toMatchObject({
      toolCallId: 'call_jws',
      input: '{}',
    });
  });

  test('preserves [reasoning, assistant(message)] Turn 2 order for silent reasoning with response.completed encrypted_content backfill and normalizes MIME', async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const driver = openAiProvider(
      {
        apiKey: 'sk-test',
        fetch: async (_url, init) => {
          callCount += 1;
          capturedBodies.push(JSON.parse(String(init?.body ?? '{}')));
          if (callCount === 1) {
            return new Response(
              sseStreamFromChunks([
                sseEvent('response.created', {
                  type: 'response.created',
                  response: { id: 'resp_t1', model: 'gpt-5', created_at: 1_700_000_000 },
                }),
                sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: 0,
                  item: { type: 'reasoning', id: 'rs_silent_order', summary: [] },
                }),
                sseEvent('response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: 0,
                  item: { type: 'reasoning', id: 'rs_silent_order', summary: [] },
                }),
                sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  output_index: 1,
                  item: { type: 'message', id: 'msg_t1', content: [] },
                }),
                sseEvent('response.output_text.delta', {
                  type: 'response.output_text.delta',
                  item_id: 'msg_t1',
                  output_index: 1,
                  content_index: 0,
                  delta: 'Turn 1 answer',
                }),
                sseEvent('response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: 1,
                  item: {
                    type: 'message',
                    id: 'msg_t1',
                    content: [{ type: 'output_text', text: 'Turn 1 answer' }],
                  },
                }),
                sseEvent('response.completed', {
                  type: 'response.completed',
                  response: {
                    id: 'resp_t1',
                    status: 'completed',
                    output: [
                      {
                        type: 'reasoning',
                        id: 'rs_silent_order',
                        summary: [],
                        encrypted_content: 'enc_turn1_blob',
                      },
                      {
                        type: 'message',
                        id: 'msg_t1',
                        content: [{ type: 'output_text', text: 'Turn 1 answer' }],
                      },
                    ],
                    usage: { input_tokens: 12, output_tokens: 8 },
                  },
                }),
              ]),
              { status: 200, headers: { 'content-type': 'text/event-stream' } },
            );
          }
          return new Response(
            sseStreamFromChunks([
              sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: 'msg_t2',
                output_index: 0,
                content_index: 0,
                delta: 'Turn 2 answer',
              }),
              sseEvent('response.completed', {
                type: 'response.completed',
                response: {
                  id: 'resp_t2',
                  status: 'completed',
                  output: [
                    {
                      type: 'message',
                      id: 'msg_t2',
                      content: [{ type: 'output_text', text: 'Turn 2 answer' }],
                    },
                  ],
                  usage: { input_tokens: 20, output_tokens: 5 },
                },
              }),
            ]),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
      { defaultPolicy: { store: false } },
    ).create('gpt-5');

    // Verify raw SSE event order emits reasoning-start BEFORE text-start and emits exactly one reasoning-start/end
    const rawParts = await collectParts(
      decodeOpenAiSseStream(
        sseStreamFromChunks([
          sseEvent('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_silent_order', summary: [] },
          }),
          sseEvent('response.output_item.done', {
            type: 'response.output_item.done',
            output_index: 0,
            item: { type: 'reasoning', id: 'rs_silent_order', summary: [] },
          }),
          sseEvent('response.output_text.delta', {
            type: 'response.output_text.delta',
            item_id: 'msg_t1',
            output_index: 1,
            content_index: 0,
            delta: 'Hi',
          }),
          sseEvent('response.completed', {
            type: 'response.completed',
            response: {
              id: 'resp_raw',
              status: 'completed',
              output: [
                {
                  type: 'reasoning',
                  id: 'rs_silent_order',
                  summary: [],
                  encrypted_content: 'enc_raw_blob',
                },
              ],
              usage: { input_tokens: 5, output_tokens: 3 },
            },
          }),
        ]),
      ),
    );
    const rStartIdx = rawParts.findIndex((p) => p.type === 'reasoning-start');
    const tStartIdx = rawParts.findIndex((p) => p.type === 'text-start');
    expect(rStartIdx).toBeGreaterThanOrEqual(0);
    expect(tStartIdx).toBeGreaterThan(rStartIdx);
    expect(rawParts.filter((p) => p.type === 'reasoning-start')).toHaveLength(1);
    expect(rawParts.filter((p) => p.type === 'reasoning-end')).toHaveLength(1);

    // End-to-end Turn 1 -> Turn 2 through completeText
    const turn1 = await completeText({ driver, prompt: 'First question' });
    expect(turn1.text).toBe('Turn 1 answer');
    const turn2 = await completeText({
      driver,
      messages: [
        { role: 'user', content: 'First question' },
        ...turn1.responseMessages,
        { role: 'user', content: 'Follow up' },
      ],
    });
    expect(turn2.text).toBe('Turn 2 answer');
    const turn2Input = (capturedBodies[1]?.input ?? []) as Array<Record<string, unknown>>;
    expect(turn2Input.map((item) => item.type ?? item.role)).toEqual([
      'user',
      'reasoning',
      'assistant',
      'user',
    ]);
    expect(turn2Input[1]).toEqual({
      type: 'reasoning',
      id: 'rs_silent_order',
      summary: [],
      encrypted_content: 'enc_turn1_blob',
    });
    expect(turn2Input[2]).toEqual({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Turn 1 answer' }],
    });

    // normalizeMime handles uppercase + parameters + image/jpg in Responses API media encoding
    const mimeBody = buildOpenAiRequestBody({
      modelId: 'gpt-5',
      request: baseRequest({
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'file',
                mediaType: 'IMAGE/JPG; charset=binary',
                data: { type: 'data', data: 'AQID' },
              },
            ],
          },
        ],
      }),
      policy: resolveOpenAiPolicy({ store: false }),
      cachePerConversation: false,
    });
    const mediaUser = (mimeBody.input as Array<{ content: unknown[] }>)[1];
    expect(mediaUser?.content).toEqual([
      { type: 'input_image', image_url: 'data:image/jpeg;base64,AQID' },
    ]);
  });

  test('parseOpenAiError uses Map lookup so Object.prototype keys never leak into failureReason', () => {
    for (const [code, type] of [
      ['constructor', 'toString'],
      ['__proto__', 'valueOf'],
      ['hasOwnProperty', 'isPrototypeOf'],
    ] as const) {
      const parsed = parseOpenAiError(
        { error: { code, type, message: 'proto check' } },
        '',
        400,
      );
      expect(parsed.code).toBe(code);
      expect(parsed.errorType).toBe(type);
      expect(parsed.failureReason).toBeUndefined();
    }

    // Positive controls: canonical codes/types map accurately and case-insensitively
    expect(
      parseOpenAiError({ error: { code: 'insufficient_quota', message: 'quota' } }, '', 429)
        .failureReason,
    ).toBe('insufficient-credits');
    expect(
      parseOpenAiError({ error: { type: 'rate_limit_error', message: 'slow' } }, '', 429)
        .failureReason,
    ).toBe('rate-limited');
    expect(
      parseOpenAiError({ error: { code: 'MODEL_NOT_FOUND', message: 'missing' } }, '', 404)
        .failureReason,
    ).toBe('model-unavailable');
  });

  test('decodeOpenAiSseStream wraps mid-stream socket errors in retryable AgentProviderStreamCutError while preserving aborts and refusing blank apiKey', async () => {
    const encoder = new TextEncoder();
    const socketCause = new TypeError('The socket was closed unexpectedly');
    const brokenStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            sseEvent('response.created', {
              type: 'response.created',
              response: { id: 'resp_cut', model: 'gpt-5' },
            }) +
              sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                item_id: 'msg_1',
                output_index: 0,
                content_index: 0,
                delta: 'partial',
              }),
          ),
        );
        controller.error(socketCause);
      },
    });

    let caught: unknown;
    try {
      await collectParts(decodeOpenAiSseStream(brokenStream));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentProviderStreamCutError);
    if (caught instanceof AgentProviderStreamCutError) {
      expect(caught.provider).toBe('openai');
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
      await collectParts(decodeOpenAiSseStream(abortStream));
    } catch (error) {
      caughtAbort = error;
    }
    expect(caughtAbort).toBe(abortErr);
    expect(caughtAbort).not.toBeInstanceOf(AgentProviderStreamCutError);

    // Negative control 2: aborted signal rethrows without wrapping as stream-cut
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const cancelledStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('socket closed on abort'));
      },
    });
    let caughtCancelled: unknown;
    try {
      await collectParts(decodeOpenAiSseStream(cancelledStream, ac.signal));
    } catch (error) {
      caughtCancelled = error;
    }
    expect(caughtCancelled).not.toBeInstanceOf(AgentProviderStreamCutError);

    // Negative control 3: parseSseJson StreamCutError and AgentProviderError pass through without double-wrapping
    const malformedStream = sseStreamFromChunks(['data: {not-json\n\n']);
    let caughtMalformed: unknown;
    try {
      await collectParts(decodeOpenAiSseStream(malformedStream));
    } catch (error) {
      caughtMalformed = error;
    }
    expect(caughtMalformed).toBeInstanceOf(AgentProviderStreamCutError);
    if (caughtMalformed instanceof AgentProviderStreamCutError) {
      expect(caughtMalformed.message).toContain('malformed or truncated JSON');
    }

    const providerErr = new AgentProviderError('explicit provider fault', {
      provider: 'openai',
    });
    const providerErrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(providerErr);
      },
    });
    let caughtProviderErr: unknown;
    try {
      await collectParts(decodeOpenAiSseStream(providerErrStream));
    } catch (error) {
      caughtProviderErr = error;
    }
    expect(caughtProviderErr).toBe(providerErr);
    expect(caughtProviderErr).not.toBeInstanceOf(AgentProviderStreamCutError);

    // Blank apiKey fails fast with TypeError before HTTP; surrounding whitespace is trimmed
    const seenAuths: Array<string | null> = [];
    let fetchCalls = 0;
    const mockFetch: typeof fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCalls += 1;
        seenAuths.push(new Headers(init?.headers).get('authorization'));
        return new Response(
          sseStreamFromChunks([
            sseEvent('response.completed', {
              type: 'response.completed',
              response: {
                id: 'resp_trim',
                status: 'completed',
                output: [],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            }),
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      },
      { preconnect: () => undefined },
    );

    await expect(
      openAiProvider({ apiKey: '', fetch: mockFetch })
        .create('gpt-5')
        .stream(baseRequest(), new AbortController().signal),
    ).rejects.toThrow(TypeError);
    await expect(
      openAiProvider({ apiKey: () => '   ', fetch: mockFetch })
        .create('gpt-5')
        .stream(baseRequest(), new AbortController().signal),
    ).rejects.toThrow(TypeError);
    expect(fetchCalls).toBe(0);

    await collectParts(
      (
        await openAiProvider({ apiKey: '  sk-openai-trim  ', fetch: mockFetch })
          .create('gpt-5')
          .stream(baseRequest(), new AbortController().signal)
      ).parts,
    );
    expect(seenAuths).toEqual(['Bearer sk-openai-trim']);
  });
});
