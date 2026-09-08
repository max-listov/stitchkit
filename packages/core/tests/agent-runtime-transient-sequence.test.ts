import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeEvent,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { createAgentControlView, reduceAgentControlEvent } from '../src/agent-runtime-browser';

describe('transient event sequence', () => {
  /**
   * A subscriber's cursor expects the run's transient events numbered 1, 2, 3
   * with nothing missing. An ordinary stream — `text-start`, deltas,
   * `text-end`, `finish` — has parts that publish nothing, so the sequence a
   * subscriber sees must count only what was published, or the first delta
   * of every run arrives as a gap and the control view never accumulates.
   */
  test('published transient events are contiguous from 1, whatever the stream contained', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: 'text-start', id: 't' },
            { type: 'text-delta', id: 't', delta: 'hel' },
            { type: 'text-delta', id: 't', delta: 'lo' },
            { type: 'text-end', id: 't' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: undefined },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 1, text: 1, reasoning: undefined },
              },
            },
          ],
        } as never),
      }),
    });
    const events: AgentRuntimeEvent[] = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'test',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'x',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'unavailable',
      }),
      tools: () => ({}),
      publish: (event) => {
        events.push(event);
      },
    });
    const result = await runtime.submit({
      conversationId: 'seq',
      idempotencyKey: 'seq-1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
    }).result;
    const sequences = events.flatMap((event) => ('sequence' in event ? [event.sequence] : []));
    expect(sequences).toEqual(sequences.map((_, index) => index + 1));
    let view = createAgentControlView();
    for (const event of events) {
      if (event.type === 'terminal') break;
      view = reduceAgentControlEvent(view, event);
    }
    expect(view.conversations.seq?.transientByRun[result.run.id]?.text).toBe('hello');
    await runtime.close();
  });
});
