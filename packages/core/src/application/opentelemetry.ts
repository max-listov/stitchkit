import type {
  Attributes,
  MetricOptions,
  ObservableCallback,
  ObservableGauge,
  ObservableResult,
} from '@opentelemetry/api';
import type { ActivityProjection } from './activity';
import { type ActivitySnapshot, ActivitySnapshotSchema } from './activity';
import type { ApplicationHandle } from './kernel';
import type { ManagedSchedule } from './schedule';
import { type ManagedScheduleStatus, ManagedScheduleStatusSchema } from './schedule';
import {
  type ApplicationSnapshot,
  ApplicationSnapshotSchema,
  type ManagedResourceSnapshot,
} from './schemas';

const MAX_ACTIVITY_SOURCES = 64;
const MAX_SCHEDULE_SOURCES = 64;
const MAX_RESOURCE_SERIES = 128;

export interface ApplicationTelemetryMeter {
  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge<Attributes>;
}

export interface ApplicationOpenTelemetryCollectionError {
  readonly instrument: string;
  readonly error: unknown;
}

export interface ApplicationOpenTelemetryConfig {
  readonly meter: ApplicationTelemetryMeter;
  readonly application: Pick<ApplicationHandle, 'getSnapshot'>;
  readonly activities?: readonly Pick<ActivityProjection<string>, 'getSnapshot'>[];
  readonly schedules?: readonly Pick<ManagedSchedule, 'status'>[];
  onCollectionError?(failure: ApplicationOpenTelemetryCollectionError): void | Promise<void>;
}

export interface ApplicationOpenTelemetryBinding {
  readonly closed: boolean;
  close(): void;
}

interface GaugeRegistration {
  readonly name: string;
  readonly gauge: ObservableGauge<Attributes>;
  readonly callback: ObservableCallback<Attributes>;
}

interface MetricDefinition<TSnapshot> {
  readonly name: string;
  readonly description: string;
  readonly unit: '1';
  observe(result: ObservableResult<Attributes>, snapshot: TSnapshot): void;
}

const applicationAttributes = (snapshot: ApplicationSnapshot): Attributes => ({
  'application.id': snapshot.id,
});

const resourceAttributes = (
  snapshot: ApplicationSnapshot,
  resource: ManagedResourceSnapshot,
): Attributes => ({
  'application.id': snapshot.id,
  'resource.id': resource.id,
  'resource.required': resource.required,
  'resource.state': resource.state,
  'resource.health': resource.health,
});

const scheduleAttributes = (
  application: ApplicationSnapshot,
  schedule: ManagedScheduleStatus,
): Attributes => ({
  'application.id': application.id,
  'schedule.id': schedule.descriptor.id,
  'schedule.state': schedule.state,
});

const activityAttributes = (
  application: ApplicationSnapshot,
  activity: ActivitySnapshot,
  stage: ActivitySnapshot['stages'][number],
): Attributes => ({
  'application.id': application.id,
  'activity.id': activity.id,
  'activity.stage': stage.id,
});

const applicationMetrics: readonly MetricDefinition<ApplicationSnapshot>[] = [
  {
    name: 'stitchkit.application.lifecycle',
    description: 'Current application lifecycle and health state.',
    unit: '1',
    observe(result, snapshot) {
      result.observe(1, {
        ...applicationAttributes(snapshot),
        'application.lifecycle': snapshot.lifecycle,
        'application.health': snapshot.health,
      });
    },
  },
  {
    name: 'stitchkit.application.ready',
    description: 'Whether the application currently accepts readiness traffic.',
    unit: '1',
    observe: (result, snapshot) =>
      result.observe(snapshot.ready ? 1 : 0, applicationAttributes(snapshot)),
  },
  {
    name: 'stitchkit.application.admission.accepting',
    description: 'Whether application admission is currently open.',
    unit: '1',
    observe: (result, snapshot) =>
      result.observe(snapshot.admission.accepting ? 1 : 0, applicationAttributes(snapshot)),
  },
  {
    name: 'stitchkit.application.admission.accepted',
    description: 'Absolute number of operations accepted in this application lifetime.',
    unit: '1',
    observe: (result, snapshot) =>
      result.observe(snapshot.admission.accepted, applicationAttributes(snapshot)),
  },
  {
    name: 'stitchkit.application.admission.completed',
    description: 'Absolute number of operations completed in this application lifetime.',
    unit: '1',
    observe: (result, snapshot) =>
      result.observe(snapshot.admission.completed, applicationAttributes(snapshot)),
  },
  {
    name: 'stitchkit.application.admission.pending',
    description: 'Current number of admitted operations still pending.',
    unit: '1',
    observe: (result, snapshot) =>
      result.observe(snapshot.admission.pending, applicationAttributes(snapshot)),
  },
  {
    name: 'stitchkit.application.resource.ready',
    description: 'Whether each declared managed resource is currently ready.',
    unit: '1',
    observe(result, snapshot) {
      for (const resource of snapshot.resources) {
        result.observe(resource.ready ? 1 : 0, resourceAttributes(snapshot, resource));
      }
    },
  },
];

const scheduleMetric = (
  name: string,
  description: string,
  value: (snapshot: ManagedScheduleStatus) => number,
): MetricDefinition<{
  application: ApplicationSnapshot;
  schedules: readonly ManagedScheduleStatus[];
}> => ({
  name,
  description,
  unit: '1',
  observe(result, snapshot) {
    for (const schedule of snapshot.schedules) {
      result.observe(value(schedule), scheduleAttributes(snapshot.application, schedule));
    }
  },
});

const scheduleMetrics = [
  scheduleMetric(
    'stitchkit.application.schedule.accepting',
    'Whether a schedule accepts new ticks.',
    (value) => (value.accepting ? 1 : 0),
  ),
  scheduleMetric(
    'stitchkit.application.schedule.active',
    'Current active runs for a schedule.',
    (value) => value.active,
  ),
  scheduleMetric(
    'stitchkit.application.schedule.queued',
    'Whether a schedule has one queued run.',
    (value) => (value.queued ? 1 : 0),
  ),
  scheduleMetric(
    'stitchkit.application.schedule.runs_started',
    'Absolute schedule runs started.',
    (value) => value.runsStarted,
  ),
  scheduleMetric(
    'stitchkit.application.schedule.runs_completed',
    'Absolute schedule runs completed.',
    (value) => value.runsCompleted,
  ),
  scheduleMetric(
    'stitchkit.application.schedule.runs_failed',
    'Absolute schedule runs failed.',
    (value) => value.runsFailed,
  ),
  scheduleMetric(
    'stitchkit.application.schedule.ticks_skipped',
    'Absolute schedule ticks skipped.',
    (value) => value.ticksSkipped,
  ),
];

const activityMetric = (
  name: string,
  description: string,
  value: (stage: ActivitySnapshot['stages'][number]) => number,
): MetricDefinition<{
  application: ApplicationSnapshot;
  activities: readonly ActivitySnapshot[];
}> => ({
  name,
  description,
  unit: '1',
  observe(result, snapshot) {
    for (const activity of snapshot.activities) {
      for (const stage of activity.stages) {
        result.observe(
          value(stage),
          activityAttributes(snapshot.application, activity, stage),
        );
      }
    }
  },
});

const activityMetrics = [
  activityMetric(
    'stitchkit.application.activity.active',
    'Current active activities by stage.',
    (value) => value.active,
  ),
  activityMetric(
    'stitchkit.application.activity.queued',
    'Current queued activities by stage.',
    (value) => value.queued,
  ),
  activityMetric(
    'stitchkit.application.activity.completed',
    'Absolute completed activities by stage.',
    (value) => value.completed,
  ),
  activityMetric(
    'stitchkit.application.activity.failed',
    'Absolute failed activities by stage.',
    (value) => value.failed,
  ),
];

function requireUniqueIds(ids: readonly string[], label: string): void {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`[stitchkit] application OpenTelemetry ${label} ids must be unique`);
  }
}

function requireStableIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    throw new Error(
      `[stitchkit] application OpenTelemetry ${label} ids changed after binding`,
    );
  }
}

/** Register pull-only observable gauges over canonical application snapshots. */
export function createApplicationOpenTelemetry(
  config: ApplicationOpenTelemetryConfig,
): ApplicationOpenTelemetryBinding {
  const activities = [...(config.activities ?? [])];
  const schedules = [...(config.schedules ?? [])];
  if (activities.length > MAX_ACTIVITY_SOURCES) {
    throw new Error(
      `[stitchkit] application OpenTelemetry supports at most ${MAX_ACTIVITY_SOURCES} activity sources`,
    );
  }
  if (schedules.length > MAX_SCHEDULE_SOURCES) {
    throw new Error(
      `[stitchkit] application OpenTelemetry supports at most ${MAX_SCHEDULE_SOURCES} schedule sources`,
    );
  }

  const initialApplication = ApplicationSnapshotSchema.parse(config.application.getSnapshot());
  if (initialApplication.resources.length > MAX_RESOURCE_SERIES) {
    throw new Error(
      `[stitchkit] application OpenTelemetry supports at most ${MAX_RESOURCE_SERIES} resource series`,
    );
  }
  const applicationId = initialApplication.id;
  const resourceIds = initialApplication.resources.map((resource) => resource.id);
  const initialActivities = activities.map((source) =>
    ActivitySnapshotSchema.parse(source.getSnapshot()),
  );
  const activityIds = initialActivities.map((snapshot) => snapshot.id);
  const activityStageIds = initialActivities.map((snapshot) =>
    snapshot.stages.map((stage) => stage.id),
  );
  const initialSchedules = schedules.map((source) =>
    ManagedScheduleStatusSchema.parse(source.status),
  );
  const scheduleIds = initialSchedules.map((snapshot) => snapshot.descriptor.id);
  requireUniqueIds(activityIds, 'activity');
  requireUniqueIds(scheduleIds, 'schedule');

  const registrations: GaugeRegistration[] = [];
  let closed = false;

  const reportCollectionError = (instrument: string, error: unknown): void => {
    if (!config.onCollectionError) return;
    void Promise.resolve()
      .then(() => config.onCollectionError?.({ instrument, error }))
      .catch(() => {
        // Telemetry diagnostics cannot fail metric collection.
      });
  };

  const removeRegistrations = (reportErrors: boolean): void => {
    for (const registration of registrations) {
      try {
        registration.gauge.removeCallback(registration.callback);
      } catch (error) {
        if (reportErrors) reportCollectionError(registration.name, error);
      }
    }
  };

  const pullApplication = (): ApplicationSnapshot => {
    const snapshot = ApplicationSnapshotSchema.parse(config.application.getSnapshot());
    if (snapshot.id !== applicationId) {
      throw new Error(
        '[stitchkit] application OpenTelemetry application id changed after binding',
      );
    }
    requireStableIds(
      snapshot.resources.map((resource) => resource.id),
      resourceIds,
      'resource',
    );
    return snapshot;
  };

  const pullSchedules = (): readonly ManagedScheduleStatus[] =>
    schedules.map((source, index) => {
      const snapshot = ManagedScheduleStatusSchema.parse(source.status);
      if (snapshot.descriptor.id !== scheduleIds[index]) {
        throw new Error(
          '[stitchkit] application OpenTelemetry schedule id changed after binding',
        );
      }
      return snapshot;
    });

  const pullActivities = (): readonly ActivitySnapshot[] =>
    activities.map((source, index) => {
      const snapshot = ActivitySnapshotSchema.parse(source.getSnapshot());
      if (snapshot.id !== activityIds[index]) {
        throw new Error(
          '[stitchkit] application OpenTelemetry activity id changed after binding',
        );
      }
      requireStableIds(
        snapshot.stages.map((stage) => stage.id),
        activityStageIds[index] ?? [],
        'activity stage',
      );
      return snapshot;
    });

  const register = <TSnapshot>(
    definition: MetricDefinition<TSnapshot>,
    pull: () => TSnapshot,
  ): void => {
    const gauge = config.meter.createObservableGauge(definition.name, {
      description: definition.description,
      unit: definition.unit,
    });
    const callback: ObservableCallback<Attributes> = (result) => {
      if (closed) return;
      try {
        definition.observe(result, pull());
      } catch (error) {
        reportCollectionError(definition.name, error);
      }
    };
    registrations.push({ name: definition.name, gauge, callback });
    gauge.addCallback(callback);
  };

  try {
    for (const definition of applicationMetrics) {
      register(definition, pullApplication);
    }
    for (const definition of scheduleMetrics) {
      register(definition, () => ({
        application: pullApplication(),
        schedules: pullSchedules(),
      }));
    }
    for (const definition of activityMetrics) {
      register(definition, () => ({
        application: pullApplication(),
        activities: pullActivities(),
      }));
    }
  } catch (error) {
    closed = true;
    removeRegistrations(false);
    throw error;
  }

  return {
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      removeRegistrations(true);
    },
  };
}
