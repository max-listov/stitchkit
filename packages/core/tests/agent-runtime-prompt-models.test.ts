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
  test('reservation overflow is irreducible even with empty history', async () => {
    const zero = { value: 0, provenance: 'computed' } as const;
    const prompt = composeAgentPrompt([]);
    for (const oversizePolicy of ['reject', 'compact'] as const) {
      const result = await prompt({
        context: {},
        signal: new AbortController().signal,
        historyTokens: zero,
        oversizePolicy,
        budget: {
          contextWindow: 100,
          reservedOutput: 101,
          toolSchemas: zero,
          attachments: zero,
          providerOverhead: zero,
        },
      });
      expect(result.availableHistoryTokens).toBe(-1);
      expect(result.contextDecision).toBe('oversized');
    }
  });

  test('every reservation participates, equality fits, and unavailable stays unknown', async () => {
    const zero = { value: 0, provenance: 'computed' } as const;
    const one = { value: 1, provenance: 'computed' } as const;
    const section = {
      name: 'instructions',
      stability: 'stable' as const,
      render: () => 'x',
      estimateTokens: () => one,
    };
    for (const budget of [
      { reservedOutput: 1, toolSchemas: zero, attachments: zero, providerOverhead: zero },
      { reservedOutput: 0, toolSchemas: one, attachments: zero, providerOverhead: zero },
      { reservedOutput: 0, toolSchemas: zero, attachments: one, providerOverhead: zero },
      { reservedOutput: 0, toolSchemas: zero, attachments: zero, providerOverhead: one },
    ]) {
      const overflow = await composeAgentPrompt([section])({
        context: {},
        signal: new AbortController().signal,
        historyTokens: zero,
        budget: { contextWindow: 1, ...budget },
      });
      expect(overflow.contextDecision).toBe('oversized');
    }
    const exact = await composeAgentPrompt([])({
      context: {},
      signal: new AbortController().signal,
      historyTokens: zero,
      budget: {
        contextWindow: 0,
        reservedOutput: 0,
        toolSchemas: zero,
        attachments: zero,
        providerOverhead: zero,
      },
    });
    expect(exact).toMatchObject({ availableHistoryTokens: 0, contextDecision: 'fits' });
    const unavailable = await composeAgentPrompt([])({
      context: {},
      signal: new AbortController().signal,
      historyTokens: zero,
      budget: {
        contextWindow: 0,
        reservedOutput: 0,
        toolSchemas: { provenance: 'unavailable' },
        attachments: zero,
        providerOverhead: zero,
      },
    });
    expect(unavailable.contextDecision).toBe('unavailable');
    expect(unavailable.availableHistoryTokens).toBeUndefined();
  });

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

  test('evicts a completed approval continuation as one chronological turn', async () => {
    const at = '2026-08-22T00:00:00.000Z';
    const parse = (id: string, role: 'user' | 'assistant' | 'tool', parts: unknown[]) =>
      AgentMessageSchema.parse({
        schemaVersion: 1,
        id,
        conversationId: 'approval-history',
        ...(role !== 'user' && { runId: id }),
        role,
        status: role === 'user' || role === 'tool' ? 'committed' : 'completed',
        parts,
        createdAt: at,
        updatedAt: at,
      });
    const messages = [
      parse('user-approval', 'user', [{ type: 'text', text: 'change it' }]),
      parse('assistant-request', 'assistant', [
        { type: 'tool-call', callId: 'call-1', toolName: 'change', input: {} },
        { type: 'tool-approval-request', approvalId: 'approval-1', callId: 'call-1' },
      ]),
      parse('tool-response', 'tool', [
        { type: 'tool-approval-response', approvalId: 'approval-1', approved: true },
      ]),
      parse('assistant-result', 'assistant', [
        { type: 'tool-result', callId: 'call-1', toolName: 'change', outcome: 'success' },
        { type: 'text', text: 'changed' },
      ]),
      parse('user-recent', 'user', [{ type: 'text', text: 'next' }]),
      parse('assistant-recent', 'assistant', [{ type: 'text', text: 'answer' }]),
    ];
    const selected = await selectAgentHistory({
      messages,
      availableTokens: 2,
      keepRecentTurns: 1,
      estimateMessage: () => ({ value: 1, provenance: 'measured' }),
    });
    expect(selected.messages.map(({ id }) => id)).toEqual(['user-recent', 'assistant-recent']);
    expect(selected.outcome).toBe('truncated');
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
