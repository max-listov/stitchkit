import { describe, expect, test } from 'bun:test';
import {
  type AgentRuntimeEvent,
  advanceAgentRuntimeEventCursor,
  agentDurableEventId,
  createAgentRuntimeEventSink,
} from '../src/agent-runtime';

const emittedAt = '2026-08-22T00:00:00.000Z';

function runState(snapshotVersion: number): Extract<AgentRuntimeEvent, { type: 'run-state' }> {
  return {
    type: 'run-state',
    eventId: agentDurableEventId('run-state', 'run-1', snapshotVersion),
    conversationId: 'conversation-1',
    runId: 'run-1',
    snapshotVersion,
    state: 'running',
    emittedAt,
  };
}

describe('agent application delivery events', () => {
  test('detects durable and transient duplicates or reconnect gaps', () => {
    const first = advanceAgentRuntimeEventCursor({}, runState(2));
    expect(first.status).toBe('accepted');
    expect(advanceAgentRuntimeEventCursor(first.cursor, runState(2)).status).toBe('duplicate');
    expect(
      advanceAgentRuntimeEventCursor(first.cursor, {
        ...runState(2),
        type: 'run-state',
        eventId: agentDurableEventId('run-state', 'run-2', 2),
        runId: 'run-2',
      }).status,
    ).toBe('accepted');
    // Not a gap, and this test used to say it was. Two durable events are
    // routinely several conversation versions apart, because checkpoints,
    // compaction and unstarted acceptances all bump the version and publish
    // nothing — so this reported a gap after essentially every run, and the
    // guide told consumers a gap means "reload the whole conversation".
    expect(advanceAgentRuntimeEventCursor(first.cursor, runState(4)).status).toBe('accepted');

    const delta: AgentRuntimeEvent = {
      type: 'assistant-delta',
      conversationId: 'conversation-1',
      runId: 'run-1',
      runtimeEpoch: 'epoch-1',
      sequence: 1,
      textDelta: 'a',
      emittedAt,
    };
    const transient = advanceAgentRuntimeEventCursor({}, delta);
    expect(transient.status).toBe('accepted');
    expect(
      advanceAgentRuntimeEventCursor(transient.cursor, { ...delta, sequence: 3 }).status,
    ).toBe('gap');
  });

  test('isolates a bounded transport sink and supports projection/redaction', async () => {
    const received: AgentRuntimeEvent[] = [];
    const failures: unknown[] = [];
    const sink = createAgentRuntimeEventSink({
      write(event) {
        received.push(event);
        if (event.type === 'run-state') throw new Error('transport unavailable');
      },
      project: (event) => (event.type === 'assistant-delta' ? undefined : event),
      onSinkError: ({ error }) => {
        failures.push(error);
      },
    });
    await sink.publish(runState(1));
    await sink.publish({
      type: 'assistant-delta',
      conversationId: 'conversation-1',
      runId: 'run-1',
      runtimeEpoch: 'epoch-1',
      sequence: 1,
      textDelta: 'private transient text',
      emittedAt,
    });
    await sink.flush();

    expect(received).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(sink.getStatus().failed).toBe(1);
  });
});
