import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { zodIssues } from '../src/internal/errors';
import type { RealtimeRejectionIssue } from '../src/realtime';

const ReplicationArguments = z.tuple([
  z.object({
    v: z.literal(2),
    item: z.object({ v: z.number(), id: z.string() }),
  }),
]);

/**
 * Kept equivalent to the guide recipe, which changed shape for a reason.
 *
 * It used to inspect a `ZodError`'s internals — issue code, path length, path
 * elements — three conditions about somebody else's object shape for a fact
 * that is binary. Two of those conditions were about Zod, not about the
 * protocol, and a Zod release could have moved either. The refusal now travels
 * to the sender with its issues already flattened, so the whole recipe is one
 * comparison against a dotted path.
 */
function isProtocolGenerationMismatch(issues: RealtimeRejectionIssue[] | undefined): boolean {
  return issues?.some((issue) => issue.path === '0.v') ?? false;
}

/** The issues a peer would send back for this payload. */
function issuesFor(value: unknown): RealtimeRejectionIssue[] {
  const parsed = ReplicationArguments.safeParse([value]);
  if (parsed.success) throw new Error('fixture must be rejected');
  return zodIssues(parsed.error);
}

describe('realtime protocol-generation documentation recipe', () => {
  test('the first payload generation is the tuple path `0.v`', () => {
    // The tuple index is the part everyone gets wrong: event arguments are a
    // tuple, so the first payload's `v` is `0.v` and never `v`.
    expect(issuesFor({ v: 1, item: { v: 3, id: 'one' } })).toEqual([
      { path: '0.v', code: 'invalid_value', message: 'Invalid input: expected 2' },
    ]);
  });

  test('classifies only the first payload generation literal mismatch', () => {
    expect(
      isProtocolGenerationMismatch(issuesFor({ v: 1, item: { v: 3, id: 'one' } })),
    ).toBeTrue();
    expect(
      isProtocolGenerationMismatch(issuesFor({ v: 2, item: { v: 'bad', id: 'one' } })),
    ).toBeFalse();
    expect(
      isProtocolGenerationMismatch(issuesFor({ v: 2, item: { v: 3, id: 99 } })),
    ).toBeFalse();
    expect(isProtocolGenerationMismatch(undefined)).toBeFalse();
  });
});
