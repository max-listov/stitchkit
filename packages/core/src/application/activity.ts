import { z } from 'zod';
import { type ApplicationSnapshotSink, createApplicationSnapshotSink } from './latest-sink';

const BoundedOperationalIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative();

export const ActivityIdSchema = BoundedOperationalIdSchema;
export type ActivityId = z.infer<typeof ActivityIdSchema>;
export const ActivityStageIdSchema = BoundedOperationalIdSchema;
export type ActivityStageId = z.infer<typeof ActivityStageIdSchema>;

export const ActivityStageSnapshotSchema = z
  .object({
    id: ActivityStageIdSchema,
    active: NonNegativeIntegerSchema,
    queued: NonNegativeIntegerSchema,
    completed: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
  })
  .strict()
  .readonly();
export type ActivityStageSnapshot = z.infer<typeof ActivityStageSnapshotSchema>;

const ActivityTotalsSchema = z
  .object({
    active: NonNegativeIntegerSchema,
    queued: NonNegativeIntegerSchema,
    completed: NonNegativeIntegerSchema,
    failed: NonNegativeIntegerSchema,
  })
  .strict()
  .readonly();

export const ActivitySnapshotSchema = z
  .object({
    id: ActivityIdSchema,
    epoch: z.string().uuid(),
    revision: NonNegativeIntegerSchema,
    capturedAt: z.string().datetime({ offset: true }),
    changedAt: z.string().datetime({ offset: true }),
    stages: z.array(ActivityStageSnapshotSchema).min(1).max(64).readonly(),
    totals: ActivityTotalsSchema,
  })
  .strict()
  .readonly();
export type ActivitySnapshot = z.infer<typeof ActivitySnapshotSchema>;

export const ActivityLiveStateSchema = z.enum(['active', 'queued']);
export type ActivityLiveState = z.infer<typeof ActivityLiveStateSchema>;

const ActivityTokenBrand: unique symbol = Symbol('stitchkit.application.activity');
export interface ActivityToken {
  readonly [ActivityTokenBrand]: true;
}

export interface ActivityTransition<TStage extends string> {
  readonly stage: TStage;
  readonly state: ActivityLiveState;
}

export interface ActivityProjectionSubscriberError {
  readonly error: unknown;
  readonly snapshot: ActivitySnapshot;
}

export interface ActivityProjectionConfig<TStages extends readonly string[]> {
  readonly id: string;
  readonly stages: TStages;
  readonly epoch?: string;
  now?: () => Date;
  onSubscriberError?(failure: ActivityProjectionSubscriberError): void | Promise<void>;
}

export interface ActivityProjection<TStage extends string> {
  open(stage: TStage, state?: ActivityLiveState): ActivityToken;
  transition(token: ActivityToken, transition: ActivityTransition<TStage>): boolean;
  complete(token: ActivityToken): boolean;
  fail(token: ActivityToken): boolean;
  getSnapshot(): ActivitySnapshot;
  /** Replay the current absolute value, then deliver coalesced newer revisions. */
  subscribe(listener: (snapshot: ActivitySnapshot) => void | Promise<void>): () => void;
}

interface MutableStageCounters {
  active: number;
  queued: number;
  completed: number;
  failed: number;
}

interface LiveActivity {
  stage: string;
  state: ActivityLiveState | 'completed' | 'failed';
}

function emptyCounters(): MutableStageCounters {
  return { active: 0, queued: 0, completed: 0, failed: 0 };
}

function totalsOf(stages: readonly ActivityStageSnapshot[]) {
  return stages.reduce(
    (totals, stage) => ({
      active: totals.active + stage.active,
      queued: totals.queued + stage.queued,
      completed: totals.completed + stage.completed,
      failed: totals.failed + stage.failed,
    }),
    emptyCounters(),
  );
}

export function createActivityProjection<const TStages extends readonly string[]>(
  config: ActivityProjectionConfig<TStages>,
): ActivityProjection<TStages[number]> {
  const id = ActivityIdSchema.parse(config.id);
  const declaredStages = z.array(ActivityStageIdSchema).min(1).max(64).parse(config.stages);
  const uniqueStages = new Set(declaredStages);
  if (uniqueStages.size !== declaredStages.length) {
    throw new Error('[stitchkit] createActivityProjection: stage ids must be unique');
  }
  const epoch = z
    .string()
    .uuid()
    .parse(config.epoch ?? crypto.randomUUID());
  const now = config.now ?? (() => new Date());
  const counters = new Map(declaredStages.map((stage) => [stage, emptyCounters()]));
  const activities = new WeakMap<ActivityToken, LiveActivity>();
  const subscribers = new Set<ApplicationSnapshotSink<ActivitySnapshot>>();
  let revision = 0;
  let changedAt = now().toISOString();

  const countersFor = (stage: string): MutableStageCounters => {
    const value = counters.get(stage);
    if (!value) {
      throw new Error(`[stitchkit] createActivityProjection: undeclared stage "${stage}"`);
    }
    return value;
  };

  const getSnapshot = (): ActivitySnapshot => {
    const stages = declaredStages.map((stage) => ({ id: stage, ...countersFor(stage) }));
    return ActivitySnapshotSchema.parse({
      id,
      epoch,
      revision,
      capturedAt: now().toISOString(),
      changedAt,
      stages,
      totals: totalsOf(stages),
    });
  };

  const publishChange = (): void => {
    revision += 1;
    changedAt = now().toISOString();
    const snapshot = getSnapshot();
    for (const subscriber of subscribers) subscriber.publish(snapshot);
  };

  const requireActivity = (token: ActivityToken): LiveActivity => {
    const activity = activities.get(token);
    if (!activity) {
      throw new Error('[stitchkit] activity token belongs to another projection');
    }
    return activity;
  };

  const leaveLiveState = (activity: LiveActivity): void => {
    if (activity.state === 'active' || activity.state === 'queued') {
      countersFor(activity.stage)[activity.state] -= 1;
    }
  };

  const settle = (token: ActivityToken, terminal: 'completed' | 'failed'): boolean => {
    const activity = requireActivity(token);
    if (activity.state === 'completed' || activity.state === 'failed') return false;
    leaveLiveState(activity);
    countersFor(activity.stage)[terminal] += 1;
    activity.state = terminal;
    publishChange();
    return true;
  };

  return {
    open(stage, rawState = 'active') {
      const parsedStage = ActivityStageIdSchema.parse(stage);
      const state = ActivityLiveStateSchema.parse(rawState);
      countersFor(parsedStage)[state] += 1;
      const token: ActivityToken = Object.freeze({
        get [ActivityTokenBrand](): true {
          return true;
        },
      });
      activities.set(token, { stage: parsedStage, state });
      publishChange();
      return token;
    },
    transition(token, input) {
      const activity = requireActivity(token);
      if (activity.state === 'completed' || activity.state === 'failed') {
        throw new Error('[stitchkit] cannot transition a terminal activity');
      }
      const stage = ActivityStageIdSchema.parse(input.stage);
      const state = ActivityLiveStateSchema.parse(input.state);
      countersFor(stage);
      if (activity.stage === stage && activity.state === state) return false;
      leaveLiveState(activity);
      countersFor(stage)[state] += 1;
      activity.stage = stage;
      activity.state = state;
      publishChange();
      return true;
    },
    complete: (token) => settle(token, 'completed'),
    fail: (token) => settle(token, 'failed'),
    getSnapshot,
    subscribe(listener) {
      const sink = createApplicationSnapshotSink<ActivitySnapshot>({
        write: listener,
        ...(config.onSubscriberError && { onSinkError: config.onSubscriberError }),
      });
      subscribers.add(sink);
      sink.publish(getSnapshot());
      return () => {
        subscribers.delete(sink);
        void sink.close();
      };
    },
  };
}
