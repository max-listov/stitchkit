import { z } from 'zod';
import {
  createBoundedSinkManager,
  type ObservabilityDrainBound,
} from '../internal/observability-sink';
import type { ObservabilitySinkStatus } from '../observability/status';
import {
  ApplicationHealthSchema,
  ApplicationIdSchema,
  ApplicationLifecycleSchema,
  type ApplicationSnapshot,
  ManagedResourceSnapshotSchema,
} from './schemas';

export const ApplicationLifecycleEventSchema = z
  .object({
    type: z.literal('application-state'),
    applicationId: ApplicationIdSchema,
    epoch: z.string().uuid(),
    revision: z.number().int().nonnegative(),
    lifecycle: ApplicationLifecycleSchema,
    health: ApplicationHealthSchema,
    ready: z.boolean(),
    capturedAt: z.string().datetime({ offset: true }),
    resources: z.array(ManagedResourceSnapshotSchema).readonly(),
  })
  .strict()
  .readonly();
export type ApplicationLifecycleEvent = z.infer<typeof ApplicationLifecycleEventSchema>;

export function applicationLifecycleEvent(
  snapshot: ApplicationSnapshot,
): ApplicationLifecycleEvent {
  return ApplicationLifecycleEventSchema.parse({
    type: 'application-state',
    applicationId: snapshot.id,
    epoch: snapshot.epoch,
    revision: snapshot.revision,
    lifecycle: snapshot.lifecycle,
    health: snapshot.health,
    ready: snapshot.ready,
    capturedAt: snapshot.capturedAt,
    resources: snapshot.resources,
  });
}

export interface ApplicationEventSinkConfig {
  write(event: ApplicationLifecycleEvent): void | Promise<void>;
  maxPending?: number;
  onSinkError?(failure: {
    error: unknown;
    event?: ApplicationLifecycleEvent;
  }): void | Promise<void>;
}

export interface ApplicationEventSink {
  publish(snapshot: ApplicationSnapshot): void;
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

/** Failure-isolated operator event delivery; canonical truth remains the absolute snapshot. */
export function createApplicationEventSink(
  config: ApplicationEventSinkConfig,
): ApplicationEventSink {
  const manager = createBoundedSinkManager<ApplicationLifecycleEvent>({
    write: config.write,
    ...(config.maxPending !== undefined && { maxPending: config.maxPending }),
    ...(config.onSinkError && { onSinkError: config.onSinkError }),
  });
  return {
    publish(snapshot) {
      manager.submit(() => applicationLifecycleEvent(snapshot));
    },
    flush: (bound) => manager.flush(bound),
    getStatus: () => manager.getStatus(),
    close: (bound) => manager.close(bound),
  };
}
