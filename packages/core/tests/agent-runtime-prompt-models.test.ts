import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import {
  AgentMessageSchema,
  composeAgentPrompt,
  defineModelRegistry,
  selectAgentHistory,
  validateAgentModelSnapshot,
} from '../src/agent-runtime';

describe('agent prompt and model policy', () => {
  test('keeps unavailable estimates unknown and makes oversize policy explicit', async () => {
    const prompt = composeAgentPrompt([
      {
        name: 'stable',
        stability: 'stable',
        render: () => 'instructions',
        estimateTokens: () => ({ value: 20, provenance: 'measured' }),
      },
    ]);
    const oversized = await prompt({
      context: {},
      signal: new AbortController().signal,
      historyTokens: { value: 91, provenance: 'measured' },
      oversizePolicy: 'compact',
      budget: {
        contextWindow: 100,
        reservedOutput: 10,
        toolSchemas: { value: 5, provenance: 'measured' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { value: 5, provenance: 'estimated' },
      },
    });
    expect(oversized.availableHistoryTokens).toBe(60);
    expect(oversized.contextDecision).toBe('requires-compaction');

    const unknown = await prompt({
      context: {},
      signal: new AbortController().signal,
      historyTokens: { provenance: 'unavailable' },
      budget: {
        contextWindow: 100,
        reservedOutput: 10,
        toolSchemas: { provenance: 'unavailable' },
        attachments: { value: 0, provenance: 'measured' },
        providerOverhead: { value: 5, provenance: 'estimated' },
      },
    });
    expect(unknown.contextDecision).toBe('unavailable');
    expect(unknown.availableHistoryTokens).toBeUndefined();
  });

  test('rejects a model before construction when a required capability is absent', () => {
    let constructed = false;
    const registry = defineModelRegistry({
      providers: {
        test: {
          create: () => {
            constructed = true;
            return new MockLanguageModelV4();
          },
        },
      },
      models: {
        text: {
          provider: 'test',
          modelId: 'text-only',
          contextWindow: 1_000,
          capabilities: [],
        },
      },
    });
    expect(() => registry.resolve('text', ['vision'])).toThrow('required capabilities');
    expect(constructed).toBeFalse();
  });

  test('preserves provider options on structured system instructions', async () => {
    const prompt = composeAgentPrompt([
      { name: 'stable', stability: 'stable', render: () => 'cache me' },
    ]);

    const composed = await prompt({
      context: {},
      signal: new AbortController().signal,
      adaptInstructions: (content) => ({
        role: 'system',
        content,
        providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
      }),
    });

    expect(composed.instructions).toEqual({
      role: 'system',
      content: 'cache me',
      providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  test('removes only whole old turns and explains protected context', async () => {
    const messages = [
      AgentMessageSchema.parse({
        schemaVersion: 1,
        id: 'system',
        conversationId: 'conversation-1',
        role: 'system',
        status: 'committed',
        parts: [{ type: 'text', text: 'rules' }],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      }),
      ...[1, 2].flatMap((index) => [
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: `user-${index}`,
          conversationId: 'conversation-1',
          role: 'user',
          status: 'committed',
          parts: [{ type: 'text', text: `question ${index}` }],
          createdAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
        }),
        AgentMessageSchema.parse({
          schemaVersion: 1,
          id: `assistant-${index}`,
          conversationId: 'conversation-1',
          runId: `run-${index}`,
          role: 'assistant',
          status: 'completed',
          parts: [{ type: 'text', text: `answer ${index}` }],
          createdAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
        }),
      ]),
    ];
    const selected = await selectAgentHistory({
      messages,
      availableTokens: 3,
      keepRecentTurns: 1,
      estimateMessage: () => ({ value: 1, provenance: 'measured' }),
    });

    expect(selected.outcome).toBe('truncated');
    expect(selected.messages.map((message) => message.id)).toEqual([
      'system',
      'user-2',
      'assistant-2',
    ]);
    expect(selected.decisions.find((decision) => decision.messageId === 'user-1')).toEqual({
      messageId: 'user-1',
      action: 'removed',
      reason: 'oldest-eligible-turn',
      tokens: { value: 1, provenance: 'measured' },
    });
  });

  test('publishes versioned model snapshots and rejects stale or unavailable entries', () => {
    const registry = defineModelRegistry({
      providers: { test: { create: () => new MockLanguageModelV4() } },
      models: {
        removed: {
          provider: 'test',
          modelId: 'removed-model',
          contextWindow: 1_000,
          capabilities: [],
          availability: 'unavailable',
        },
      },
    });
    expect(() => registry.preflight('removed')).toThrow('unavailable');
    const snapshot = registry.snapshot({
      source: 'catalog-cache',
      observedAt: '2026-08-22T00:00:00.000Z',
    });
    expect(
      validateAgentModelSnapshot(snapshot, {
        maxAgeMs: 60_000,
        now: () => new Date('2026-08-22T00:00:30.000Z'),
      }).source,
    ).toBe('catalog-cache');
    expect(() =>
      validateAgentModelSnapshot(snapshot, {
        maxAgeMs: 1,
        now: () => new Date('2026-08-22T00:00:30.000Z'),
      }),
    ).toThrow('stale');
  });
});
