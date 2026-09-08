import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** Two steps: a tool call, then an answer. */
function twoStepModel() {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      const chunks: Record<string, unknown>[] =
        call % 2 === 1
          ? [
              { type: 'tool-call', toolCallId: `call-${call}`, toolName: 'echo', input: '{}' },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ]
          : [
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'done' },
              { type: 'text-end', id: 't' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ];
      return { stream: simulateReadableStream({ chunks } as never) };
    },
  });
}

describe('the request ledger', () => {
  /**
   * Every step used to write every message of its history; two runs of a
   * conversation wrote the whole history four times. A body is now written
   * once, and each request names its bodies by hash.
   */
  test('writes each message body once across steps and runs, and every request is checkable', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'two-step',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: twoStepModel(),
        }),
      },
      prompt: () => ({
        instructions: 'x',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        echo: tool({ description: 'e', inputSchema: z.object({}), execute: async () => 'ok' }),
      }),
      loop: { maxSteps: 4 },
    });
    for (const key of ['one', 'two']) {
      const result = await runtime.submit({
        conversationId: 'ledger',
        idempotencyKey: key,
        context: {},
        parts: [{ type: 'text', text: `ask ${key}` }],
      }).result;
      expect(result.reason).toBe('success');
    }
    const events = (await store.readEvents({ conversationId: 'ledger', limit: 1_000 })).items;
    const bodies = events.filter((event) => event.kind === 'provider/message');
    const requests = events.filter((event) => event.kind === 'provider/request');
    // Two runs × two steps.
    expect(requests).toHaveLength(4);
    // Distinct bodies only: the shas across all requests, deduplicated, equal the bodies written.
    const shas = new Set(
      requests.flatMap((event) => (event.payload as { messageShas: string[] }).messageShas),
    );
    expect(bodies.map((event) => (event.payload as { sha256: string }).sha256).sort()).toEqual(
      [...shas].sort(),
    );
    // Written once each, and fewer than the sum over requests.
    expect(bodies).toHaveLength(shas.size);
    expect(shas.size).toBeLessThan(
      requests.reduce(
        (n, event) => n + (event.payload as { messageShas: string[] }).messageShas.length,
        0,
      ),
    );
    // Every request's body hash is reproducible from its parts.
    for (const event of requests) {
      const payload = event.payload as {
        instructionsSha256: string;
        messageShas: string[];
        bodySha256: string;
        attempt: number;
        stepNumber: number;
      };
      const expected = createHash('sha256')
        .update(payload.instructionsSha256)
        .update(payload.messageShas.join(','))
        .digest('hex');
      expect(payload.bodySha256).toBe(expected);
      expect(payload.attempt).toBe(1);
    }
    expect(
      requests.map((event) => (event.payload as { stepNumber: number }).stepNumber),
    ).toEqual([0, 1, 0, 1]);
    // Checkpoint transitions carry a hash of the draft, not the draft.
    const checkpoints = events.filter(
      (event) =>
        event.kind === 'runtime/transition' &&
        (event.payload as { type?: string }).type === 'checkpoint',
    );
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const event of checkpoints) {
      const assistant = (event.payload as { input: { assistant: Record<string, unknown> } })
        .input.assistant;
      expect(Object.keys(assistant).sort()).toEqual([
        'bytes',
        'id',
        'parts',
        'sha256',
        'status',
      ]);
    }
    await runtime.close();
  });

  test('a binary part is recorded by hash and size, not as bytes', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: new MockLanguageModelV4({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: 'seen' },
                  { type: 'text-end', id: 't' },
                  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
                ],
              } as never),
            }),
          }),
        }),
      },
      prompt: () => ({
        instructions: 'x',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      history: {
        project: () => [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              {
                type: 'file',
                data: new Uint8Array(4_096),
                mediaType: 'application/octet-stream',
              },
            ],
          },
        ],
      },
    });
    await runtime.submit({
      conversationId: 'binary',
      idempotencyKey: 'b-1',
      context: {},
      parts: [{ type: 'text', text: 'look' }],
    }).result;
    const bodies = (
      await store.readEvents({ conversationId: 'binary', limit: 100 })
    ).items.filter((event) => event.kind === 'provider/message');
    const text = JSON.stringify(bodies.map((event) => event.payload));
    expect(text).toContain('"binary":true');
    expect(text).toContain('"bytes":4096');
    expect(text.length).toBeLessThan(2_000);
    await runtime.close();
  });

  test('a prepareStep instruction override is what the record hashes', async () => {
    const store = createMemoryAgentRuntimeStore();
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: new MockLanguageModelV4({
            doStream: async () => ({
              stream: simulateReadableStream({
                chunks: [
                  { type: 'text-start', id: 't' },
                  { type: 'text-delta', id: 't', delta: 'ok' },
                  { type: 'text-end', id: 't' },
                  { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
                ],
              } as never),
            }),
          }),
        }),
      },
      prompt: () => ({
        instructions: 'composed',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      loop: { prepareStep: () => ({ instructions: 'overridden by prepareStep' }) as never },
    });
    await runtime.submit({
      conversationId: 'override',
      idempotencyKey: 'o-1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
    const request = (
      await store.readEvents({ conversationId: 'override', limit: 100 })
    ).items.find((event) => event.kind === 'provider/request');
    const sha = (request?.payload as { instructionsSha256?: string } | undefined)
      ?.instructionsSha256;
    expect(sha).toBe(createHash('sha256').update('overridden by prepareStep').digest('hex'));
    expect(sha).not.toBe(createHash('sha256').update('composed').digest('hex'));
    await runtime.close();
  });
});
