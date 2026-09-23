import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  type ComposedAgentPrompt,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';

/*
 * A provider cut in the middle of an answer. `doStream()` has already returned,
 * so the failure arrives while the runtime reads the body — and on Bun 1.4 it
 * arrives as a rejected read rather than as an `error` part. The run must still
 * blame the provider, and must not blame it for what the runtime did itself.
 */

const descriptor = {
  provider: 'test',
  modelId: 'test-model',
  contextWindow: 1_000,
  capabilities: [],
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

function prompt(): ComposedAgentPrompt {
  return {
    instructions: 'test',
    sections: [],
    instructionTokens: { provenance: 'unavailable' },
    contextDecision: 'unavailable',
  };
}

/** A model that answers one chunk, then loses the connection on the next read. */
function cutAfterFirstChunk(cause: Error) {
  let pulls = 0;
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue({ type: 'text-start', id: 'answer' });
            controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'partial' });
            return;
          }
          controller.error(cause);
        },
      }),
    }),
  });
}

function run(store: AgentRuntimeStore = createMemoryAgentRuntimeStore()) {
  const events: AgentRuntimeEvent[] = [];
  const runtime = createAgentRuntime({
    protocol,
    store,
    models: {
      resolve: () => ({
        descriptor,
        model: cutAfterFirstChunk(new Error('Failed to process successful response')),
      }),
    },
    prompt,
    tools: () => ({}),
    publish: (event: AgentRuntimeEvent) => {
      events.push(event);
    },
  });
  const submitted = runtime.submit({
    conversationId: 'conversation-1',
    idempotencyKey: 'input-1',
    context: {},
    parts: [{ type: 'text', text: 'hello' }],
    metadata: {},
  });
  return { runtime, submitted };
}

describe('a provider stream cut after doStream returned', () => {
  test('ends the run as provider_failure', async () => {
    const { runtime, submitted } = run();
    expect((await submitted.result).reason).toBe('provider_failure');
    await runtime.close();
  });

  test('a runtime-owned failure during the same read keeps its own class', async () => {
    const durable = createMemoryAgentRuntimeStore();
    const store: AgentRuntimeStore = {
      ...durable,
      recordRunOperation(input) {
        if (input.operation.phase === 'first-output') {
          throw new Error('operation storage unavailable');
        }
        return durable.recordRunOperation(input);
      },
    };
    const { runtime, submitted } = run(store);
    expect((await submitted.result).reason).toBe('runtime_failure');
    await runtime.close();
  });
});
