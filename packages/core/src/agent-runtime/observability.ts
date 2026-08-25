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
  /** Raw internal causes are excluded unless an operator-only sink opts in. */
  includeInternalCause?: boolean;
  deduplicate?: boolean;
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
  // Deduplication is on by default and a runtime can execute indefinitely, so
  // the memory of what was already emitted has to forget. A ring keeps the
  // window a fixed size: an event id repeated within it is dropped, and one
  // repeated after the runtime has moved on by this many events is not — which
  // is the honest trade, because a duplicate that far apart is a real re-emit.
  // A real ring: a fixed slot array and a cursor. `shift()` on a
  // ten-thousand-element array is O(window) and runs on every event once the
  // window is full — bounded memory, but a cost that grows with the window on
  // the hot path. Overwriting one slot is O(1) whatever the window is.
  const DEDUPLICATION_WINDOW = 10_000;
  const emitted = new Set<string>();
  const ring: Array<string | undefined> = new Array(DEDUPLICATION_WINDOW).fill(undefined);
  let cursor = 0;
  const remember = (eventId: string): void => {
    emitted.add(eventId);
    const evicted = ring[cursor];
    ring[cursor] = eventId;
    cursor = (cursor + 1) % DEDUPLICATION_WINDOW;
    if (evicted !== undefined) emitted.delete(evicted);
  };
  return {
    rootTrace(parent) {
      const trace = parent ? childSpan(parent) : createTraceContext();
      return trace;
    },
    emit(rawEvent) {
      const parsed = AgentRunEventSchema.parse(rawEvent);
      if ((config.deduplicate ?? true) && emitted.has(parsed.eventId)) return;
      remember(parsed.eventId);
      manager.submit(() =>
        config.includeInternalCause
          ? parsed
          : AgentRunEventSchema.omit({ internalCause: true }).parse(parsed),
      );
    },
    flush: () => manager.flush(),
    getStatus: () => manager.getStatus(),
    close: () => manager.close(),
  };
}
