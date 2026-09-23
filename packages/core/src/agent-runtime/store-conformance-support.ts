/** The fixtures and the one assertion every conformance scenario is written with. */
import { AgentMessageSchema, AgentRunSchema } from './schemas';

export function userMessage(conversationId: string, id: string) {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: id }],
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  });
}

export function queuedRun(conversationId: string, inputMessageId: string, id: string) {
  return AgentRunSchema.parse({
    schemaVersion: 1,
    id,
    conversationId,
    inputMessageIds: [inputMessageId],
    assistantMessageId: `${id}-assistant`,
    state: 'queued',
    revision: 0,
    createdAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
  });
}

export function requireOutcome<OUTCOME extends string>(
  actual: { outcome: string },
  expected: OUTCOME,
): asserts actual is { outcome: OUTCOME } {
  if (actual.outcome !== expected) {
    throw new Error(
      `Agent store conformance expected ${expected}, received ${actual.outcome}`,
    );
  }
}
