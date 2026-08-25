import { z } from 'zod';
import { createBoundedSinkManager } from '../internal/observability-sink';
import type { ObservabilitySinkStatus } from '../observability/status';
import {
  AgentAssistantPlaceholderSchema,
  AgentMessageSchema,
  AgentProviderEnvelopeSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
  AgentRunMetricsSchema,
  AgentRunSchema,
  AgentRunStateSchema,
  AgentTerminalReasonSchema,
  AgentTimestampSchema,
} from './schemas';

export const AgentAdmissionEventSchema = z.object({
  type: z.literal('admission'),
  eventId: AgentRecordIdSchema,
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  input: AgentMessageSchema,
  run: AgentRunSchema,
  assistant: z.union([AgentAssistantPlaceholderSchema, AgentMessageSchema]),
  emittedAt: AgentTimestampSchema,
});

const EventIdentitySchema = z.object({
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  emittedAt: AgentTimestampSchema,
});

/**
 * `runtimeEpoch` is one identity generated per `createAgentRuntime()`. It is the
 * same value the store holds as `AgentRun.ownerId`; each name states the role it
 * plays where it appears. A changed epoch on the same conversation means the
 * runtime restarted, which is how a consumer detects a gap in a transient
 * stream that durable checkpoints would not show.
 */
export const AgentTransientDeltaEventSchema = EventIdentitySchema.extend({
  type: z.literal('assistant-delta'),
  runtimeEpoch: z.string().min(1),
  sequence: z.int().nonnegative(),
  textDelta: z.string(),
});

const AgentTransientReasoningIdentitySchema = EventIdentitySchema.extend({
  runtimeEpoch: z.string().min(1),
  sequence: z.int().nonnegative(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentReasoningStartEventSchema = AgentTransientReasoningIdentitySchema.extend({
  type: z.literal('reasoning-start'),
});

export const AgentReasoningDeltaEventSchema = AgentTransientReasoningIdentitySchema.extend({
  type: z.literal('reasoning-delta'),
  textDelta: z.string(),
});

export const AgentReasoningEndEventSchema = AgentTransientReasoningIdentitySchema.extend({
  type: z.literal('reasoning-end'),
});

export const AgentCheckpointEventSchema = EventIdentitySchema.extend({
  type: z.literal('assistant-checkpoint'),
  eventId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  message: AgentMessageSchema,
  metrics: AgentRunMetricsSchema.optional(),
});

export const AgentRunStateEventSchema = EventIdentitySchema.extend({
  type: z.literal('run-state'),
  eventId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  state: AgentRunStateSchema,
});

export const AgentToolStatusEventSchema = EventIdentitySchema.extend({
  type: z.literal('tool-status'),
  runtimeEpoch: z.string().min(1),
  sequence: z.int().nonnegative(),
  callId: AgentRecordIdSchema,
  toolName: z.string().min(1),
  status: z.enum(['started', 'completed', 'failed', 'interrupted']),
  input: z.json().optional(),
  output: z.json().optional(),
});

export const AgentTerminalEventSchema = EventIdentitySchema.extend({
  type: z.literal('terminal'),
  eventId: AgentRecordIdSchema,
  snapshotVersion: AgentRecordVersionSchema,
  reason: AgentTerminalReasonSchema,
  policyName: z.string().min(1).optional(),
  message: AgentMessageSchema,
  metrics: AgentRunMetricsSchema.optional(),
});

export const AgentRuntimeEventSchema = z.discriminatedUnion('type', [
  AgentAdmissionEventSchema,
  AgentTransientDeltaEventSchema,
  AgentReasoningStartEventSchema,
  AgentReasoningDeltaEventSchema,
  AgentReasoningEndEventSchema,
  AgentCheckpointEventSchema,
  AgentRunStateEventSchema,
  AgentToolStatusEventSchema,
  AgentTerminalEventSchema,
]);

export type AgentRuntimeEvent = z.infer<typeof AgentRuntimeEventSchema>;
export type AgentRuntimePublisher = (event: AgentRuntimeEvent) => void | Promise<void>;

export const AgentRuntimeEventCursorSchema = z.object({
  snapshotVersion: AgentRecordVersionSchema.optional(),
  durableEventIds: z.array(AgentRecordIdSchema).optional(),
  runtimeEpoch: z.string().min(1).optional(),
  sequence: z.int().nonnegative().optional(),
});

export type AgentRuntimeEventCursor = z.infer<typeof AgentRuntimeEventCursorSchema>;

export interface AgentRuntimeCursorAdvance {
  status: 'accepted' | 'duplicate' | 'gap';
  cursor: AgentRuntimeEventCursor;
}

function isDurableEvent(
  event: AgentRuntimeEvent,
): event is Extract<
  AgentRuntimeEvent,
  { type: 'admission' | 'assistant-checkpoint' | 'run-state' | 'terminal' }
> {
  return (
    event.type === 'admission' ||
    event.type === 'assistant-checkpoint' ||
    event.type === 'run-state' ||
    event.type === 'terminal'
  );
}

/** Detect duplicate or missing delivery so reconnect can reload the durable snapshot. */
export function advanceAgentRuntimeEventCursor(
  rawCursor: AgentRuntimeEventCursor,
  event: AgentRuntimeEvent,
): AgentRuntimeCursorAdvance {
  const cursor = AgentRuntimeEventCursorSchema.parse(rawCursor);
  if (isDurableEvent(event)) {
    const previous = cursor.snapshotVersion;
    const durableEventIds =
      previous === event.snapshotVersion ? (cursor.durableEventIds ?? []) : [];
    if (
      (previous !== undefined && event.snapshotVersion < previous) ||
      durableEventIds.includes(event.eventId)
    ) {
      return { status: 'duplicate', cursor };
    }
    return {
      status:
        previous !== undefined && event.snapshotVersion > previous + 1 ? 'gap' : 'accepted',
      cursor: {
        ...cursor,
        snapshotVersion: event.snapshotVersion,
        durableEventIds: [...durableEventIds, event.eventId],
      },
    };
  }
  const previousSequence =
    cursor.runtimeEpoch === event.runtimeEpoch ? cursor.sequence : undefined;
  if (previousSequence !== undefined && event.sequence <= previousSequence) {
    return { status: 'duplicate', cursor };
  }
  return {
    status:
      previousSequence !== undefined && event.sequence > previousSequence + 1
        ? 'gap'
        : 'accepted',
    cursor: { ...cursor, runtimeEpoch: event.runtimeEpoch, sequence: event.sequence },
  };
}

export interface AgentRuntimeEventSinkConfig {
  write(event: AgentRuntimeEvent): void | Promise<void>;
  project?(event: AgentRuntimeEvent): AgentRuntimeEvent | undefined;
  maxPending?: number;
  onSinkError?(input: { error: unknown; event?: AgentRuntimeEvent }): void | Promise<void>;
  onDrop?(input: {
    reason: 'capacity' | 'closed';
    event: AgentRuntimeEvent;
    pending: number;
  }): void | Promise<void>;
}

export interface AgentRuntimeEventSink {
  publish: AgentRuntimePublisher;
  flush(): Promise<void>;
  getStatus(): ObservabilitySinkStatus;
  close(): Promise<ObservabilitySinkStatus>;
}

/** Bounded, failure-isolated transport-neutral delivery lifecycle. */
export function createAgentRuntimeEventSink(
  config: AgentRuntimeEventSinkConfig,
): AgentRuntimeEventSink {
  const manager = createBoundedSinkManager<AgentRuntimeEvent>({
    write: config.write,
    ...(config.maxPending !== undefined && { maxPending: config.maxPending }),
    ...(config.onSinkError && { onSinkError: config.onSinkError }),
    ...(config.onDrop && { onDrop: config.onDrop }),
  });
  return {
    publish(rawEvent) {
      const event = AgentRuntimeEventSchema.parse(rawEvent);
      const projected = config.project?.(event) ?? (config.project ? undefined : event);
      if (projected) manager.submit(() => AgentRuntimeEventSchema.parse(projected));
    },
    flush: () => manager.flush(),
    getStatus: () => manager.getStatus(),
    close: () => manager.close(),
  };
}

/** Stable identity for a post-CAS event; safe for outbox/dedup keys. */
export function agentDurableEventId(
  type: 'admission' | 'assistant-checkpoint' | 'run-state' | 'terminal',
  runId: string,
  snapshotVersion: number,
): string {
  return `${runId}:${type}:${snapshotVersion}`;
}
