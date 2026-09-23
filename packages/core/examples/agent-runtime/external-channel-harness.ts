import { type AgentRuntimeEvent, AgentRuntimeEventSchema } from 'stitchkit/agent-runtime';
import {
  type ApplicationHandle,
  createApplication,
  createBoundedAdmission,
  createBoundedChannel,
  defineManagedResource,
} from 'stitchkit/application';
import { z } from 'zod';

export const ExternalIngressSchema = z.object({
  updateId: z.string().min(1),
  principalId: z.string().min(1),
  conversationId: z.string().min(1),
  replyTarget: z.string().min(1),
  text: z.string(),
});
export const ExternalIngressRecordSchema = ExternalIngressSchema.extend({
  idempotencyKey: z.string().min(1),
  runId: z.string().min(1).optional(),
});
export const ExternalOutboxRecordSchema = z.object({
  deliveryId: z.string().min(1),
  eventKey: z.string().min(1),
  conversationId: z.string().min(1),
  runId: z.string().min(1),
  replyTarget: z.string().min(1),
  event: AgentRuntimeEventSchema,
  ordinal: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  state: z.enum(['not-dispatched', 'possibly-dispatched', 'acknowledged']),
  attemptId: z.string().min(1).optional(),
  receiptId: z.string().min(1).optional(),
});

export type ExternalIngress = z.output<typeof ExternalIngressSchema>;
export type ExternalIngressRecord = z.output<typeof ExternalIngressRecordSchema>;
export type ExternalOutboxRecord = z.output<typeof ExternalOutboxRecordSchema>;

/** Durable, transactional application boundary; process-local channels are wakeups only. */
export interface ExternalChannelStore {
  admit(
    ingress: ExternalIngress,
  ): Promise<{ outcome: 'created' | 'duplicate'; record: ExternalIngressRecord }>;
  bindRun(updateId: string, runId: string): Promise<ExternalIngressRecord>;
  replyTarget(conversationId: string): Promise<string | undefined>;
  enqueue(input: {
    eventKey: string;
    conversationId: string;
    runId: string;
    replyTarget: string;
    event: AgentRuntimeEvent;
  }): Promise<{ outcome: 'created' | 'duplicate'; record: ExternalOutboxRecord }>;
  nextReady(): Promise<ExternalOutboxRecord | undefined>;
  markPossiblyDispatched(
    deliveryId: string,
    expectedRevision: number,
    attemptId: string,
  ): Promise<ExternalOutboxRecord | undefined>;
  acknowledge(
    deliveryId: string,
    expectedRevision: number,
    receiptId: string,
  ): Promise<ExternalOutboxRecord | undefined>;
  possiblyDispatched(): Promise<readonly ExternalOutboxRecord[]>;
}

export interface ExternalDeliveryAdapter {
  send(input: {
    deliveryId: string;
    attemptId: string;
    replyTarget: string;
    event: AgentRuntimeEvent;
    signal: AbortSignal;
  }): Promise<{ receiptId: string }>;
  reconcile(input: {
    deliveryId: string;
    attemptId: string;
    replyTarget: string;
    signal: AbortSignal;
  }): Promise<{ outcome: 'unknown' } | { outcome: 'acknowledged'; receiptId: string }>;
}

export interface ExternalChannelHarness {
  readonly application: ApplicationHandle;
  ingest(
    input: ExternalIngress,
  ): Promise<{ outcome: 'accepted' | 'duplicate'; runId: string }>;
  publish(event: AgentRuntimeEvent): Promise<void>;
  flush(): Promise<void>;
  reconcile(): Promise<void>;
}

/** The small structural seam a real AgentRuntime already satisfies. */
export interface ExternalChannelAgentRuntime {
  submit(input: {
    conversationId: string;
    idempotencyKey: string;
    context: unknown;
    parts: readonly { type: 'text'; text: string }[];
  }): {
    accepted: Promise<void>;
    admission: Promise<{ runId: string }>;
  };
}

function eventKey(event: AgentRuntimeEvent): string {
  if ('eventId' in event) return event.eventId;
  return `${event.runtimeEpoch}:${event.sequence}`;
}

function shouldDeliver(
  event: AgentRuntimeEvent,
  policy: 'terminal-only' | 'streaming',
): boolean {
  if (policy === 'terminal-only') return event.type === 'terminal';
  return event.type !== 'admission' && event.type !== 'run-state';
}

export function createExternalChannelHarness(config: {
  runtime: ExternalChannelAgentRuntime;
  store: ExternalChannelStore;
  delivery: ExternalDeliveryAdapter;
  outputPolicy?: 'terminal-only' | 'streaming';
  onDeliveryError?: (error: unknown) => void | Promise<void>;
}): ExternalChannelHarness {
  const outputPolicy = config.outputPolicy ?? 'terminal-only';
  const admission = createBoundedAdmission({
    policy: { global: { maxConcurrent: 8 }, perKey: { maxConcurrent: 1, maxKeys: 10_000 } },
  });
  const wakeups = createBoundedChannel<string>({
    policy: 'latest',
    maxItems: 1,
    maxBytes: 128,
    sizeOf: (value) => value.length,
  });
  const abort = new AbortController();
  let pumping: Promise<void> | undefined;

  const deliverOne = async (): Promise<boolean> => {
    const record = await config.store.nextReady();
    if (!record) return false;
    const attemptId = crypto.randomUUID();
    const prepared = await config.store.markPossiblyDispatched(
      record.deliveryId,
      record.revision,
      attemptId,
    );
    if (!prepared) return true;
    const delivered = await config.delivery.send({
      deliveryId: prepared.deliveryId,
      attemptId,
      replyTarget: prepared.replyTarget,
      event: prepared.event,
      signal: abort.signal,
    });
    await config.store.acknowledge(
      prepared.deliveryId,
      prepared.revision,
      delivered.receiptId,
    );
    return true;
  };

  const runPump = async (): Promise<void> => {
    try {
      try {
        while (await deliverOne()) {
          // The durable store owns ordering; the bounded channel only wakes this loop.
        }
      } catch (error) {
        await config.onDeliveryError?.(error);
      }
    } finally {
      pumping = undefined;
    }
  };

  const flush = (): Promise<void> => {
    pumping ??= runPump();
    return pumping;
  };

  const completion = async (): Promise<void> => {
    for await (const _wakeup of wakeups) await flush();
  };
  const resource = defineManagedResource({
    id: 'external-channel-delivery',
    start(context) {
      context.reportHealth('healthy');
      return { completion: completion() };
    },
    stopAdmission() {
      admission.stopAdmission();
    },
    async drain() {
      await flush();
      await admission.drain();
    },
    close() {
      abort.abort();
      wakeups.close({ mode: 'discard' });
    },
    force() {
      abort.abort();
      wakeups.close({ mode: 'discard' });
      admission.force();
    },
  });
  const application = createApplication({
    id: 'external-channel-harness',
    resources: [resource],
  });

  const ingest = async (
    raw: ExternalIngress,
  ): Promise<{ outcome: 'accepted' | 'duplicate'; runId: string }> => {
    const input = ExternalIngressSchema.parse(raw);
    return application.admission.run(() =>
      admission.run(input.principalId, async () => {
        const admitted = await config.store.admit(input);
        if (admitted.record.runId) {
          return { outcome: 'duplicate', runId: admitted.record.runId };
        }
        const ticket = config.runtime.submit({
          conversationId: admitted.record.conversationId,
          idempotencyKey: admitted.record.idempotencyKey,
          context: { principalId: admitted.record.principalId },
          parts: [{ type: 'text', text: admitted.record.text }],
        });
        await ticket.accepted;
        const runtimeAdmission = await ticket.admission;
        await config.store.bindRun(admitted.record.updateId, runtimeAdmission.runId);
        return {
          outcome: admitted.outcome === 'duplicate' ? 'duplicate' : 'accepted',
          runId: runtimeAdmission.runId,
        };
      }),
    );
  };

  const publish = async (event: AgentRuntimeEvent): Promise<void> => {
    if (!shouldDeliver(event, outputPolicy)) return;
    const replyTarget = await config.store.replyTarget(event.conversationId);
    if (!replyTarget) return;
    await config.store.enqueue({
      eventKey: eventKey(event),
      conversationId: event.conversationId,
      runId: event.runId,
      replyTarget,
      event,
    });
    wakeups.offer(event.conversationId);
  };

  const reconcile = async (): Promise<void> => {
    for (const record of await config.store.possiblyDispatched()) {
      if (!record.attemptId) continue;
      const outcome = await config.delivery.reconcile({
        deliveryId: record.deliveryId,
        attemptId: record.attemptId,
        replyTarget: record.replyTarget,
        signal: abort.signal,
      });
      if (outcome.outcome === 'acknowledged') {
        await config.store.acknowledge(record.deliveryId, record.revision, outcome.receiptId);
      }
    }
  };

  return { application, ingest, publish, flush, reconcile };
}
