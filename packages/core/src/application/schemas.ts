import { z } from 'zod';

export const ApplicationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
export type ApplicationId = z.infer<typeof ApplicationIdSchema>;

export const ApplicationLifecycleSchema = z.enum([
  'created',
  'starting',
  'ready',
  'draining',
  'stopping',
  'stopped',
  'failed',
]);
export type ApplicationLifecycle = z.infer<typeof ApplicationLifecycleSchema>;

export const ApplicationHealthSchema = z.enum(['unknown', 'healthy', 'degraded', 'unhealthy']);
export type ApplicationHealth = z.infer<typeof ApplicationHealthSchema>;

export const ManagedResourceStateSchema = z.enum([
  'registered',
  'starting',
  'ready',
  'failed',
  'stopping',
  'stopped',
]);
export type ManagedResourceState = z.infer<typeof ManagedResourceStateSchema>;

const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ApplicationAdmissionSnapshotSchema = z
  .object({
    accepting: z.boolean(),
    accepted: NonNegativeIntegerSchema,
    completed: NonNegativeIntegerSchema,
    pending: NonNegativeIntegerSchema,
  })
  .readonly();
export type ApplicationAdmissionSnapshot = z.infer<typeof ApplicationAdmissionSnapshotSchema>;

export const ManagedResourceSnapshotSchema = z
  .object({
    id: ApplicationIdSchema,
    required: z.boolean(),
    dependsOn: z.array(ApplicationIdSchema).readonly(),
    state: ManagedResourceStateSchema,
    health: ApplicationHealthSchema,
    ready: z.boolean(),
  })
  .readonly();
export type ManagedResourceSnapshot = z.infer<typeof ManagedResourceSnapshotSchema>;

export const ApplicationSnapshotSchema = z
  .object({
    id: ApplicationIdSchema,
    epoch: z.string().uuid(),
    revision: NonNegativeIntegerSchema,
    lifecycle: ApplicationLifecycleSchema,
    health: ApplicationHealthSchema,
    ready: z.boolean(),
    capturedAt: z.string().datetime({ offset: true }),
    changedAt: z.string().datetime({ offset: true }),
    admission: ApplicationAdmissionSnapshotSchema,
    resources: z.array(ManagedResourceSnapshotSchema).readonly(),
    /**
     * The resources a `restart` is replacing at this instant, in start order.
     * Empty whenever no restart is running.
     *
     * A field rather than a `lifecycle` member, and the reason is mechanical:
     * `acquire()` refuses a lease unless the lifecycle is exactly `ready`, so a
     * `restarting` lifecycle would close admission for the WHOLE graph while one
     * leaf is replaced — contradicting the thing a subtree restart exists to
     * promise. A `ManagedResourceState` member would not work either: the start
     * loop overwrites the record with `starting`, so it would describe only the
     * closing half of the window and vanish for the rest.
     *
     * Without it, a snapshot taken mid-restart is indistinguishable from a
     * resource that failed on its own, and an operator reading a dashboard acts
     * on the wrong one.
     */
    restarting: z.array(z.string()).readonly(),
  })
  .readonly();
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;

/**
 * What a probe or a status endpoint may publish.
 *
 * The internal snapshot names every resource and its `dependsOn` edges — the
 * application's dependency graph — plus the process epoch and live traffic
 * counters. That is the right shape for `getSnapshot()` and for telemetry, and
 * the wrong shape for a URL: these handlers are meant to be mounted publicly,
 * and an orchestrator needs a verdict, not our topology.
 *
 * `degraded` and `failed` counts keep the verdict actionable without saying
 * which resource: an operator reading a probe learns that something is wrong
 * and reaches for `getSnapshot()`, which never left the process.
 */
export const ApplicationStatusProjectionSchema = z
  .object({
    id: ApplicationIdSchema,
    lifecycle: ApplicationLifecycleSchema,
    health: ApplicationHealthSchema,
    ready: z.boolean(),
    capturedAt: z.string().datetime({ offset: true }),
    resources: z
      .object({
        total: NonNegativeIntegerSchema,
        ready: NonNegativeIntegerSchema,
        degraded: NonNegativeIntegerSchema,
        failed: NonNegativeIntegerSchema,
      })
      .readonly(),
    /**
     * How many resources a restart is replacing right now. Zero between restarts.
     *
     * The count, not the ids: this projection is meant to be mounted publicly and
     * the ids are the application dependency graph. Zero versus non-zero is the
     * whole question a probe has — is this resource missing because it broke, or
     * because it is being replaced.
     */
    restarting: NonNegativeIntegerSchema,
  })
  .readonly();
export type ApplicationStatusProjection = z.infer<typeof ApplicationStatusProjectionSchema>;

/** Project the internal snapshot onto what an endpoint may publish. */
export function projectApplicationStatus(
  snapshot: ApplicationSnapshot,
): ApplicationStatusProjection {
  let ready = 0;
  let degraded = 0;
  let failed = 0;
  for (const resource of snapshot.resources) {
    if (resource.ready) ready += 1;
    if (resource.health === 'degraded') degraded += 1;
    // `failed` is a lifecycle state, not a health value: a resource can be
    // unhealthy while still running, and failed while its last health reading
    // was stale. Count the state, which is the one an operator acts on.
    if (resource.state === 'failed') failed += 1;
  }
  return {
    id: snapshot.id,
    lifecycle: snapshot.lifecycle,
    health: snapshot.health,
    ready: snapshot.ready,
    capturedAt: snapshot.capturedAt,
    resources: { total: snapshot.resources.length, ready, degraded, failed },
    // The count, not the ids: a probe is mounted publicly and the ids are the
    // application's dependency graph. Zero means nothing is being replaced, and
    // that is the whole question a probe needs answered — is this resource
    // missing because it broke, or because we are replacing it right now.
    restarting: snapshot.restarting.length,
  };
}

export const ApplicationResourceShutdownSchema = z
  .object({
    id: ApplicationIdSchema,
    state: z.enum(['not-started', 'closed', 'force-failed']),
    failures: z
      .array(z.enum(['start', 'ready', 'completion', 'admission', 'drain', 'close', 'force']))
      .readonly(),
  })
  .readonly();
export type ApplicationResourceShutdown = z.infer<typeof ApplicationResourceShutdownSchema>;

export const ApplicationShutdownResultSchema = z
  .object({
    outcome: z.enum(['clean', 'forced']),
    reason: z.enum(['deadline', 'signal']).optional(),
    cleanupComplete: z.boolean(),
    acceptedOperations: NonNegativeIntegerSchema,
    completedOperations: NonNegativeIntegerSchema,
    pendingOperations: NonNegativeIntegerSchema,
    pendingOperationsAtForce: NonNegativeIntegerSchema,
    resources: z.array(ApplicationResourceShutdownSchema).readonly(),
    durationMs: z.number().nonnegative(),
  })
  .readonly();
export type ApplicationShutdownResult = z.infer<typeof ApplicationShutdownResultSchema>;
