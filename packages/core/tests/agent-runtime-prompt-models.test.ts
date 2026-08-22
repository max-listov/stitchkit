import { describe, expect, test } from 'bun:test';
import { MockLanguageModelV4 } from 'ai/test';
import { composeAgentPrompt, defineModelRegistry } from '../src/agent-runtime';

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
});
