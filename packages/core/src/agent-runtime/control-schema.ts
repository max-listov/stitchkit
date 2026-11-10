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

/**
 * Every code a control response or a controller state can carry — one
 * vocabulary for the server, the realtime binding and the browser controller.
 * `FORBIDDEN` is an access denial (including a revoked grant) and
 * `CONNECTION_CLOSED` a connection that no longer exists, as elsewhere in the
 * library; the `*_CAPACITY` codes name the bound that refused the request.
 */
export const AgentControlErrorCodeSchema = z.enum([
  'ATTACH_CANCELLED',
  'ATTACH_IN_PROGRESS',
  'ATTACHMENT_CAPACITY',
  'CONNECTION_CLOSED',
  'CONTROL_REQUEST_FAILED',
  'EVENT_OVERFLOW',
  'FORBIDDEN',
  'LEASE_CONFLICT',
  'LEASE_REQUIRED',
  'NOT_ATTACHED',
  'REQUEST_CANCELLED',
  'REQUEST_CAPACITY',
  'REQUEST_REJECTED',
  'RESYNC_EXHAUSTED',
]);
/**
 * One of the codes in `AgentControlErrorCodeSchema`, reported in a failed control response or
 * controller state.
 */
export type AgentControlErrorCode = z.infer<typeof AgentControlErrorCodeSchema>;

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
    error: z
      .object({ code: AgentControlErrorCodeSchema, message: z.string().min(1) })
      .strict(),
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
  // Access to the conversation ended while events were flowing: the server has
  // detached it, and nothing further will arrive until the caller attaches again.
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('access-denied'),
      conversationId: z.string().min(1),
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

function durable(event: AgentRuntimeEvent): event is Extract<
  AgentRuntimeEvent,
  {
    type: 'admission' | 'assistant-checkpoint' | 'run-state' | 'run-operation' | 'terminal';
  }
> {
  return [
    'admission',
    'assistant-checkpoint',
    'run-state',
    'run-operation',
    'terminal',
  ].includes(event.type);
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

/** A tool call still running, with the last progress it reported. */
export interface AgentToolActivity {
  toolName: string;
  message?: string;
  progress?: number;
  total?: number;
}

/** What a run shows while it streams, before its next checkpoint makes it durable. */
export interface AgentRunTransient {
  text: string;
  reasoning: string;
  /** Running tool calls that reported progress, by call id; a call leaves on its terminal status. */
  tools: Readonly<Record<string, AgentToolActivity>>;
}

export interface AgentConversationView {
  snapshot?: AgentSnapshot;
  resyncRequired: boolean;
  transientByRun: Readonly<Record<string, AgentRunTransient>>;
}

const EMPTY_TRANSIENT: AgentRunTransient = { text: '', reasoning: '', tools: {} };

/** The run's transient state after one event; an event that is not about it leaves it as it was. */
function nextRunTransient(
  transient: AgentRunTransient,
  event: AgentRuntimeEvent,
): AgentRunTransient {
  switch (event.type) {
    case 'assistant-delta':
      return { ...transient, text: transient.text + event.textDelta };
    case 'reasoning-delta':
      return { ...transient, reasoning: transient.reasoning + event.textDelta };
    case 'attempt-reset':
      return EMPTY_TRANSIENT;
    case 'tool-progress': {
      const { toolName, message, progress, total } = event;
      return {
        ...transient,
        tools: {
          ...transient.tools,
          [event.callId]: {
            toolName,
            ...(message !== undefined && { message }),
            ...(progress !== undefined && { progress }),
            ...(total !== undefined && { total }),
          },
        },
      };
    }
    case 'tool-status': {
      if (event.status === 'started' || !Object.hasOwn(transient.tools, event.callId)) {
        return transient;
      }
      return {
        ...transient,
        tools: Object.fromEntries(
          Object.entries(transient.tools).filter(([callId]) => callId !== event.callId),
        ),
      };
    }
    default:
      return transient;
  }
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
  const nextTransient = nextRunTransient(
    current.transientByRun[event.runId] ?? EMPTY_TRANSIENT,
    event,
  );
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
