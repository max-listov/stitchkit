import { expect, test } from 'bun:test';
import { type FilePart, type ModelMessage, simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import type { ProviderJournalContentSchema } from '../src/agent-runtime/provider-content';
import { ProviderJournalMessageSchema } from '../src/agent-runtime/provider-journal';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import { branch } from './support/agent-branch-fixture';

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV4['doStream']>>['stream'] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;

async function runWriter(messages?: ModelMessage[], presenter = false) {
  const store = createMemoryAgentRuntimeStore();
  let calls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const runtime = createAgentRuntime({
    protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    store,
    ...(messages && { history: { project: () => messages } }),
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'test',
          modelId: 'writer-fixture',
          contextWindow: 10000,
          capabilities: [],
        },
        model: new MockLanguageModelV4({
          supportedUrls: { '*': [/^https:\/\/example\.com\//] },
          doStream: async () => {
            calls++;
            const chunks: StreamPart[] =
              presenter && calls === 1
                ? [{ type: 'tool-call', toolCallId: 'call', toolName: 'example', input: '{}' }]
                : [
                    { type: 'text-start', id: 'text' },
                    { type: 'text-delta', id: 'text', delta: 'answer' },
                    { type: 'text-end', id: 'text' },
                  ];
            chunks.push({
              type: 'finish',
              finishReason: {
                unified: presenter && calls === 1 ? 'tool-calls' : 'stop',
                raw: undefined,
              },
              usage,
            });
            return {
              stream: simulateReadableStream({
                chunks,
              }),
            };
          },
        }),
      }),
    },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' },
      contextDecision: 'unavailable',
    }),
    tools: () => ({
      example: tool({
        inputSchema: z.object({}),
        execute: () => ({ value: 'result' }),
        toModelOutput: () => ({
          type: 'content',
          value: [
            { type: 'text', text: 'rendered output' },
            { type: 'file', data: { type: 'data', data: 'aGVsbG8=' }, mediaType: 'image/png' },
          ],
        }),
      }),
    }),
  });
  try {
    const result = await runtime.submit({
      conversationId: 'source',
      idempotencyKey: 'test',
      context: {},
      metadata: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
    expect(result.reason).toBe('success');
    expect(calls).toBe(presenter ? 2 : 1);
    const bytes = await store.exportConversation('source');
    for (const source of [
      { kind: 'conversation', conversationId: 'source' },
      { kind: 'archive', bytes },
    ] satisfies Parameters<typeof branch>[1]['source'][])
      expect(
        (
          await branch(store, {
            requestKey: source.kind,
            destinationConversationId: source.kind,
            source,
          })
        ).outcome,
      ).toBe('created');
  } finally {
    await runtime.close();
  }
}

const files: FilePart['data'][] = [
  'aGVsbG8=',
  { type: 'text', text: 'inline' },
  { type: 'data', data: new Uint8Array([1, 2]) },
  { type: 'url', url: new URL('https://example.com/file') },
  { type: 'reference', reference: { example: 'provider-file' } },
];
for (const [index, data] of files.entries())
  test(`live writer and branch accept SDK file variant ${index}`, async () => {
    await runWriter([
      { role: 'user', content: [{ type: 'file', mediaType: 'text/plain', data }] },
    ]);
  });

test('live writer and branch preserve multimodal tool presenter content on the second step', async () => {
  await runWriter(undefined, true);
});

test('strict serialized provider content covers optional SDK fields without accepting unknown payload fields', () => {
  const parts: z.input<typeof ProviderJournalContentSchema>[] = [
    {
      type: 'custom',
      kind: 'example.custom',
      providerOptions: { example: { data: 'opaque' } },
    },
    {
      type: 'reasoning-file',
      data: { type: 'url', url: 'https://example.com/reasoning' },
      mediaType: 'text/plain',
    },
    {
      type: 'tool-approval-request',
      approvalId: 'approval',
      toolCallId: 'call',
      reason: 'reason',
      signature: 'secret',
      isAutomatic: false,
    },
    {
      type: 'tool-approval-response',
      approvalId: 'approval',
      approved: true,
      providerExecuted: true,
    },
  ];
  const message = { role: 'assistant', content: parts } satisfies z.input<
    typeof ProviderJournalMessageSchema
  >['message'];
  expect(
    ProviderJournalMessageSchema.parse({ sha256: '0'.repeat(64), message }).message,
  ).toEqual(message);
  expect(
    ProviderJournalMessageSchema.safeParse({
      sha256: '0'.repeat(64),
      message: { ...message, unknown: true },
    }).success,
  ).toBe(false);
});
