import { describe, expect, test } from 'bun:test';
import {
  buildContextHandoff,
  type ContextHandoffEntry,
  ContextHandoffInputSchema,
  ContextHandoffResultSchema,
  withInlineHandoffContext,
} from '../../src/entrypoints/agent-executor';

const textEntry = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  turnId?: string,
): ContextHandoffEntry => ({
  kind: 'message',
  id,
  role,
  parts: [{ type: 'text', text }],
  ...(turnId !== undefined && { turnId }),
});

describe('buildContextHandoff', () => {
  test('selects intact items by priority (last user, last assistant, first user, then newest) within byte and token caps', () => {
    const entries: ContextHandoffEntry[] = [
      textEntry('u1', 'user', 'First goal: build the deterministic context handoff.'),
      textEntry('a1', 'assistant', 'A'.repeat(400)),
      textEntry('u2', 'user', 'B'.repeat(400)),
      textEntry('a2', 'assistant', 'C'.repeat(400)),
      textEntry('u3', 'user', 'D'.repeat(400)),
      textEntry('a3', 'assistant', 'Final assistant summary before switch.'),
      textEntry('u4', 'user', 'Latest user instruction.'),
    ];
    const maxBytes = 1250;
    const maxTokens = 400;
    const result = buildContextHandoff({
      entries,
      strategy: { mode: 'full' },
      budget: { maxBytes, maxTokens },
    });
    expect(ContextHandoffResultSchema.parse(result)).toEqual(result);
    const ids = result.selectedItems.map((item) => item.id);
    // Priority items must be preserved in chronological order.
    expect(ids).toEqual(['u1', 'a3', 'u4']);
    expect(result.omittedTotal).toBe(4);
    expect(result.omittedItemIds).toEqual(['a1', 'u2', 'a2', 'u3']);

    // Both inlineText and structuredItems must strictly fit maxBytes and maxTokens.
    const inlineBytes = Buffer.byteLength(result.inlineText, 'utf8');
    const structuredBytes = Buffer.byteLength(JSON.stringify(result.structuredItems), 'utf8');
    expect(Math.max(inlineBytes, structuredBytes)).toBeLessThanOrEqual(maxBytes);
    expect(result.bytes).toBeLessThanOrEqual(maxBytes);
    expect(result.estimatedTokens).toBeLessThanOrEqual(maxTokens);

    // Deterministic across repeated invocations.
    expect(
      buildContextHandoff({
        entries,
        strategy: { mode: 'full' },
        budget: { maxBytes, maxTokens },
      }),
    ).toEqual(result);
  });

  test('enforces hard byte/token ceilings on multi-byte UTF-8 and JSON-escaped IDs and stays O(N) on large history', () => {
    const entries: ContextHandoffEntry[] = [
      textEntry('a'.repeat(16), 'user', 'First user item with long ASCII id.'),
      textEntry('中'.repeat(15), 'assistant', 'X'.repeat(450)),
      textEntry('\u0001'.repeat(12), 'user', 'Y'.repeat(450)),
      textEntry('last-a', 'assistant', 'Final assistant note.'),
      textEntry('last-u', 'user', 'Final user note.'),
    ];
    for (const maxOmittedIds of [1, 2, 5]) {
      const result = buildContextHandoff({
        entries,
        strategy: { mode: 'full' },
        budget: { maxBytes: 1200, maxTokens: 300, maxOmittedIds },
      });
      const inlineBytes = Buffer.byteLength(result.inlineText, 'utf8');
      const structuredBytes = Buffer.byteLength(
        JSON.stringify(result.structuredItems),
        'utf8',
      );
      expect(Math.max(inlineBytes, structuredBytes)).toBeLessThanOrEqual(1200);
      expect(result.bytes).toBeLessThanOrEqual(1200);
      expect(result.estimatedTokens).toBeLessThanOrEqual(300);
    }

    // 1,500 entries must complete linearly well under 250 ms.
    const largeEntries: ContextHandoffEntry[] = Array.from({ length: 1500 }, (_, i) =>
      textEntry(`item-${i}`, i % 2 === 0 ? 'user' : 'assistant', `Message body ${i}`),
    );
    const started = performance.now();
    const largeResult = buildContextHandoff({
      entries: largeEntries,
      strategy: { mode: 'full' },
      budget: { maxBytes: 64_000, maxTokens: 16_000 },
    });
    const elapsedMs = performance.now() - started;
    expect(largeResult.bytes).toBeLessThanOrEqual(64_000);
    expect(largeResult.estimatedTokens).toBeLessThanOrEqual(16_000);
    expect(elapsedMs).toBeLessThan(250);
  });

  test('renders Responses API structuredItems (input_text for user, output_text for assistant) and excludes binary/reasoning/provider parts', () => {
    const entries: ContextHandoffEntry[] = [
      {
        kind: 'message',
        id: 'm1',
        role: 'user',
        turnId: 'turn-1',
        parts: [
          { type: 'text', text: 'Inspect config' },
          { type: 'file', mediaType: 'image/png', reference: 'file://secret.png' },
        ],
      },
      {
        kind: 'message',
        id: 'm2',
        role: 'assistant',
        turnId: 'turn-1',
        providerThreadId: 'native-1',
        status: 'completed',
        parts: [
          { type: 'reasoning', text: 'private chain of thought' },
          {
            type: 'provider',
            envelope: { schemaVersion: 1, provider: 'anthropic', data: { secret: true } },
          },
          {
            type: 'tool-call',
            callId: 'c1',
            toolName: 'readFile',
            input: { path: 'a.ts', emoji: '🚀'.repeat(300) },
          },
          {
            type: 'tool-result',
            callId: 'c1',
            toolName: 'readFile',
            outcome: 'success',
            output: 'ok',
          },
          { type: 'text', text: 'Config looks clean.' },
        ],
      },
    ];
    const result = buildContextHandoff({
      entries,
      strategy: { mode: 'full' },
      budget: { maxBytes: 16_000, maxTokens: 4_000 },
      recoveryHint: 'Use the host read endpoint to inspect omitted IDs.',
    });
    expect(result.structuredItems[0]?.role).toBe('user');
    expect(result.structuredItems[0]?.content[0]?.type).toBe('input_text');
    expect(result.structuredItems[1]?.role).toBe('user');
    expect(result.structuredItems[1]?.content[0]?.type).toBe('input_text');
    expect(result.structuredItems[2]?.role).toBe('assistant');
    expect(result.structuredItems[2]?.content[0]?.type).toBe('output_text');
    expect(result.inlineText).toContain('readFile');
    expect(result.inlineText).toContain('Config looks clean.');
    expect(result.inlineText).toContain('Use the host read endpoint');
    expect(result.inlineText).not.toContain('private chain of thought');
    expect(result.inlineText).not.toContain('file://secret.png');
    // Surrogate-safe truncation must not leave lone UTF-16 surrogates.
    expect(result.inlineText.isWellFormed()).toBe(true);
  });

  test('supports delta mode with clear barriers, pre-clear anchor rejection/fallback, empty delta, and missingAnchor', () => {
    const entries: ContextHandoffEntry[] = [
      textEntry('m1', 'user', 'Before clear', 't1'),
      { kind: 'clear', id: 'clr-1', turnId: 't2' },
      textEntry('m2', 'user', 'After clear first', 't3'),
      textEntry('m3', 'assistant', 'After clear answer', 't3'),
      textEntry('m4', 'user', 'Newest follow-up', 't4'),
    ];
    const full = buildContextHandoff({
      entries,
      strategy: { mode: 'full' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(full.selectedItems.map((i) => i.id)).toEqual(['m2', 'm3', 'm4']);

    // Anchoring on the clear barrier itself is a valid post-clear delta.
    const deltaFromClear = buildContextHandoff({
      entries,
      strategy: { mode: 'delta', afterItemId: 'clr-1' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(deltaFromClear.strategy).toBe('delta');
    expect(deltaFromClear.selectedItems.map((i) => i.id)).toEqual(['m2', 'm3', 'm4']);

    // Anchoring BEFORE the latest clear barrier must fail closed under default missingAnchor: 'error'.
    expect(() =>
      buildContextHandoff({
        entries,
        strategy: { mode: 'delta', afterItemId: 'm1' },
        budget: { maxBytes: 8_000, maxTokens: 2_000 },
      }),
    ).toThrow(/anchor not found/i);
    expect(() =>
      buildContextHandoff({
        entries,
        strategy: { mode: 'delta', afterTurnId: 't1' },
        budget: { maxBytes: 8_000, maxTokens: 2_000 },
      }),
    ).toThrow(/anchor not found/i);

    // Pre-clear anchor with missingAnchor: 'full' switches to strategy: 'full' over post-clear entries.
    const preClearFallback = buildContextHandoff({
      entries,
      strategy: { mode: 'delta', afterItemId: 'm1', missingAnchor: 'full' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(preClearFallback.strategy).toBe('full');
    expect(preClearFallback.selectedItems.map((i) => i.id)).toEqual(['m2', 'm3', 'm4']);

    const deltaByItem = buildContextHandoff({
      entries,
      strategy: { mode: 'delta', afterItemId: 'm3' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(deltaByItem.strategy).toBe('delta');
    expect(deltaByItem.selectedItems.map((i) => i.id)).toEqual(['m4']);

    const deltaByTurn = buildContextHandoff({
      entries,
      strategy: { mode: 'delta', afterTurnId: 't3' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(deltaByTurn.selectedItems.map((i) => i.id)).toEqual(['m4']);

    const emptyDelta = buildContextHandoff({
      entries,
      strategy: { mode: 'delta', afterItemId: 'm4' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(emptyDelta.selectedItems).toEqual([]);
    expect(emptyDelta.inlineText).toBe('');
    expect(emptyDelta.structuredItems).toEqual([]);

    expect(() =>
      buildContextHandoff({
        entries,
        strategy: { mode: 'delta', afterItemId: 'nonexistent' },
        budget: { maxBytes: 8_000, maxTokens: 2_000 },
      }),
    ).toThrow(/anchor not found/i);

    const fallbackFull = buildContextHandoff({
      entries,
      strategy: { mode: 'delta', afterItemId: 'nonexistent', missingAnchor: 'full' },
      budget: { maxBytes: 8_000, maxTokens: 2_000 },
    });
    expect(fallbackFull.strategy).toBe('full');
    expect(fallbackFull.selectedItems.map((i) => i.id)).toEqual(['m2', 'm3', 'm4']);
  });

  test('respects empty history, huge single item, maxOmittedIds cap, and window availability ceilings', () => {
    const empty = buildContextHandoff({
      entries: [],
      strategy: { mode: 'full' },
      budget: { maxBytes: 1500, maxTokens: 500 },
    });
    expect(empty.selectedItems).toEqual([]);
    expect(empty.omittedTotal).toBe(0);
    expect(empty.bytes).toBe(0);

    const hugeSingle = buildContextHandoff({
      entries: [textEntry('huge', 'user', 'Z'.repeat(5_000))],
      strategy: { mode: 'full' },
      budget: { maxBytes: 800, maxTokens: 200 },
    });
    expect(hugeSingle.selectedItems).toEqual([]);
    expect(hugeSingle.omittedTotal).toBe(1);
    expect(hugeSingle.omittedItemIds).toEqual(['huge']);
    expect(hugeSingle.bytes).toBeLessThanOrEqual(800);

    const entries: ContextHandoffEntry[] = Array.from({ length: 12 }, (_, index) =>
      textEntry(
        `item-${String(index + 1).padStart(2, '0')}`,
        index % 2 === 0 ? 'user' : 'assistant',
        'X'.repeat(300),
      ),
    );
    const result = buildContextHandoff({
      entries,
      strategy: { mode: 'full' },
      budget: { maxBytes: 1500, maxTokens: 500, maxOmittedIds: 3 },
    });
    expect(result.omittedItemIds.length).toBeLessThanOrEqual(3);
    expect(result.omittedTotal).toBeGreaterThan(3);
    expect(result.bytes).toBeLessThanOrEqual(1500);
    expect(result.estimatedTokens).toBeLessThanOrEqual(500);

    // Exhausted context window leaves zero room for imported items.
    const exhausted = buildContextHandoff({
      entries,
      strategy: { mode: 'full' },
      budget: {
        maxBytes: 16_000,
        maxTokens: 4_000,
        contextWindowTokens: 100_000,
        usedTokens: 90_000,
        workReserveTokens: 20_000,
      },
    });
    expect(exhausted.selectedItems).toEqual([]);
    expect(exhausted.bytes).toBe(0);
    expect(exhausted.omittedTotal).toBe(entries.length);
  });

  test('withInlineHandoffContext defers on leading slash commands but not filesystem paths', () => {
    expect(withInlineHandoffContext('CTX', '/compact now')).toEqual({
      text: '/compact now',
      deferred: true,
    });
    expect(withInlineHandoffContext('CTX', '  /review')).toEqual({
      text: '  /review',
      deferred: true,
    });
    expect(withInlineHandoffContext('CTX', '/tmp/report.md please inspect')).toEqual({
      text: 'CTX\n\nUser message:\n/tmp/report.md please inspect',
      deferred: false,
    });
    expect(withInlineHandoffContext('', 'hello')).toEqual({
      text: 'hello',
      deferred: false,
    });
  });

  test('refuses non-positive, NaN, Infinity budgets and invalid delta anchor combinations before processing', () => {
    for (const badBudget of [
      { maxBytes: 0, maxTokens: 100 },
      { maxBytes: -10, maxTokens: 100 },
      { maxBytes: 1000, maxTokens: 0 },
      { maxBytes: Number.NaN, maxTokens: 100 },
      { maxBytes: Number.POSITIVE_INFINITY, maxTokens: 100 },
    ]) {
      expect(
        ContextHandoffInputSchema.safeParse({
          entries: [],
          strategy: { mode: 'full' },
          budget: badBudget,
        }).success,
      ).toBe(false);
    }
    expect(
      ContextHandoffInputSchema.safeParse({
        entries: [],
        strategy: { mode: 'delta' },
        budget: { maxBytes: 1000, maxTokens: 200 },
      }).success,
    ).toBe(false);
    expect(
      ContextHandoffInputSchema.safeParse({
        entries: [],
        strategy: { mode: 'delta', afterItemId: 'm1', afterTurnId: 't1' },
        budget: { maxBytes: 1000, maxTokens: 200 },
      }).success,
    ).toBe(false);
  });
});
