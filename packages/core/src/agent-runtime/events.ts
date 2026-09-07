import {
  createBoundedSinkManager,
  type ObservabilityDrainBound,
} from '../internal/observability-sink';
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
  /** Whether the generation admitted before this call settled inside the bound. */
  flush(bound?: ObservabilityDrainBound): Promise<boolean>;
  getStatus(): ObservabilitySinkStatus;
  /**
   * Stop admission and drain. Bounded the same way as every other drain here:
   * without a bound it waits however long the sink takes, which is what used to
   * consume an entire application shutdown budget when a write never settled.
   */
  close(bound?: ObservabilityDrainBound): Promise<ObservabilitySinkStatus>;
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
    flush: (bound) => manager.flush(bound),
    getStatus: () => manager.getStatus(),
    close: (bound) => manager.close(bound),
  };
}
