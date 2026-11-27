import { expect, spyOn, test } from 'bun:test';
import { buildContextHandoff } from '../../src/entrypoints/agent-executor';

test('handoff measures each candidate ID once for a positive limit and skips all ID widths at zero', () => {
  for (const count of [15, 150, 1500]) {
    const entries = Array.from({ length: count }, (_, index) => ({
      kind: 'message' as const,
      id: `probe:${['中', '"', '\\u0000', '😀'][index % 4]}${index}`,
      role: 'user' as const,
      parts: [{ type: 'text' as const, text: 'Message body '.repeat(10) }],
    }));
    for (const maxOmittedIds of [0, 3, 15]) {
      const input = {
        entries,
        strategy: { mode: 'full' as const },
        budget: { maxOmittedIds, maxBytes: 1800, maxTokens: 450 },
      };
      const spy = spyOn(JSON, 'stringify');
      let result: ReturnType<typeof buildContextHandoff>;
      try {
        result = buildContextHandoff(input);
        const widths = spy.mock.calls.filter(
          ([value]) => typeof value === 'string' && value.startsWith('probe:'),
        );
        expect(widths).toHaveLength(maxOmittedIds === 0 ? 0 : count);
      } finally {
        spy.mockRestore();
      }
      expect(buildContextHandoff(input)).toEqual(result);
      expect(result.omittedItemIds.length).toBeLessThanOrEqual(maxOmittedIds);
      expect(Buffer.byteLength(result.inlineText)).toBeLessThanOrEqual(1800);
      expect(Buffer.byteLength(JSON.stringify(result.structuredItems))).toBeLessThanOrEqual(
        1800,
      );
    }
  }
});
