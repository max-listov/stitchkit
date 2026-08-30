import { describe, expect, test } from 'bun:test';
import {
  type AgentRuntimeEvent,
  advanceAgentRuntimeEventCursor,
  agentDurableEventId,
  createAgentRuntimeEventSink,
} from '../src/agent-runtime';
import {
  advanceAgentMultiSessionCursor,
  createAgentControlView,
  reduceAgentControlEvent,
  reduceAgentControlSnapshot,
} from '../src/agent-runtime-browser';

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
  test('isolates transient cursors per conversation and run', () => {
    const first = advanceAgentMultiSessionCursor(
      { conversations: {} },
      {
        type: 'assistant-delta',
        conversationId: 'a',
        runId: 'run-a',
        runtimeEpoch: 'epoch',
        sequence: 1,
        textDelta: 'a',
        emittedAt,
      },
    );
    const independent = advanceAgentMultiSessionCursor(first.cursor, {
      type: 'assistant-delta',
      conversationId: 'b',
      runId: 'run-b',
      runtimeEpoch: 'epoch',
      sequence: 1,
      textDelta: 'b',
      emittedAt,
    });
    expect(independent.status).toBe('accepted');
    const view = reduceAgentControlEvent(createAgentControlView(), {
      type: 'assistant-delta',
      conversationId: 'a',
      runId: 'run-a',
      runtimeEpoch: 'epoch',
      sequence: 1,
      textDelta: 'first',
      emittedAt,
    });
    expect(view.conversations.a?.resyncRequired).toBe(false);
    const gap = reduceAgentControlEvent(view, {
      type: 'assistant-delta',
      conversationId: 'a',
      runId: 'run-a',
      runtimeEpoch: 'epoch',
      sequence: 3,
      textDelta: 'gap',
      emittedAt,
    });
    expect(gap.conversations.a?.resyncRequired).toBe(true);
    expect(
      advanceAgentMultiSessionCursor(
        { conversations: {} },
        {
          type: 'assistant-delta',
          conversationId: 'a',
          runId: 'late-run',
          runtimeEpoch: 'epoch',
          sequence: 2,
          textDelta: 'late',
          emittedAt,
        },
      ).status,
    ).toBe('gap');
  });

  test('treats snapshots as authoritative and requests resync for newer durable state', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      conversationId: 'conversation-1',
      version: 2,
      messages: [],
      runs: [],
      idempotency: {},
      updatedAt: emittedAt,
    };
    const loaded = reduceAgentControlSnapshot(createAgentControlView(), snapshot);
    expect(loaded.cursor.conversations['conversation-1']?.snapshotVersion).toBe(2);
    const stale = reduceAgentControlEvent(loaded, runState(4));
    expect(stale.conversations['conversation-1']?.resyncRequired).toBe(true);
    const refreshed = reduceAgentControlSnapshot(stale, { ...snapshot, version: 4 });
    expect(refreshed.conversations['conversation-1']?.resyncRequired).toBe(false);
    expect(refreshed.cursor.conversations['conversation-1']?.snapshotVersion).toBe(4);
  });

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
