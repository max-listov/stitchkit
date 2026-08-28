import { createBoundedSinkManager } from '../internal/observability-sink';
import type { ObservabilitySinkStatus } from '../observability/status';
import {
  type AgentRuntimeEvent,
  AgentRuntimeEventSchema,
  type AgentRuntimePublisher,
} from './event-schema';

export * from './event-schema';

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
