import { describe, expect, test } from 'bun:test';
import {
  createExternalChannelHarness,
  type ExternalChannelAgentRuntime,
  type ExternalChannelStore,
  type ExternalDeliveryAdapter,
  type ExternalIngress,
  type ExternalIngressRecord,
  ExternalIngressRecordSchema,
  type ExternalOutboxRecord,
  ExternalOutboxRecordSchema,
} from '../examples/external-channel-harness';
import { type AgentRuntimeEvent, AgentRuntimeEventSchema } from '../src/agent-runtime';

class MemoryChannelStore implements ExternalChannelStore {
  private readonly ingress = new Map<string, ExternalIngressRecord>();
  private readonly outbox = new Map<string, ExternalOutboxRecord>();
  private ordinal = 0;

  async admit(
    input: ExternalIngress,
  ): Promise<Awaited<ReturnType<ExternalChannelStore['admit']>>> {
    const existing = this.ingress.get(input.updateId);
    if (existing) return { outcome: 'duplicate', record: existing };
    const record = ExternalIngressRecordSchema.parse({
      ...input,
      idempotencyKey: `external:${input.updateId}`,
    });
    this.ingress.set(input.updateId, record);
    return { outcome: 'created', record };
  }

  async bindRun(updateId: string, runId: string): Promise<ExternalIngressRecord> {
    const current = this.ingress.get(updateId);
    if (!current) throw new Error('Ingress disappeared');
    const next = ExternalIngressRecordSchema.parse({ ...current, runId });
    this.ingress.set(updateId, next);
    return next;
  }

  async replyTarget(conversationId: string): Promise<string | undefined> {
    return [...this.ingress.values()].find(
      (record) => record.conversationId === conversationId,
    )?.replyTarget;
  }

  async enqueue(input: {
    eventKey: string;
    conversationId: string;
    runId: string;
    replyTarget: string;
    event: AgentRuntimeEvent;
  }): Promise<Awaited<ReturnType<ExternalChannelStore['enqueue']>>> {
    const existing = [...this.outbox.values()].find(
      (record) => record.eventKey === input.eventKey,
    );
    if (existing) return { outcome: 'duplicate', record: existing };
    this.ordinal += 1;
    const record = ExternalOutboxRecordSchema.parse({
      ...input,
      deliveryId: `delivery-${this.ordinal}`,
      ordinal: this.ordinal,
      revision: 0,
      state: 'not-dispatched',
    });
    this.outbox.set(record.deliveryId, record);
    return { outcome: 'created', record };
  }

  async nextReady(): Promise<ExternalOutboxRecord | undefined> {
    const ordered = [...this.outbox.values()].sort(
      (left, right) => left.ordinal - right.ordinal,
    );
    const unresolved = ordered.find((record) => record.state !== 'acknowledged');
    return unresolved?.state === 'not-dispatched' ? unresolved : undefined;
  }

  async markPossiblyDispatched(
    deliveryId: string,
    expectedRevision: number,
    attemptId: string,
  ): Promise<ExternalOutboxRecord | undefined> {
    const current = this.outbox.get(deliveryId);
    if (
      !current ||
      current.revision !== expectedRevision ||
      current.state !== 'not-dispatched'
    ) {
      return undefined;
    }
    const next = ExternalOutboxRecordSchema.parse({
      ...current,
      revision: current.revision + 1,
      state: 'possibly-dispatched',
      attemptId,
    });
    this.outbox.set(deliveryId, next);
    return next;
  }

  async acknowledge(
    deliveryId: string,
    expectedRevision: number,
    receiptId: string,
  ): Promise<ExternalOutboxRecord | undefined> {
    const current = this.outbox.get(deliveryId);
    if (!current || current.revision !== expectedRevision) return undefined;
    const next = ExternalOutboxRecordSchema.parse({
      ...current,
      revision: current.revision + 1,
      state: 'acknowledged',
      receiptId,
    });
    this.outbox.set(deliveryId, next);
    return next;
  }

  async possiblyDispatched(): Promise<readonly ExternalOutboxRecord[]> {
    return [...this.outbox.values()].filter(
      (record) => record.state === 'possibly-dispatched',
    );
  }

  records(): readonly ExternalOutboxRecord[] {
    return [...this.outbox.values()];
  }
}

function terminalEvent(): AgentRuntimeEvent {
  return AgentRuntimeEventSchema.parse({
    type: 'terminal',
    eventId: 'terminal-event-1',
    conversationId: 'conversation-1',
    runId: 'run-1',
    snapshotVersion: 2,
    reason: 'success',
    emittedAt: '2026-08-29T00:00:00.000Z',
    message: {
      schemaVersion: 1,
      id: 'assistant-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      role: 'assistant',
      status: 'completed',
      parts: [{ type: 'text', text: 'done' }],
      createdAt: '2026-08-29T00:00:00.000Z',
      updatedAt: '2026-08-29T00:00:00.000Z',
    },
  });
}

describe('external channel composition', () => {
  test('duplicate ingress keeps one run mapping across a harness restart', async () => {
    const store = new MemoryChannelStore();
    let submissions = 0;
    const runtime: ExternalChannelAgentRuntime = {
      submit() {
        submissions += 1;
        return { accepted: Promise.resolve(), admission: Promise.resolve({ runId: 'run-1' }) };
      },
    };
    const delivery: ExternalDeliveryAdapter = {
      async send() {
        return { receiptId: 'receipt-1' };
      },
      async reconcile() {
        return { outcome: 'unknown' };
      },
    };
    const ingress = {
      updateId: 'update-1',
      principalId: 'principal-1',
      conversationId: 'conversation-1',
      replyTarget: 'reply-1',
      text: 'hello',
    };
    const first = createExternalChannelHarness({ runtime, store, delivery });
    await first.application.start();
    expect(await first.ingest(ingress)).toEqual({ outcome: 'accepted', runId: 'run-1' });
    await first.application.shutdown();

    const restarted = createExternalChannelHarness({ runtime, store, delivery });
    await restarted.application.start();
    expect(await restarted.ingest(ingress)).toEqual({ outcome: 'duplicate', runId: 'run-1' });
    expect(submissions).toBe(1);
    await restarted.application.shutdown();
  });

  test('terminal delivery receipt is separate and ambiguous dispatch reconciles without resend', async () => {
    const store = new MemoryChannelStore();
    const runtime: ExternalChannelAgentRuntime = {
      submit() {
        return { accepted: Promise.resolve(), admission: Promise.resolve({ runId: 'run-1' }) };
      },
    };
    let sends = 0;
    let reconciliations = 0;
    const errors: unknown[] = [];
    const delivery: ExternalDeliveryAdapter = {
      async send() {
        sends += 1;
        throw new Error('connection ended after provider accepted delivery');
      },
      async reconcile() {
        reconciliations += 1;
        return { outcome: 'acknowledged', receiptId: 'delivery-receipt-1' };
      },
    };
    const first = createExternalChannelHarness({
      runtime,
      store,
      delivery,
      onDeliveryError: (error) => {
        errors.push(error);
      },
    });
    await first.application.start();
    await first.ingest({
      updateId: 'update-1',
      principalId: 'principal-1',
      conversationId: 'conversation-1',
      replyTarget: 'reply-1',
      text: 'hello',
    });
    const terminal = terminalEvent();
    await first.publish(terminal);
    await first.flush();
    expect(errors).toHaveLength(1);
    expect(store.records()[0]).toMatchObject({
      eventKey: 'terminal-event-1',
      state: 'possibly-dispatched',
    });
    expect(store.records()[0]?.receiptId).toBeUndefined();
    await first.application.shutdown();

    const restarted = createExternalChannelHarness({ runtime, store, delivery });
    await restarted.application.start();
    await restarted.reconcile();
    expect(store.records()[0]).toMatchObject({
      state: 'acknowledged',
      receiptId: 'delivery-receipt-1',
      event: terminal,
    });
    expect({ sends, reconciliations }).toEqual({ sends: 1, reconciliations: 1 });
    await restarted.application.shutdown();
  });

  test('streaming policy preserves reasoning tool text and terminal causal order', async () => {
    const store = new MemoryChannelStore();
    const delivered: string[] = [];
    const runtime: ExternalChannelAgentRuntime = {
      submit() {
        return { accepted: Promise.resolve(), admission: Promise.resolve({ runId: 'run-1' }) };
      },
    };
    const delivery: ExternalDeliveryAdapter = {
      async send(input) {
        delivered.push(input.event.type);
        return { receiptId: `receipt-${delivered.length}` };
      },
      async reconcile() {
        return { outcome: 'unknown' };
      },
    };
    const harness = createExternalChannelHarness({
      runtime,
      store,
      delivery,
      outputPolicy: 'streaming',
    });
    await harness.application.start();
    await harness.ingest({
      updateId: 'update-1',
      principalId: 'principal-1',
      conversationId: 'conversation-1',
      replyTarget: 'reply-1',
      text: 'hello',
    });
    const transientBase = {
      conversationId: 'conversation-1',
      runId: 'run-1',
      runtimeEpoch: 'epoch-1',
      emittedAt: '2026-08-29T00:00:00.000Z',
    };
    const events = [
      AgentRuntimeEventSchema.parse({
        ...transientBase,
        type: 'reasoning-start',
        sequence: 0,
      }),
      AgentRuntimeEventSchema.parse({
        ...transientBase,
        type: 'reasoning-delta',
        sequence: 1,
        textDelta: 'why',
      }),
      AgentRuntimeEventSchema.parse({
        ...transientBase,
        type: 'tool-status',
        sequence: 2,
        callId: 'call-1',
        toolName: 'lookup',
        status: 'completed',
      }),
      AgentRuntimeEventSchema.parse({
        ...transientBase,
        type: 'assistant-delta',
        sequence: 3,
        textDelta: 'done',
      }),
      terminalEvent(),
    ];
    for (const event of events) await harness.publish(event);
    await harness.flush();
    expect(delivered).toEqual([
      'reasoning-start',
      'reasoning-delta',
      'tool-status',
      'assistant-delta',
      'terminal',
    ]);
    expect(store.records().map((record) => record.ordinal)).toEqual([1, 2, 3, 4, 5]);
    await harness.application.shutdown();
  });
});
