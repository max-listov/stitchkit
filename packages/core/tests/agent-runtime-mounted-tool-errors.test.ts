import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentModelDescriptor,
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/agent-runtime';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';
import { AppError } from '../src/contract';
import { defineRuntimeTool, mountAgent, type RuntimeToolDefinition } from '../src/tools';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const descriptor: AgentModelDescriptor = {
  provider: 'test',
  modelId: 'mounted-tool-errors',
  contextWindow: 1_000,
  capabilities: ['tools'],
};

const protocol = defineAgentProtocol({
  context: z.object({}),
  inputMetadata: z.object({}),
});

function toolRound(toolName: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: 'tool-call' as const,
          toolCallId: 'call-1',
          toolName,
          input: '{}',
        },
        {
          type: 'finish' as const,
          finishReason: { unified: 'tool-calls' as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function textRound() {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start' as const, id: 'answer' },
        { type: 'text-delta' as const, id: 'answer', delta: 'done' },
        { type: 'text-end' as const, id: 'answer' },
        {
          type: 'finish' as const,
          finishReason: { unified: 'stop' as const, raw: undefined },
          usage,
        },
      ],
    }),
  };
}

function runtimeConfig(
  store: AgentRuntimeStore,
  model: MockLanguageModelV4,
  runtimeTools: readonly RuntimeToolDefinition[],
  events: AgentRuntimeEvent[] = [],
) {
  return {
    protocol,
    store,
    models: { resolve: () => ({ descriptor, model }) },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' as const },
      contextDecision: 'unavailable' as const,
    }),
    tools: () => mountAgent([], { runtimeTools }),
    publish: (event: AgentRuntimeEvent) => void events.push(event),
    loop: { maxSteps: 2 },
  };
}

describe('mounted Agent tool error outcomes', () => {
  test('persists one typed failure, publishes it and continues the model after SQLite reopen', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-mounted-error-'));
    roots.push(root);
    const filename = path.join(root, 'agent.sqlite');
    const mounted = defineRuntimeTool({
      name: 'guarded_operation',
      description: 'Fail safely',
      identity: { serviceName: 'fixture', action: 'guard', method: 'POST' },
      input: z.object({}),
      handler: () => {
        throw new AppError('CONFLICT', 'Selection is stale', 409, { revision: 7 });
      },
    });
    const model = new MockLanguageModelV4({
      doStream: [toolRound('guarded_operation'), textRound()],
    });
    const events: AgentRuntimeEvent[] = [];
    const sqlite = createBunSqliteAgentRuntimeStore({ filename });
    const runtime = createAgentRuntime(runtimeConfig(sqlite.store, model, [mounted], events));

    const result = await runtime.submit({
      conversationId: 'typed-error',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'run it' }],
      metadata: {},
    }).result;
    const expected = {
      error: 'CONFLICT',
      details: { revision: 7 },
    };
    expect(result.message.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        toolName: 'guarded_operation',
        outcome: 'error',
        output: expected,
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool-status',
        toolName: 'guarded_operation',
        status: 'failed',
        output: expected,
      }),
    );
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('CONFLICT');
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain('error-text');
    await runtime.close();
    await sqlite.close();

    const reopened = createBunSqliteAgentRuntimeStore({ filename });
    const snapshot = await reopened.store.loadSnapshot('typed-error');
    expect(snapshot.messages).toContainEqual(
      expect.objectContaining({
        role: 'assistant',
        parts: expect.arrayContaining([
          expect.objectContaining({ outcome: 'error', output: expected }),
        ]),
      }),
    );
    await reopened.close();
  });

  test('does not infer failure from successful business data named error', async () => {
    const mounted = defineRuntimeTool({
      name: 'business_result',
      description: 'Return business data',
      identity: { serviceName: 'fixture', action: 'read', method: 'GET' },
      input: z.object({}),
      output: z.object({ error: z.string(), accepted: z.boolean() }),
      handler: () => ({ error: 'field-value', accepted: true }),
    });
    const model = new MockLanguageModelV4({
      doStream: [toolRound('business_result'), textRound()],
    });
    const runtime = createAgentRuntime(
      runtimeConfig(createMemoryAgentRuntimeStore(), model, [mounted]),
    );
    const result = await runtime.submit({
      conversationId: 'business-error-field',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'run it' }],
      metadata: {},
    }).result;

    expect(result.message.parts).toContainEqual(
      expect.objectContaining({
        type: 'tool-result',
        outcome: 'success',
        output: { error: 'field-value', accepted: true },
      }),
    );
    await runtime.close();
  });
});
