import { z } from 'zod';
import {
  AgentControlDeliveryOutcomeSchema,
  AgentHostStatusSchema,
  AgentInputAnswerSchema,
  AgentPendingApprovalSchema,
  AgentPendingInputSchema,
  AgentPermissionModeSchema,
  AgentWriteOperationSchema,
} from './control-interaction-schema';
import { isDurableAgentRuntimeEvent } from './event-durability';
import { type AgentRuntimeEvent, AgentRuntimeEventSchema } from './event-schema';
import { AgentMessagePartSchema, AgentSnapshotSchema, AgentTimestampSchema } from './schemas';

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
    idempotencyKey: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    context: z.unknown(),
    metadata: z.unknown().optional(),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('respond-input'),
    conversationId: z.string().min(1),
    inputId: z.string().min(1),
    idempotencyKey: z.string().min(1).optional(),
    answer: AgentInputAnswerSchema,
    context: z.unknown(),
    metadata: z.unknown().optional(),
  }),
  AgentControlIdentitySchema.extend({
    operation: z.literal('set-permission-mode'),
    conversationId: z.string().min(1),
    permissionMode: AgentPermissionModeSchema,
    context: z.unknown(),
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
  'HOST_OFFLINE',
  'LEASE_CONFLICT',
  'LEASE_REQUIRED',
  'NOT_ATTACHED',
  'REQUEST_CANCELLED',
  'REQUEST_CAPACITY',
  'REQUEST_REJECTED',
  'RESYNC_EXHAUSTED',
  'UNSUPPORTED_OPERATION',
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
  AgentControlResponseIdentitySchema.extend({
    outcome: z.literal('unknown'),
    delivery: z.literal('unknown'),
    idempotencyKey: z.string().min(1).optional(),
    message: z.string().min(1).optional(),
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
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('approval-state'),
      conversationId: z.string().min(1),
      pendingApprovals: z.array(AgentPendingApprovalSchema),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('input-state'),
      conversationId: z.string().min(1),
      pendingInputs: z.array(AgentPendingInputSchema),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('permission-mode'),
      conversationId: z.string().min(1),
      permissionMode: AgentPermissionModeSchema,
      supportedPermissionModes: z.array(AgentPermissionModeSchema).optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('host-status'),
      conversationId: z.string().min(1),
      hostStatus: AgentHostStatusSchema,
      validUntil: AgentTimestampSchema.optional(),
      reason: z.string().min(1).optional(),
      observedAt: AgentTimestampSchema.optional(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      type: z.literal('delivery-state'),
      conversationId: z.string().min(1),
      requestId: z.string().min(1),
      operation: AgentWriteOperationSchema,
      delivery: AgentControlDeliveryOutcomeSchema,
      idempotencyKey: z.string().min(1).optional(),
      reason: z.string().min(1).optional(),
      recordedAt: AgentTimestampSchema.optional(),
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

export function advanceAgentMultiSessionCursor(
  raw: AgentMultiSessionCursor,
  event: AgentRuntimeEvent,
): { status: 'accepted' | 'duplicate' | 'gap'; cursor: AgentMultiSessionCursor } {
  const cursor = AgentMultiSessionCursorSchema.parse(raw);
  const previous = cursor.conversations[event.conversationId] ?? { runs: {} };
  if (isDurableAgentRuntimeEvent(event)) {
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
