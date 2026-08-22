import { describe, expect, test } from 'bun:test';
import { createAgentObservability } from '../src/agent-runtime';

describe('agent observability', () => {
  test('isolates a failing operator sink from runtime callers', async () => {
    const failures: unknown[] = [];
    const observability = createAgentObservability({
      write: () => {
        throw new Error('sink unavailable');
      },
      onSinkError: ({ error }) => {
        failures.push(error);
      },
    });
    observability.emit({
      schemaVersion: 1,
      eventId: 'event-1',
      type: 'run-terminal',
      conversationId: 'conversation-1',
      runId: 'run-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      state: 'failed',
      terminalReason: 'provider_failure',
      internalCause: new Error('private provider cause'),
      emittedAt: '2026-08-22T00:00:00.000Z',
    });
    await observability.flush();
    expect(observability.getStatus().failed).toBe(1);
    expect(failures).toHaveLength(1);
  });
});
