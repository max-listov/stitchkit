import { z } from 'zod';
import { type AgentRuntimeEvent, AgentRuntimeEventSchema } from './event-schema';
import { AgentMessagePartSchema, type AgentSnapshot, AgentSnapshotSchema } from './schemas';

const AgentControlIdentitySchema = z
  .object({ schemaVersion: z.literal(1), requestId: z.string().min(1) })
  .strict();

export const AgentControlRequestSchema = z.discriminatedUnion('operation', [
  AgentControlIdentitySchema.extend({
    operation: z.literal('attach'),
    conversationId: z.string().min(1),
    access: z.enum(['observe', 'control']),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('detach'),
    conversationId: z.string().min(1),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('snapshot'),
    conversationId: z.string().min(1),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('submit'),
    conversationId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    context: z.unknown(),
    parts: z.array(AgentMessagePartSchema).min(1),
    metadata: z.unknown().optional(),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('interrupt'),
    conversationId: z.string().min(1),
    runId: z.string().min(1),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('respond-approval'),
    conversationId: z.string().min(1),
    approvalId: z.string().min(1),
    approved: z.boolean(),
    reason: z.string().min(1).optional(),
    context: z.unknown(),
    metadata: z.unknown().optional(),
  }),
]);
export type AgentControlRequest = z.infer<typeof AgentControlRequestSchema>;

const AgentControlResponseIdentitySchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().min(1),
});
export const AgentControlResponseSchema = z.discriminatedUnion('outcome', [
  AgentControlResponseIdentitySchema.extend({
    outcome: z.literal('ok'),
    snapshot: AgentSnapshotSchema.optional(),
    runId: z.string().min(1).optional(),
  }).strict(),
  AgentControlResponseIdentitySchema.extend({
    outcome: z.literal('error'),
    error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict(),
  }).strict(),
]);
export type AgentControlResponse = z.infer<typeof AgentControlResponseSchema>;

export const AgentControlDeliverySchema = z.discriminatedUnion('type', [
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('event'),
      event: AgentRuntimeEventSchema,
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('resync-required'),
      conversationId: z.string().min(1),
      reason: z.literal('overflow'),
    })
    .strict(),
]);
export type AgentControlDelivery = z.infer<typeof AgentControlDeliverySchema>;

export const AgentMultiSessionCursorSchema = z
  .object({
    conversations: z.record(
      z.string(),
      z
        .object({
          snapshotVersion: z.int().nonnegative().optional(),
          durableEventIds: z.array(z.string().min(1)).optional(),
          runs: z.record(
            z.string(),
            z
              .object({ runtimeEpoch: z.string().min(1), sequence: z.int().nonnegative() })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();
export type AgentMultiSessionCursor = z.infer<typeof AgentMultiSessionCursorSchema>;

function durable(
  event: AgentRuntimeEvent,
): event is Extract<
  AgentRuntimeEvent,
  { type: 'admission' | 'assistant-checkpoint' | 'run-state' | 'terminal' }
> {
  return ['admission', 'assistant-checkpoint', 'run-state', 'terminal'].includes(event.type);
}

export function advanceAgentMultiSessionCursor(
  raw: AgentMultiSessionCursor,
  event: AgentRuntimeEvent,
): { status: 'accepted' | 'duplicate' | 'gap'; cursor: AgentMultiSessionCursor } {
  const cursor = AgentMultiSessionCursorSchema.parse(raw);
  const previous = cursor.conversations[event.conversationId] ?? { runs: {} };
  if (durable(event)) {
    const ids =
      previous.snapshotVersion === event.snapshotVersion
        ? (previous.durableEventIds ?? [])
        : [];
    if (
      (previous.snapshotVersion !== undefined &&
        event.snapshotVersion < previous.snapshotVersion) ||
      ids.includes(event.eventId)
    ) {
      return { status: 'duplicate', cursor };
    }
    return {
      status: 'accepted',
      cursor: {
        conversations: {
          ...cursor.conversations,
          [event.conversationId]: {
            ...previous,
            snapshotVersion: event.snapshotVersion,
            durableEventIds: [...ids, event.eventId],
          },
        },
      },
    };
  }
  const run = previous.runs[event.runId];
  const sequence = run?.runtimeEpoch === event.runtimeEpoch ? run.sequence : undefined;
  if (sequence !== undefined && event.sequence <= sequence)
    return { status: 'duplicate', cursor };
  const expected = sequence === undefined ? 1 : sequence + 1;
  return {
    status: event.sequence === expected ? 'accepted' : 'gap',
    cursor: {
      conversations: {
        ...cursor.conversations,
        [event.conversationId]: {
          ...previous,
          runs: {
            ...previous.runs,
            [event.runId]: { runtimeEpoch: event.runtimeEpoch, sequence: event.sequence },
          },
        },
      },
    },
  };
}

export interface AgentConversationView {
  snapshot?: AgentSnapshot;
  resyncRequired: boolean;
  transientByRun: Readonly<Record<string, { text: string; reasoning: string }>>;
}
export interface AgentControlView {
  cursor: AgentMultiSessionCursor;
  conversations: Readonly<Record<string, AgentConversationView>>;
}

export function createAgentControlView(): AgentControlView {
  return { cursor: { conversations: {} }, conversations: {} };
}

export function reduceAgentControlSnapshot(
  view: AgentControlView,
  rawSnapshot: AgentSnapshot,
): AgentControlView {
  const snapshot = AgentSnapshotSchema.parse(rawSnapshot);
  const previous = view.cursor.conversations[snapshot.conversationId] ?? { runs: {} };
  return {
    cursor: {
      conversations: {
        ...view.cursor.conversations,
        [snapshot.conversationId]: {
          ...previous,
          snapshotVersion: snapshot.version,
          durableEventIds: [],
        },
      },
    },
    conversations: {
      ...view.conversations,
      [snapshot.conversationId]: {
        snapshot,
        resyncRequired: false,
        transientByRun: {},
      },
    },
  };
}

export function reduceAgentControlEvent(
  view: AgentControlView,
  rawEvent: AgentRuntimeEvent,
): AgentControlView {
  const event = AgentRuntimeEventSchema.parse(rawEvent);
  const advanced = advanceAgentMultiSessionCursor(view.cursor, event);
  if (advanced.status === 'duplicate') return view;
  const current = view.conversations[event.conversationId] ?? {
    resyncRequired: false,
    transientByRun: {},
  };
  if (advanced.status === 'gap') {
    return {
      cursor: advanced.cursor,
      conversations: {
        ...view.conversations,
        [event.conversationId]: { ...current, resyncRequired: true },
      },
    };
  }
  const transient = current.transientByRun[event.runId] ?? { text: '', reasoning: '' };
  const nextTransient =
    event.type === 'assistant-delta'
      ? { ...transient, text: transient.text + event.textDelta }
      : event.type === 'reasoning-delta'
        ? { ...transient, reasoning: transient.reasoning + event.textDelta }
        : transient;
  const snapshotStale = durable(event) && current.snapshot?.version !== event.snapshotVersion;
  const transientByRun =
    event.type === 'terminal'
      ? Object.fromEntries(
          Object.entries(current.transientByRun).filter(([runId]) => runId !== event.runId),
        )
      : { ...current.transientByRun, [event.runId]: nextTransient };
  return {
    cursor: advanced.cursor,
    conversations: {
      ...view.conversations,
      [event.conversationId]: {
        ...current,
        resyncRequired: current.resyncRequired || snapshotStale,
        transientByRun,
      },
    },
  };
}
