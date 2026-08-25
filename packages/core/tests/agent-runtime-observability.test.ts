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

  test('deduplicates stable terminal events and redacts internal causes by default', async () => {
    const received: unknown[] = [];
    const observability = createAgentObservability({
      write: (event) => {
        received.push(event);
      },
    });
    const event = {
      schemaVersion: 1,
      eventId: 'run-1:terminal:4',
      type: 'run-terminal',
      conversationId: 'conversation-1',
      runId: 'run-1',
      traceId: 'trace-1',
      spanId: 'span-1',
      state: 'failed',
      terminalReason: 'provider_failure',
      internalCause: new Error('private provider cause'),
      emittedAt: '2026-08-22T00:00:00.000Z',
    } satisfies Parameters<typeof observability.emit>[0];
    observability.emit(event);
    observability.emit(event);
    await observability.flush();

    expect(received).toHaveLength(1);
    expect(received[0]).not.toHaveProperty('internalCause');
  });
  test('an operator sink may opt into the internal cause it is redacted from', async () => {
    // The other half of the 0.58.0 breaking change: redaction is the default,
    // and an operator-owned sink can ask for the raw cause. Nothing covered the
    // opt-in, so inverting the flag broke nothing.
    const received: Array<Record<string, unknown>> = [];
    const observability = createAgentObservability({
      includeInternalCause: true,
      write: (event) => {
        received.push(event as unknown as Record<string, unknown>);
      },
    });
    observability.emit({
      schemaVersion: 1,
      eventId: 'run-2:terminal:1',
      type: 'run-terminal',
      conversationId: 'conversation-2',
      runId: 'run-2',
      traceId: 'trace-2',
      spanId: 'span-2',
      state: 'failed',
      terminalReason: 'provider_failure',
      internalCause: new Error('private provider cause'),
      emittedAt: '2026-08-24T00:00:00.000Z',
    });
    await observability.flush();

    expect(received).toHaveLength(1);
    expect(received[0]).toHaveProperty('internalCause');
    const cause = received[0]?.internalCause;
    expect(cause instanceof Error && cause.message).toBe('private provider cause');
  });

  test('deduplication forgets, so a long-lived runtime does not grow without bound', async () => {
    const received: unknown[] = [];
    const observability = createAgentObservability({
      // Raised so the sink's own capacity bound cannot be mistaken for the
      // deduplication bound this test is about.
      maxPending: 20_000,
      write: (event) => {
        received.push(event);
      },
    });
    const emit = (index: number): void => {
      observability.emit({
        schemaVersion: 1,
        eventId: `run-3:terminal:${index}`,
        type: 'run-terminal',
        conversationId: 'conversation-3',
        runId: 'run-3',
        traceId: 'trace-3',
        spanId: 'span-3',
        state: 'completed',
        terminalReason: 'success',
        emittedAt: '2026-08-24T00:00:00.000Z',
      });
    };

    emit(0);
    for (let index = 1; index <= 10_000; index += 1) emit(index);
    // The first id has fallen out of the window, so its repeat is a real
    // re-emit rather than the duplicate the runtime just published.
    emit(0);
    await observability.flush();

    expect(received).toHaveLength(10_002);
  });
});
