import { describe, expect, test } from 'bun:test';
import { type LanguageModel, type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type {
  AgentModelRequest,
  AgentModelStreamPart,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel, fromAiSdkTools } from '../src/entrypoints/agent-runtime/ai-sdk';

type LanguageModelV4 = Extract<Exclude<LanguageModel, string>, { specificationVersion: 'v4' }>;
type LanguageModelV4CallOptions = Parameters<LanguageModelV4['doStream']>[0];
type LanguageModelV4StreamPart =
  Awaited<ReturnType<LanguageModelV4['doStream']>>['stream'] extends ReadableStream<infer P>
    ? P
    : never;

function createStubV4Model(streamParts: readonly LanguageModelV4StreamPart[]): {
  model: LanguageModelV4;
  calls: LanguageModelV4CallOptions[];
} {
  const calls: LanguageModelV4CallOptions[] = [];
  const model: LanguageModelV4 = {
    specificationVersion: 'v4',
    provider: 'stub-v4',
    modelId: 'stub-model-4',
    supportedUrls: {},
    async doGenerate() {
      throw new Error('doGenerate should not be called by fromAiSdkModel');
    },
    async doStream(options) {
      calls.push(options);
      const stream = new ReadableStream<LanguageModelV4StreamPart>({
        start(controller) {
          for (const part of streamParts) {
            controller.enqueue(part);
          }
          controller.close();
        },
      });
      return { stream };
    },
  };
  return { model, calls };
}

describe('stitchkit/agent-runtime/ai-sdk adapter', () => {
  test('fromAiSdkModel rejects non-v4 LanguageModel with TypeError', () => {
    const stringModel: LanguageModel = 'openai/gpt-4o';
    expect(() => fromAiSdkModel(stringModel)).toThrow(TypeError);
  });

  test('fromAiSdkModel converts multimodal files, native V4 tool content files, approvals, and responseFormat', async () => {
    const imageBytes = new Uint8Array([1, 2, 3, 4]);
    const imageUrl = new URL('https://example.com/photo.png');
    const toolFileUrl = new URL('https://example.com/doc.pdf');

    const { model, calls } = createStubV4Model([
      {
        type: 'response-metadata',
        id: 'v4-resp-1',
        modelId: 'stub-model-4',
        timestamp: new Date('2026-01-01T00:00:00Z'),
      },
      {
        type: 'reasoning-start',
        id: 'r1',
        providerMetadata: { anthropic: { signature: 'sig-r1' } },
      },
      { type: 'reasoning-delta', id: 'r1', delta: 'pondering' },
      {
        type: 'reasoning-end',
        id: 'r1',
        providerMetadata: { anthropic: { signature: 'sig-r1-end' } },
      },
      {
        type: 'reasoning-file',
        mediaType: 'image/png',
        data: { type: 'data', data: imageBytes },
        providerMetadata: { google: { token: 'rf-1' } },
      },
      { type: 'text-start', id: 't1', providerMetadata: { stub: { block: 1 } } },
      { type: 'text-delta', id: 't1', delta: 'hello' },
      { type: 'text-end', id: 't1' },
      { type: 'tool-input-start', id: 'tc-1', toolName: 'search' },
      { type: 'tool-input-delta', id: 'tc-1', delta: '{"q":"a"}' },
      { type: 'tool-input-end', id: 'tc-1' },
      {
        type: 'tool-call',
        toolCallId: 'tc-1',
        toolName: 'search',
        input: '{"q":"a"}',
        providerExecuted: true,
        providerMetadata: { openai: { itemId: 'item-1' } },
      },
      {
        type: 'tool-result',
        toolCallId: 'tc-1',
        toolName: 'search',
        result: { error: 'rate limited' },
        isError: true,
      },
      {
        type: 'tool-approval-request',
        approvalId: 'apr-srv-1',
        toolCallId: 'tc-srv-2',
      },
      {
        type: 'source',
        sourceType: 'url',
        id: 'src-1',
        url: 'https://example.com/ref',
        title: 'Reference',
      },
      {
        type: 'file',
        mediaType: 'image/png',
        data: { type: 'data', data: 'AQIDBA==' },
      },
      {
        type: 'file',
        mediaType: 'image/webp',
        data: { type: 'url', url: new URL('https://example.com/generated.webp') },
      },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'stop_sequence' },
        usage: {
          inputTokens: { total: 50, noCache: 30, cacheRead: 20, cacheWrite: 0 },
          outputTokens: { total: 25, text: 20, reasoning: 5 },
        },
        providerMetadata: { gateway: { upstream: 'upstream-east' } },
      },
    ]);

    const driver = fromAiSdkModel(model, {
      normalizeUsage: ({ usage }) => ({
        inputTokens: { value: usage.inputTokens ?? 0, provenance: 'provider-reported' },
        outputTokens: { value: usage.outputTokens ?? 0, provenance: 'provider-reported' },
        reasoningTokens: {
          value: usage.outputTokenDetails.reasoningTokens ?? 0,
          provenance: 'provider-reported',
        },
        cacheReadTokens: {
          value: usage.inputTokenDetails.cacheReadTokens ?? 0,
          provenance: 'provider-reported',
        },
      }),
      resolveResponseProvider: ({ providerMetadata }) => {
        if (
          typeof providerMetadata === 'object' &&
          providerMetadata !== null &&
          'gateway' in providerMetadata
        ) {
          const gw = providerMetadata.gateway;
          if (
            typeof gw === 'object' &&
            gw !== null &&
            'upstream' in gw &&
            typeof gw.upstream === 'string'
          ) {
            return gw.upstream;
          }
        }
        return undefined;
      },
    });

    const request: AgentModelRequest = {
      instructions: [{ role: 'system', content: 'Be helpful.' }],
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect these files' },
            {
              type: 'file',
              data: { type: 'data', data: imageBytes },
              mediaType: 'image/png',
              filename: 'raw.png',
            },
            { type: 'file', data: { type: 'url', url: imageUrl }, mediaType: 'image/png' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'first thought' },
            {
              type: 'reasoning-file',
              data: { type: 'data', data: imageBytes },
              mediaType: 'image/png',
            },
            {
              type: 'tool-call',
              toolCallId: 'c1',
              toolName: 'file_view',
              input: { path: 'a.pdf' },
            },
            // Client-only approval request must be stripped on the V4 wire.
            { type: 'tool-approval-request', approvalId: 'client-apr', toolCallId: 'c2' },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c1',
              toolName: 'file_view',
              output: {
                type: 'content',
                value: [
                  { type: 'text', text: 'Rendered page 1' },
                  {
                    type: 'file',
                    data: { type: 'data', data: imageBytes },
                    mediaType: 'image/png',
                    filename: 'p1.png',
                  },
                  {
                    type: 'file',
                    data: { type: 'url', url: toolFileUrl },
                    mediaType: 'application/pdf',
                  },
                ],
              },
            },
            // Client-only approval response must be skipped; provider-executed must stay.
            {
              type: 'tool-approval-response',
              approvalId: 'client-apr',
              approved: true,
            },
            {
              type: 'tool-approval-response',
              approvalId: 'provider-apr',
              approved: false,
              reason: 'denied',
              providerExecuted: true,
            },
          ],
        },
        // Message that becomes empty after stripping client-only approval response must be skipped.
        {
          role: 'tool',
          content: [
            {
              type: 'tool-approval-response',
              approvalId: 'client-only-msg',
              approved: true,
            },
          ],
        },
      ],
      tools: [
        {
          name: 'file_view',
          description: 'View a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          strict: true,
        },
      ],
      toolChoice: { type: 'tool', toolName: 'file_view' },
      responseFormat: {
        type: 'json-schema',
        name: 'summary',
        description: 'Structured summary',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        strict: true,
      },
      settings: {
        maxOutputTokens: 512,
        temperature: 0.2,
        topP: 0.85,
        topK: 40,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        seed: 99,
        stopSequences: ['END'],
      },
      providerOptions: { stub: { mode: 'fast' } },
      correlation: { conversationId: 'c', runId: 'r', attemptId: 'a', step: 0 },
    };

    const stream = await driver.stream(request, new AbortController().signal);
    const parts: AgentModelStreamPart[] = [];
    for await (const part of stream.parts) {
      parts.push(part);
    }

    // Verify V4 call options sent to the model.
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.maxOutputTokens).toBe(512);
    expect(call?.temperature).toBe(0.2);
    expect(call?.topP).toBe(0.85);
    expect(call?.topK).toBe(40);
    expect(call?.seed).toBe(99);
    expect(call?.stopSequences).toEqual(['END']);
    expect(call?.toolChoice).toEqual({ type: 'tool', toolName: 'file_view' });
    expect(call?.responseFormat).toEqual({
      type: 'json',
      name: 'summary',
      description: 'Structured summary',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
    });

    // Prompt has 4 messages: system, user, assistant, tool (the 2nd tool msg was stripped as empty).
    expect(call?.prompt).toHaveLength(4);
    const userMsg = call?.prompt[1];
    expect(userMsg?.role).toBe('user');
    if (userMsg?.role === 'user') {
      const urlFilePart = userMsg.content[2];
      expect(urlFilePart?.type).toBe('file');
      if (urlFilePart?.type === 'file') {
        expect(urlFilePart.data).toEqual({ type: 'url', url: imageUrl });
      }
    }

    const assistantMsg = call?.prompt[2];
    expect(assistantMsg?.role).toBe('assistant');
    if (assistantMsg?.role === 'assistant') {
      // Client-only tool-approval-request was stripped; reasoning, reasoning-file, tool-call stay.
      expect(assistantMsg.content.map((p) => p.type)).toEqual([
        'reasoning',
        'reasoning-file',
        'tool-call',
      ]);
    }

    const toolMsg = call?.prompt[3];
    expect(toolMsg?.role).toBe('tool');
    if (toolMsg?.role === 'tool') {
      expect(toolMsg.content).toHaveLength(2);
      const toolResultPart = toolMsg.content[0];
      expect(toolResultPart?.type).toBe('tool-result');
      if (toolResultPart?.type === 'tool-result' && toolResultPart.output.type === 'content') {
        // Native V4 `{ type: 'file', data, mediaType }` preserved (zero deprecated types).
        expect(toolResultPart.output.value).toEqual([
          { type: 'text', text: 'Rendered page 1' },
          {
            type: 'file',
            data: { type: 'data', data: imageBytes },
            mediaType: 'image/png',
            filename: 'p1.png',
          },
          {
            type: 'file',
            data: { type: 'url', url: toolFileUrl },
            mediaType: 'application/pdf',
          },
        ]);
      }
      const approvalPart = toolMsg.content[1];
      expect(approvalPart).toEqual({
        type: 'tool-approval-response',
        approvalId: 'provider-apr',
        approved: false,
        reason: 'denied',
      });
    }

    // Verify mapped stream parts.
    const finish = parts.find((p) => p.type === 'finish');
    expect(finish?.type).toBe('finish');
    if (finish?.type === 'finish') {
      expect(finish.finishReason).toBe('stop');
      expect(finish.rawFinishReason).toBe('stop_sequence');
      expect(finish.responseProvider).toBe('upstream-east');
      expect(finish.usage.inputTokens).toEqual({ value: 50, provenance: 'provider-reported' });
      expect(finish.usage.reasoningTokens).toEqual({
        value: 5,
        provenance: 'provider-reported',
      });
      expect(finish.usage.cacheReadTokens).toEqual({
        value: 20,
        provenance: 'provider-reported',
      });
    }

    const reasoningFile = parts.find((p) => p.type === 'reasoning-file');
    expect(reasoningFile?.type).toBe('reasoning-file');
    if (reasoningFile?.type === 'reasoning-file') {
      expect(reasoningFile.data).toEqual({ type: 'data', data: imageBytes });
    }

    const generatedFiles = parts.filter((p) => p.type === 'file');
    expect(generatedFiles).toHaveLength(2);
    if (generatedFiles[0]?.type === 'file') {
      expect(generatedFiles[0].data).toEqual({ type: 'data', data: 'AQIDBA==' });
    }
    if (generatedFiles[1]?.type === 'file') {
      expect(generatedFiles[1].data).toEqual({
        type: 'url',
        url: new URL('https://example.com/generated.webp'),
      });
    }

    const toolResPart = parts.find((p) => p.type === 'tool-result');
    expect(toolResPart?.type).toBe('tool-result');
    if (toolResPart?.type === 'tool-result') {
      expect(toolResPart.providerExecuted).toBe(true);
      expect(toolResPart.isError).toBe(true);
    }

    const aprPart = parts.find((p) => p.type === 'tool-approval-request');
    expect(aprPart).toEqual({
      type: 'tool-approval-request',
      approvalId: 'apr-srv-1',
      toolCallId: 'tc-srv-2',
    });
  });

  test('fromAiSdkTools rejects provider-defined tools and normalizes all legacy content output parts', async () => {
    const providerToolSet: ToolSet = {
      web_search: {
        type: 'provider',
        id: 'openai.web_search',
        isProviderExecuted: true,
        inputSchema: z.object({}),
        args: {},
      },
    };
    await expect(fromAiSdkTools(providerToolSet)).rejects.toThrow(TypeError);

    let receivedMsgRoles: string[] = [];
    let inputAvailableSeen: unknown;
    const refPdf: Record<string, string> = { openai: 'ref_pdf_789' };
    const refImg: Record<string, string> = { anthropic: 'ref_img_012' };
    type AiToolModelOutput = Awaited<
      ReturnType<NonNullable<ToolSet[string]['toModelOutput']>>
    >;
    const legacyTool = tool({
      description: 'Emit all deprecated and canonical content part kinds',
      inputSchema: z.object({ query: z.string() }),
      needsApproval: async ({ query }, { messages }) => {
        receivedMsgRoles = messages.map((m) => m.role);
        return query === 'danger';
      },
      onInputAvailable: async ({ input }) => {
        inputAvailableSeen = input;
      },
      execute: async ({ query }) => ({ query }),
      toModelOutput: async (): Promise<AiToolModelOutput> => ({
        type: 'content',
        value: [
          { type: 'text', text: 'summary' },
          {
            type: 'file-data',
            data: 'AQID',
            mediaType: 'application/pdf',
            filename: 'a.pdf',
          },
          { type: 'image-data', data: 'BAUG', mediaType: 'image/png' },
          { type: 'file-url', url: 'https://example.com/a.pdf' },
          { type: 'image-url', url: 'https://example.com/b.png' },
          { type: 'file-id', fileId: 'file_123' },
          { type: 'image-file-id', fileId: { openai: 'file_img_456' } },
          { type: 'file-reference', providerReference: refPdf },
          { type: 'image-file-reference', providerReference: refImg },
        ],
      }),
    });

    const adapted = await fromAiSdkTools({ legacy: legacyTool });
    const entry = adapted.legacy;
    expect(entry).toBeDefined();
    expect(entry?.description).toBe('Emit all deprecated and canonical content part kinds');

    const badParse = await entry?.parseInput?.({ query: 42 });
    expect(badParse?.ok).toBe(false);
    const goodParse = await entry?.parseInput?.({ query: 'danger' });
    expect(goodParse).toEqual({ ok: true, value: { query: 'danger' } });

    const needsApr =
      typeof entry?.needsApproval === 'function'
        ? await entry.needsApproval(
            { query: 'danger' },
            {
              toolCallId: 'call-1',
              messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            },
          )
        : false;
    expect(needsApr).toBe(true);
    expect(receivedMsgRoles).toEqual(['user']);

    await entry?.onInputAvailable?.({
      input: { query: 'ok' },
      toolCallId: 'call-1',
      messages: [],
    });
    expect(inputAvailableSeen).toEqual({ query: 'ok' });

    const out = await entry?.toModelOutput?.({
      toolCallId: 'call-1',
      input: { query: 'ok' },
      output: { query: 'ok' },
    });
    expect(out?.type).toBe('content');
    if (out?.type === 'content') {
      // Every non-text part must be normalized to canonical `{ type: 'file', ... }`.
      const nonText = out.value.filter((p) => p.type !== 'text');
      expect(nonText).toHaveLength(8);
      for (const part of nonText) {
        expect(part.type).toBe('file');
      }
      expect(out.value[0]).toEqual({ type: 'text', text: 'summary' });
      expect(out.value[1]).toEqual({
        type: 'file',
        data: { type: 'data', data: 'AQID' },
        mediaType: 'application/pdf',
        filename: 'a.pdf',
      });
      expect(out.value[2]).toEqual({
        type: 'file',
        data: { type: 'data', data: 'BAUG' },
        mediaType: 'image/png',
      });
      expect(out.value[3]).toEqual({
        type: 'file',
        data: {
          type: 'url',
          url: new URL('https://example.com/a.pdf'),
          originalUrl: 'https://example.com/a.pdf',
        },
        mediaType: 'application/octet-stream',
      });
      expect(out.value[4]).toEqual({
        type: 'file',
        data: {
          type: 'url',
          url: new URL('https://example.com/b.png'),
          originalUrl: 'https://example.com/b.png',
        },
        mediaType: 'image/*',
      });
      expect(out.value[5]).toEqual({
        type: 'file',
        data: { type: 'reference', reference: { default: 'file_123' } },
        mediaType: 'application/octet-stream',
      });
      expect(out.value[6]).toEqual({
        type: 'file',
        data: { type: 'reference', reference: { openai: 'file_img_456' } },
        mediaType: 'image/*',
      });
      expect(out.value[7]).toEqual({
        type: 'file',
        data: { type: 'reference', reference: { openai: 'ref_pdf_789' } },
        mediaType: 'application/octet-stream',
      });
      expect(out.value[8]).toEqual({
        type: 'file',
        data: { type: 'reference', reference: { anthropic: 'ref_img_012' } },
        mediaType: 'image/*',
      });
    }
  });

  test('guards malformed URLs, normalizes legacy media parts, preserves error-text/error-json providerOptions, and checks abort signal', async () => {
    // 1. Legacy `media`, invalid `file-url`/`image-url`, and `error-text`/`error-json` with non-strict providerOptions
    const sdkTools = {
      legacy_media: tool({
        inputSchema: z.object({}),
        execute: async () => 'ok',
        toModelOutput: () =>
          ({
            type: 'content',
            value: [
              { type: 'media', data: 'AQID', mediaType: 'image/webp', filename: 'snap.webp' },
              { type: 'file-url', url: 'not a valid url', mediaType: 'application/pdf' },
              { type: 'image-url', url: '://broken' },
              {
                type: 'file',
                data: { type: 'url', url: 'bad url' },
                mediaType: 'application/pdf',
              },
            ],
          }) as unknown as { type: 'text'; value: string },
      }),
      err_text: tool({
        inputSchema: z.object({}),
        execute: async () => 'fail',
        toModelOutput: () =>
          ({
            type: 'error-text',
            value: 'Permission denied',
            providerOptions: { anthropic: { keep: 'yes', drop: undefined } },
          }) as unknown as { type: 'text'; value: string },
      }),
      err_json: tool({
        inputSchema: z.object({}),
        execute: async () => 'fail',
        toModelOutput: () =>
          ({
            type: 'error-json',
            value: { code: 'DENIED', extra: undefined },
            providerOptions: { openai: { tag: 'x', empty: undefined } },
          }) as unknown as { type: 'text'; value: string },
      }),
      denied_tool: tool({
        inputSchema: z.object({}),
        execute: async () => 'denied',
        toModelOutput: () =>
          ({
            type: 'execution-denied',
            reason: 'User refused',
            providerOptions: { anthropic: { dropped: undefined, ok: true } },
          }) as unknown as { type: 'text'; value: string },
      }),
    };

    const adapted = await fromAiSdkTools(sdkTools);
    const mediaOut = await adapted.legacy_media?.toModelOutput?.({
      toolCallId: 'c1',
      input: {},
      output: 'ok',
    });
    expect(mediaOut).toEqual({
      type: 'content',
      value: [
        {
          type: 'file',
          data: { type: 'data', data: 'AQID' },
          mediaType: 'image/webp',
          filename: 'snap.webp',
        },
      ],
    });

    const errTextOut = await adapted.err_text?.toModelOutput?.({
      toolCallId: 'c2',
      input: {},
      output: 'fail',
    });
    expect(errTextOut).toEqual({
      type: 'error-text',
      value: 'Permission denied',
      providerOptions: { anthropic: { keep: 'yes' } },
    });

    const errJsonOut = await adapted.err_json?.toModelOutput?.({
      toolCallId: 'c3',
      input: {},
      output: 'fail',
    });
    expect(errJsonOut).toEqual({
      type: 'error-json',
      value: { code: 'DENIED' },
      providerOptions: { openai: { tag: 'x' } },
    });

    const deniedOut = await adapted.denied_tool?.toModelOutput?.({
      toolCallId: 'c4',
      input: {},
      output: 'denied',
    });
    expect(deniedOut).toEqual({
      type: 'execution-denied',
      reason: 'User refused',
      providerOptions: { anthropic: { ok: true } },
    });

    // 2. Malformed source.url omitted cleanly + abort signal stops stalled stream
    let streamCancelled = false;
    const model: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'stub',
      modelId: 'stub-1',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('not called');
      },
      async doStream() {
        let sentSource = false;
        return {
          stream: new ReadableStream({
            pull(controller) {
              if (!sentSource) {
                sentSource = true;
                controller.enqueue({
                  type: 'source',
                  sourceType: 'url',
                  id: 'src-bad',
                  url: 'not-a-url',
                  title: 'Broken',
                });
                return;
              }
              return new Promise(() => {
                /* waits for abort */
              });
            },
            cancel() {
              streamCancelled = true;
            },
          }),
        };
      },
    };

    const driver = fromAiSdkModel(model);
    const controller = new AbortController();
    const res = await driver.stream(
      {
        instructions: [],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        settings: {},
        correlation: { conversationId: 'c', runId: 'r', attemptId: 'a', step: 0 },
      },
      controller.signal,
    );
    const iter = res.parts[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: 'source',
      source: { type: 'source', sourceId: 'src-bad', title: 'Broken' },
    });
    const pendingSecond = iter.next();
    controller.abort(new Error('abort ai-sdk stream'));
    await expect(pendingSecond).rejects.toThrow('abort ai-sdk stream');
    expect(streamCancelled).toBe(true);
  });

  test('preserves providerMetadata with undefined keys, handles toModelOutput() => undefined, and never hangs when reader.cancel() stalls on abort', async () => {
    // 1. providerMetadata containing undefined entries must NOT drop valid keys like signature
    const { model: metaModel } = createStubV4Model([
      {
        type: 'reasoning-end',
        id: 'r-undef',
        providerMetadata: {
          anthropic: {
            signature: 'sig-preserved',
            extra: undefined,
            nested: { ok: true, dropped: undefined },
          },
        } as unknown as Record<string, Record<string, never>>,
      },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
      },
    ]);
    const metaStream = await fromAiSdkModel(metaModel).stream(
      {
        instructions: [],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        settings: {},
        correlation: { conversationId: 'c', runId: 'r', attemptId: 'a', step: 0 },
      },
      new AbortController().signal,
    );
    const metaParts: AgentModelStreamPart[] = [];
    for await (const part of metaStream.parts) metaParts.push(part);
    expect(metaParts.find((p) => p.type === 'reasoning-end')).toEqual({
      type: 'reasoning-end',
      id: 'r-undef',
      provider: {
        schemaVersion: 1,
        provider: 'ai-sdk',
        data: {
          anthropic: {
            signature: 'sig-preserved',
            nested: { ok: true },
          },
        },
      },
    });

    // 2. External tool whose toModelOutput() returns undefined normalizes cleanly to empty string
    const adapted = await fromAiSdkTools({
      undef_out: tool({
        inputSchema: z.object({}),
        execute: async () => 'done',
        toModelOutput: () => undefined as unknown as { type: 'text'; value: string },
      }),
    });
    const out = await adapted.undef_out?.toModelOutput?.({
      toolCallId: 'c-undef',
      input: {},
      output: 'done',
    });
    expect(out).toEqual({ type: 'text', value: '' });

    // 3. Uncooperative stream where both pull() and cancel() never resolve rejects promptly on abort
    let cancelInvoked = false;
    const hangingModel: LanguageModelV4 = {
      specificationVersion: 'v4',
      provider: 'stub',
      modelId: 'stub-hang',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('not called');
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            pull() {
              return new Promise(() => {
                /* never resolves */
              });
            },
            cancel() {
              cancelInvoked = true;
              return new Promise(() => {
                /* never settles */
              });
            },
          }),
        };
      },
    };
    const abortCtrl = new AbortController();
    const hangStream = await fromAiSdkModel(hangingModel).stream(
      {
        instructions: [],
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
        settings: {},
        correlation: { conversationId: 'c', runId: 'r', attemptId: 'a', step: 0 },
      },
      abortCtrl.signal,
    );
    const hangIter = hangStream.parts[Symbol.asyncIterator]();
    const pendingRead = hangIter.next();
    abortCtrl.abort(new Error('non-hanging abort'));
    await expect(pendingRead).rejects.toThrow('non-hanging abort');
    expect(cancelInvoked).toBe(true);
  });
});
