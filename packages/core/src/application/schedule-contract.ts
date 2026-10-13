import { z } from 'zod';
import type { ManagedResource } from './resource';
import { ApplicationIdSchema } from './schemas';

const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'Expected a safe integer');
const PositiveSafeIntegerSchema = NonNegativeSafeIntegerSchema.refine(
  (value) => value > 0,
  'Expected a positive integer',
);

export const ManagedScheduleOverlapSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('skip') }).readonly(),
  z.object({ mode: z.literal('queue-one') }).readonly(),
  z
    .object({
      mode: z.literal('parallel'),
      maxConcurrent: PositiveSafeIntegerSchema,
    })
    .readonly(),
]);
export type ManagedScheduleOverlap = z.infer<typeof ManagedScheduleOverlapSchema>;

export const ManagedScheduleErrorPolicySchema = z.enum(['continue', 'stop-schedule']);
export type ManagedScheduleErrorPolicy = z.infer<typeof ManagedScheduleErrorPolicySchema>;

const ManagedScheduleTriggerSchema = z.enum(['timer', 'wake']);
/** What started a run: the period elapsing, or the owner's `wake()`. */
export type ManagedScheduleTrigger = z.infer<typeof ManagedScheduleTriggerSchema>;

export const ManagedScheduleDescriptorSchema = z
  .object({
    id: ApplicationIdSchema,
    everyMs: PositiveSafeIntegerSchema,
    startAfterMs: NonNegativeSafeIntegerSchema,
    overlap: ManagedScheduleOverlapSchema,
    errorPolicy: ManagedScheduleErrorPolicySchema,
  })
  .readonly();
export type ManagedScheduleDescriptor = z.infer<typeof ManagedScheduleDescriptorSchema>;

export const ManagedScheduleStatusSchema = z
  .object({
    descriptor: ManagedScheduleDescriptorSchema,
    state: z.enum(['inactive', 'scheduled', 'running', 'draining', 'stopped']),
    revision: NonNegativeSafeIntegerSchema,
    capturedAt: z.string().datetime({ offset: true }),
    changedAt: z.string().datetime({ offset: true }),
    accepting: z.boolean(),
    active: NonNegativeSafeIntegerSchema,
    queued: z.boolean(),
    runsStarted: NonNegativeSafeIntegerSchema,
    runsCompleted: NonNegativeSafeIntegerSchema,
    runsFailed: NonNegativeSafeIntegerSchema,
    runsWoken: NonNegativeSafeIntegerSchema,
    ticksSkipped: NonNegativeSafeIntegerSchema,
    wakesCoalesced: NonNegativeSafeIntegerSchema,
    lastTrigger: ManagedScheduleTriggerSchema.nullable(),
    nextRunAt: z.string().datetime({ offset: true }).nullable(),
    lastScheduledAt: z.string().datetime({ offset: true }).nullable(),
    lastStartedAt: z.string().datetime({ offset: true }).nullable(),
    lastFinishedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .readonly();
export type ManagedScheduleStatus = z.infer<typeof ManagedScheduleStatusSchema>;

export interface ManagedScheduleTimer {
  cancel(): void;
}

/** Monotonic timer boundary. Tests can replace it without changing schedule semantics. */
export interface ManagedScheduleClock {
  /** Monotonic clock used for cadence and deadline arithmetic. */
  now(): number;
  /** Wall clock used only to project portable status timestamps. */
  wallNow(): Date;
  schedule(callback: () => void, delayMs: number): ManagedScheduleTimer;
}

export interface ManagedScheduleRunContext {
  readonly applicationId: string;
  readonly signal: AbortSignal;
  readonly scheduledAt: number;
  readonly startedAt: number;
  readonly trigger: ManagedScheduleTrigger;
  now(): number;
}

export interface ManagedScheduleConfig {
  readonly id: string;
  readonly dependsOn?: readonly string[];
  readonly required?: boolean;
  readonly everyMs: number;
  /** Defaults to one interval. A zero value schedules the first run after activation. */
  readonly startAfterMs?: number;
  readonly overlap?: ManagedScheduleOverlap;
  readonly errorPolicy?: ManagedScheduleErrorPolicy;
  readonly run: (context: ManagedScheduleRunContext) => void | Promise<void>;
  readonly onError?: (
    error: unknown,
    context: ManagedScheduleRunContext,
  ) => void | Promise<void>;
  readonly clock?: ManagedScheduleClock;
}

export interface ManagedSchedule extends ManagedResource {
  readonly status: ManagedScheduleStatus;
  /**
   * Ask for one run now, because the owner knows work has appeared. The run takes the same path
   * as a timer run: `overlap`, `onError`, `errorPolicy` and the counters apply, and the period
   * keeps its own cadence as the check for an event that was lost. Calls made in one tick, or
   * while a run holds every slot, collapse into one following run. Before the schedule is
   * activated and after it stops accepting, the call does nothing and is not remembered.
   */
  wake(): void;
}
