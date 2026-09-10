import { describe, expect, test } from 'bun:test';
import { simulateReadableStream, tool } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeStore,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { ownedProviderStream } from '../src/agent-runtime/owned-provider-stream';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

describe('agent runtime provider stream ownership', () => {
  test('aborts before bounded iterator cleanup and preserves the primary failure', async () => {
    const primary = new Error('primary storage failure');
    const cleanup = new Error('reader cancel failure');
    let returned = 0;
    let aborted = 0;
    let secondary: unknown;
    const stream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let delivered = false;
        return {
          async next() {
            if (!delivered) {
              delivered = true;
              return { done: false, value: 'chunk' };
            }
            return new Promise<IteratorResult<string>>(() => undefined);
          },
          async return() {
            returned += 1;
            throw cleanup;
          },
        };
      },
    };

    const consume = async () => {
      for await (const _chunk of ownedProviderStream({
        stream,
        abort: () => {
          aborted += 1;
        },
        onCleanupFailure: (error) => {
          secondary = error;
        },
        cleanupTimeoutMs: 20,
      })) {
        throw primary;
      }
    };

    await expect(consume()).rejects.toBe(primary);
    expect({ aborted, returned, secondary }).toEqual({
      aborted: 1,
      returned: 1,
      secondary: cleanup,
    });
  });

  test('releases a failed stream before another conversation reaches the provider', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const storageFailure = new Error('checkpoint storage failure');
    const terminalFailure = new Error('terminal persistence failure');
    let failNextCheckpoint = false;
    let checkpointFailed = false;
    const store: AgentRuntimeStore = {
      ...durable,
      async checkpointRunAssistant(input) {
        if (
          input.conversationId === 'failed-conversation' &&
          failNextCheckpoint &&
          !checkpointFailed
        ) {
          checkpointFailed = true;
          throw storageFailure;
        }
        return durable.checkpointRunAssistant(input);
      },
      async commitRunTerminal(input) {
        if (input.conversationId === 'failed-conversation') throw terminalFailure;
        return durable.commitRunTerminal(input);
      },
    };

    let providerCalls = 0;
    let providerAborts = 0;
    let toolEffects = 0;
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        providerCalls += 1;
        if (providerCalls === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: 'tool-call', toolCallId: 'effect-1', toolName: 'effect', input: '{}' },
                {
                  type: 'finish',
                  finishReason: { unified: 'tool-calls', raw: undefined },
                  usage,
                },
              ],
            }),
          };
        }
        if (providerCalls === 2) {
          failNextCheckpoint = true;
          return {
            stream: new ReadableStream({
              start(controller) {
                abortSignal?.addEventListener(
                  'abort',
                  () => {
                    providerAborts += 1;
                  },
                  { once: true },
                );
                controller.enqueue({ type: 'stream-start', warnings: [] });
                controller.enqueue({ type: 'text-start', id: 'answer' });
                controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'partial' });
              },
            }),
          };
        }
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'next' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        };
      },
    });
    const runtime = createAgentRuntime({
      protocol,
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'test-model',
            contextWindow: 1_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({
        effect: tool({
          inputSchema: z.object({}),
          execute: () => {
            toolEffects += 1;
            return { ok: true };
          },
        }),
      }),
      loop: { maxSteps: 3, checkpointEveryEvents: 1 },
    });

    const failed = runtime.submit({
      conversationId: 'failed-conversation',
      idempotencyKey: 'failed-input',
      context: {},
      parts: [{ type: 'text', text: 'fail after the effect' }],
      metadata: {},
    });
    await expect(failed.result).rejects.toBe(terminalFailure);
    expect(providerAborts).toBe(1);

    const next = runtime.submit({
      conversationId: 'next-conversation',
      idempotencyKey: 'next-input',
      context: {},
      parts: [{ type: 'text', text: 'continue' }],
      metadata: {},
    });
    expect((await next.result).reason).toBe('success');
    expect(providerCalls).toBe(3);
    expect(toolEffects).toBe(1);
    await runtime.close();
  });
});
