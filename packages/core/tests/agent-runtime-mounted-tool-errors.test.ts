import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentModelDescriptor,
  type AgentModelDriver,
  type AgentModelStreamPart,
  type AgentRuntimeEvent,
  type AgentRuntimeStore,
  type AgentUsage,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import { AppError } from '../src/entrypoints/contract';
import {
  defineRuntimeTool,
  mountAgentTools,
  type RuntimeToolDefinition,
} from '../src/entrypoints/tools';
import { sqliteScratchDir } from './support/sqlite-scratch';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const usage: AgentUsage = {
  inputTokens: { value: 1, provenance: 'provider-reported' },
  outputTokens: { value: 1, provenance: 'provider-reported' },
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

function toolRound(toolName: string): readonly AgentModelStreamPart[] {
  return [
    { type: 'tool-call', toolCallId: 'call-1', toolName, input: '{}' },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ];
}

function textRound(): readonly AgentModelStreamPart[] {
  return [
    { type: 'text-start', id: 'answer' },
    { type: 'text-delta', id: 'answer', delta: 'done' },
    { type: 'text-end', id: 'answer' },
    { type: 'finish', finishReason: 'stop', usage },
  ];
}

function runtimeConfig(
  store: AgentRuntimeStore,
  driver: AgentModelDriver,
  runtimeTools: readonly RuntimeToolDefinition[],
  events: AgentRuntimeEvent[] = [],
) {
  return {
    protocol,
    store,
    models: { resolve: () => ({ descriptor, driver }) },
    prompt: () => ({
      instructions: 'test',
      sections: [],
      instructionTokens: { provenance: 'unavailable' as const },
      contextDecision: 'unavailable' as const,
    }),
    tools: () => mountAgentTools([], { access: { open: 'local-operator' }, runtimeTools }),
    publish: (event: AgentRuntimeEvent) => void events.push(event),
    loop: { maxSteps: 2 },
  };
}

describe('mounted Agent tool error outcomes', () => {
  test('persists one typed failure, publishes it and continues the model after SQLite reopen', async () => {
    const root = await sqliteScratchDir('stitchkit-mounted-error-');
    roots.push(root);
    const filename = path.join(root, 'agent.sqlite');
    const mounted = defineRuntimeTool({
      name: 'guarded_operation',
      description: 'Fail safely',
      identity: { serviceName: 'fixture', action: 'guard', method: 'POST' },
      input: z.object({}),
      handler: () => {
        throw new AppError('CONFLICT', {
          message: 'Selection is stale',
          status: 409,
          details: { revision: 7 },
        });
      },
    });
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'mounted-tool-errors',
      steps: [toolRound('guarded_operation'), textRound()],
    });
    const events: AgentRuntimeEvent[] = [];
    const sqlite = createBunSqliteAgentRuntimeStore({ filename });
    const runtime = createAgentRuntime(runtimeConfig(sqlite.store, driver, [mounted], events));

    const result = await runtime.submit({
      conversationId: 'typed-error',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'run it' }],
      metadata: {},
    }).result;
    const expected = {
      error: 'CONFLICT',
      // 409 is not a retry class: the same call conflicts the same way again.
      retryable: false,
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
    expect(JSON.stringify(driver.requests[1]?.messages)).toContain('CONFLICT');
    expect(JSON.stringify(driver.requests[1]?.messages)).toContain('error-text');
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
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'mounted-tool-errors',
      steps: [toolRound('business_result'), textRound()],
    });
    const runtime = createAgentRuntime(
      runtimeConfig(createMemoryAgentRuntimeStore(), driver, [mounted]),
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
