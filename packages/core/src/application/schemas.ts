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
  })
  .readonly();
export type ApplicationSnapshot = z.infer<typeof ApplicationSnapshotSchema>;

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
