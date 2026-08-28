import { describe, expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  AgentContextOverflowError,
  type AgentRunEvent,
  AgentRunMetricsSchema,
  AgentRunSchema,
  createAgentObservability,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  runStateForTerminalReason,
} from '../src/agent-runtime';

const at = '2026-08-26T00:00:00.000Z';
const base = {
  schemaVersion: 1,
  id: 'r1',
  conversationId: 'c1',
  inputMessageIds: ['i1'],
  assistantMessageId: 'a1',
  revision: 1,
  createdAt: at,
  updatedAt: at,
};

describe('a run record has to agree with itself', () => {
  test('a state that contradicts its reason is refused', () => {
    expect(() =>
      AgentRunSchema.parse({ ...base, state: 'completed', terminalReason: 'interrupted' }),
    ).toThrow(/ends a run in state/);
    expect(() =>
      AgentRunSchema.parse({ ...base, state: 'interrupted', terminalReason: 'interrupted' }),
    ).not.toThrow();
  });

  test('a terminal state must say why it ended', () => {
    // `canonicalTerminal` reads a missing reason as "not terminal" and the run
    // then fails an unrelated conflict check somewhere else entirely.
    expect(() => AgentRunSchema.parse({ ...base, state: 'completed' })).toThrow(
      /must say why it ended/,
    );
    expect(() => AgentRunSchema.parse({ ...base, state: 'queued' })).not.toThrow();
  });

  test('a queued run cannot carry a terminal reason', () => {
    expect(() =>
      AgentRunSchema.parse({ ...base, state: 'queued', terminalReason: 'success' }),
    ).toThrow();
  });

  test('a policy stop names the policy, which the changelog already promised', () => {
    expect(() =>
      AgentRunSchema.parse({ ...base, state: 'completed', terminalReason: 'policy_stop' }),
    ).toThrow(/names the policy/);
    expect(() =>
      AgentRunSchema.parse({
        ...base,
        state: 'completed',
        terminalReason: 'policy_stop',
        terminalPolicyName: 'max-steps',
      }),
    ).not.toThrow();
  });

  test('every terminal reason maps to a state the schema then accepts', () => {
    // The mapping and the check derive from one statement; this proves they
    // cannot drift, for every member, including any added later.
    for (const reason of [
      'success',
      'policy_stop',
      'provider_stop',
      'interrupted',
      'superseded',
      'cancelled',
      'timeout',
      'shutdown',
      'provider_failure',
      'context_overflow',
      'abandoned',
    ] as const) {
      const state = runStateForTerminalReason(reason);
      expect(() =>
        AgentRunSchema.parse({
          ...base,
          state,
          terminalReason: reason,
          ...(reason === 'policy_stop' && { terminalPolicyName: 'p' }),
        }),
      ).not.toThrow();
    }
  });
});

describe('what a run reports is required on both channels', () => {
  test('metrics without usage are refused', () => {
    expect(() => AgentRunMetricsSchema.parse({ partial: false })).toThrow();
  });
});

describe('a refusal this runtime made does not blame the provider', () => {
  test('an oversized context reports context_overflow', async () => {
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'test',
            modelId: 'm',
            contextWindow: 10,
            capabilities: [],
          },
          model: new MockLanguageModelV4({
            doStream: async () => ({
              stream: simulateReadableStream({ chunks: [] } as never),
            }),
          }),
        }),
      },
      // Refused before any provider call: the record used to say the provider
      // failed, for an upstream that was never contacted.
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'oversized',
      }),
      tools: () => ({}),
    });
    const terminal = await runtime.submit({
      conversationId: 'c1',
      idempotencyKey: 'i1',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await runtime.close();
    expect(terminal.reason).toBe('context_overflow');
    expect(terminal.run.state).toBe('failed');
  });

  test('a typed step refusal agrees across result, durable state, delivery and observability', async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [] } as never) }),
    });
    const store = createMemoryAgentRuntimeStore();
    const delivery: Array<{ type: string; reason?: string }> = [];
    const observed: AgentRunEvent[] = [];
    const observability = createAgentObservability({
      includeInternalCause: true,
      write: (event) => {
        observed.push(event);
      },
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store,
      models: {
        resolve: () => ({
          descriptor: { provider: 'test', modelId: 'm', contextWindow: 10, capabilities: [] },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'fits',
      }),
      tools: () => ({}),
      loop: {
        prepareStep: () => {
          throw new AgentContextOverflowError('step budget exceeded');
        },
      },
      publish: (event) => {
        delivery.push(event);
      },
      observe: observability,
    });

    const terminal = await runtime.submit({
      conversationId: 'typed-refusal',
      idempotencyKey: 'typed-refusal',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await observability.flush();

    expect(model.doStreamCalls).toHaveLength(0);
    expect(terminal.reason).toBe('context_overflow');
    expect(terminal.run.state).toBe('failed');
    expect((await store.loadSnapshot('typed-refusal')).runs[0]?.terminalReason).toBe(
      'context_overflow',
    );
    expect(delivery).toContainEqual(
      expect.objectContaining({ type: 'terminal', reason: 'context_overflow' }),
    );
    expect(observed).toContainEqual(
      expect.objectContaining({ type: 'run-terminal', terminalReason: 'context_overflow' }),
    );
    await runtime.close();
  });

  test('an unexpected step callback error remains provider_failure', async () => {
    const failure = new Error('callback bug');
    const observed: AgentRunEvent[] = [];
    const observability = createAgentObservability({
      includeInternalCause: true,
      write: (event) => {
        observed.push(event);
      },
    });
    const model = new MockLanguageModelV4({
      doStream: async () => ({ stream: simulateReadableStream({ chunks: [] } as never) }),
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({
          descriptor: { provider: 'test', modelId: 'm', contextWindow: 10, capabilities: [] },
          model,
        }),
      },
      prompt: () => ({
        instructions: 'test',
        sections: [],
        instructionTokens: { provenance: 'unavailable' },
        contextDecision: 'fits',
      }),
      tools: () => ({}),
      loop: {
        prepareStep: () => {
          throw failure;
        },
      },
      observe: observability,
    });

    const terminal = await runtime.submit({
      conversationId: 'unexpected-refusal',
      idempotencyKey: 'unexpected-refusal',
      context: {},
      parts: [{ type: 'text', text: 'go' }],
      metadata: {},
    }).result;
    await observability.flush();

    expect(model.doStreamCalls).toHaveLength(0);
    expect(terminal.reason).toBe('provider_failure');
    expect(observed).toContainEqual(
      expect.objectContaining({
        type: 'run-terminal',
        terminalReason: 'provider_failure',
        internalCause: failure,
      }),
    );
    await runtime.close();
  });
});
