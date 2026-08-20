import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { RealtimeRejectedEvent } from '../src/realtime';
import { realtimeContractViolation } from '../src/realtime/rejection';

const ReplicationArguments = z.tuple([
  z.object({
    v: z.literal(2),
    item: z.object({ v: z.number(), id: z.string() }),
  }),
]);

// Kept byte-for-byte equivalent to the guide recipe: this test is the proof
// that its Zod issue path matches Stitchkit's tuple-shaped event contract.
function isProtocolGenerationMismatch(rejected: RealtimeRejectedEvent): boolean {
  const cause = rejected.error.cause;
  if (!(cause instanceof z.ZodError)) return false;
  const first = cause.issues[0];
  return (
    first?.code === 'invalid_value' &&
    first.path.length === 2 &&
    first.path[0] === 0 &&
    first.path[1] === 'v'
  );
}

function rejected(value: unknown): RealtimeRejectedEvent {
  const parsed = ReplicationArguments.safeParse([value]);
  if (parsed.success) throw new Error('fixture must be rejected');
  return realtimeContractViolation({
    event: 'replicated',
    direction: 'client-inbound',
    phase: 'arguments',
    reason: 'invalid-arguments',
    fault: 'peer',
    cause: parsed.error,
  });
}

describe('realtime protocol-generation documentation recipe', () => {
  test('classifies only the first payload generation literal mismatch', () => {
    expect(
      isProtocolGenerationMismatch(rejected({ v: 1, item: { v: 3, id: 'one' } })),
    ).toBeTrue();
    expect(
      isProtocolGenerationMismatch(rejected({ v: 2, item: { v: 'bad', id: 'one' } })),
    ).toBeFalse();
    expect(
      isProtocolGenerationMismatch(rejected({ v: 2, item: { v: 3, id: 99 } })),
    ).toBeFalse();
  });
});
