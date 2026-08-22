import { z } from 'zod';
import { createBoundedSinkManager } from '../internal/observability-sink';
import type { ObservabilitySinkStatus } from '../observability/status';
import { childSpan, createTraceContext } from '../observability/trace';
import {
  AgentRecordIdSchema,
  AgentRunStateSchema,
  AgentTerminalReasonSchema,
  AgentTimestampSchema,
  AgentUsageSchema,
} from './schemas';

export const AgentRunEventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: AgentRecordIdSchema,
  type: z.enum(['run-started', 'step-finished', 'run-terminal']),
  conversationId: AgentRecordIdSchema,
  runId: AgentRecordIdSchema,
  traceId: z.string().min(1),
  spanId: z.string().min(1),
  parentSpanId: z.string().min(1).optional(),
  state: AgentRunStateSchema,
  terminalReason: AgentTerminalReasonSchema.optional(),
  modelId: z.string().min(1).optional(),
  step: z.int().nonnegative().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  ttftMs: z.number().nonnegative().optional(),
  usage: AgentUsageSchema.optional(),
  internalCause: z.unknown().optional(),
  emittedAt: AgentTimestampSchema,
});

export type AgentRunEvent = z.infer<typeof AgentRunEventSchema>;

export interface AgentRunSinkError {
  error: unknown;
  event?: AgentRunEvent;
}

export interface AgentRunSinkDrop {
  reason: 'capacity' | 'closed';
  event: AgentRunEvent;
  pending: number;
}

export interface AgentRunSinkConfig {
  write(event: AgentRunEvent): void | Promise<void>;
  filter?(event: AgentRunEvent): boolean;
  maxPending?: number;
  onSinkError?(failure: AgentRunSinkError): void | Promise<void>;
  onDrop?(drop: AgentRunSinkDrop): void | Promise<void>;
}

export interface AgentObservability {
  rootTrace(parent?: { traceId: string; spanId: string }): {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
  };
  emit(event: AgentRunEvent): void;
  flush(): Promise<void>;
  getStatus(): ObservabilitySinkStatus;
  close(): Promise<ObservabilitySinkStatus>;
}

export function createAgentObservability(config: AgentRunSinkConfig): AgentObservability {
  const manager = createBoundedSinkManager<AgentRunEvent>({
    write: config.write,
    ...(config.filter && { filter: config.filter }),
    ...(config.maxPending !== undefined && { maxPending: config.maxPending }),
    ...(config.onSinkError && { onSinkError: config.onSinkError }),
    ...(config.onDrop && { onDrop: config.onDrop }),
  });
  return {
    rootTrace(parent) {
      const trace = parent ? childSpan(parent) : createTraceContext();
      return trace;
    },
    emit(rawEvent) {
      manager.submit(() => AgentRunEventSchema.parse(rawEvent));
    },
    flush: () => manager.flush(),
    getStatus: () => manager.getStatus(),
    close: () => manager.close(),
  };
}
