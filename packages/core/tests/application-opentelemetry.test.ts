import { expect, test } from 'bun:test';
import type {
  Attributes,
  ObservableCallback,
  ObservableGauge,
  ObservableResult,
} from '@opentelemetry/api';
import { createActivityProjection } from '../src/application/activity';
import { createApplication } from '../src/application/kernel';
import {
  type ApplicationTelemetryMeter,
  createApplicationOpenTelemetry,
} from '../src/application/opentelemetry';
import { createManagedSchedule } from '../src/application/schedule';

interface Observation {
  readonly value: number;
  readonly attributes?: Attributes;
}

class FakeGauge implements ObservableGauge<Attributes> {
  readonly callbacks = new Set<ObservableCallback<Attributes>>();
  readonly removed: ObservableCallback<Attributes>[] = [];

  constructor(private readonly failOnAdd = false) {}

  addCallback(callback: ObservableCallback<Attributes>): void {
    this.callbacks.add(callback);
    if (this.failOnAdd) throw new Error('callback registration failed');
  }

  removeCallback(callback: ObservableCallback<Attributes>): void {
    this.removed.push(callback);
    this.callbacks.delete(callback);
  }

  async collect(): Promise<readonly Observation[]> {
    const observations: Observation[] = [];
    const result: ObservableResult<Attributes> = {
      observe(value, attributes) {
        observations.push({ value, ...(attributes && { attributes }) });
      },
    };
    for (const callback of this.callbacks) await callback(result);
    return observations;
  }
}

class FakeMeter implements ApplicationTelemetryMeter {
  readonly gauges = new Map<string, FakeGauge[]>();

  constructor(private readonly failOnAddIndex?: number) {}

  createObservableGauge(name: string): FakeGauge {
    const created = [...this.gauges.values()].reduce(
      (count, gauges) => count + gauges.length,
      0,
    );
    const gauge = new FakeGauge(created === this.failOnAddIndex);
    const current = this.gauges.get(name) ?? [];
    current.push(gauge);
    this.gauges.set(name, current);
    return gauge;
  }

  one(name: string): FakeGauge {
    const gauges = this.gauges.get(name);
    if (gauges?.length !== 1) throw new Error(`Expected one gauge named ${name}`);
    const gauge = gauges[0];
    if (!gauge) throw new Error(`Expected one gauge named ${name}`);
    return gauge;
  }
}

test('OpenTelemetry adapter pulls absolute bounded snapshots and removes exact callbacks', async () => {
  const activity = createActivityProjection({ id: 'jobs', stages: ['queued', 'running'] });
  const schedule = createManagedSchedule({
    id: 'poll',
    everyMs: 60_000,
    run: () => undefined,
  });
  const application = createApplication({ id: 'worker', resources: [schedule] });
  await application.start();
  const token = activity.open('queued', 'queued');
  activity.transition(token, { stage: 'running', state: 'active' });
  activity.complete(token);

  const meter = new FakeMeter();
  const binding = createApplicationOpenTelemetry({
    meter,
    application,
    activities: [activity],
    schedules: [schedule],
  });

  const completed = meter.one('stitchkit.application.activity.completed');
  const first = await completed.collect();
  const second = await completed.collect();
  expect(first).toEqual(second);
  expect(first).toContainEqual({
    value: 1,
    attributes: {
      'application.id': 'worker',
      'activity.id': 'jobs',
      'activity.stage': 'running',
    },
  });
  for (const observation of first) {
    expect(Object.keys(observation.attributes ?? {})).not.toContain('revision');
    expect(Object.keys(observation.attributes ?? {})).not.toContain('epoch');
    expect(Object.keys(observation.attributes ?? {})).not.toContain('capturedAt');
  }

  const lifecycle = meter.one('stitchkit.application.lifecycle');
  expect(await lifecycle.collect()).toEqual([
    {
      value: 1,
      attributes: {
        'application.id': 'worker',
        'application.lifecycle': 'ready',
        'application.health': 'healthy',
      },
    },
  ]);

  binding.close();
  binding.close();
  expect(binding.closed).toBe(true);
  for (const gauges of meter.gauges.values()) {
    for (const gauge of gauges) {
      expect(gauge.callbacks.size).toBe(0);
      expect(gauge.removed).toHaveLength(1);
    }
  }
  await application.shutdown();
});

test('OpenTelemetry adapter isolates collection and diagnostic failures', async () => {
  const application = createApplication({ id: 'telemetry-errors' });
  const meter = new FakeMeter();
  let reads = 0;
  const failures: string[] = [];
  const binding = createApplicationOpenTelemetry({
    meter,
    application: {
      getSnapshot() {
        reads += 1;
        if (reads > 1) throw new Error('snapshot unavailable');
        return application.getSnapshot();
      },
    },
    onCollectionError({ instrument }) {
      failures.push(instrument);
      throw new Error('diagnostic unavailable');
    },
  });

  expect(await meter.one('stitchkit.application.ready').collect()).toEqual([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(failures).toEqual(['stitchkit.application.ready']);
  binding.close();
});

test('OpenTelemetry adapter recreation leaves no callback on the closed binding', async () => {
  const application = createApplication({ id: 'telemetry-recreate' });
  const meter = new FakeMeter();
  const first = createApplicationOpenTelemetry({ meter, application });
  const firstGauge = meter.gauges.get('stitchkit.application.ready')?.[0];
  if (!firstGauge) throw new Error('Expected first readiness gauge');
  first.close();

  const second = createApplicationOpenTelemetry({ meter, application });
  const secondGauge = meter.gauges.get('stitchkit.application.ready')?.[1];
  if (!secondGauge) throw new Error('Expected recreated readiness gauge');
  expect(await firstGauge.collect()).toEqual([]);
  expect(await secondGauge.collect()).toEqual([
    { value: 0, attributes: { 'application.id': 'telemetry-recreate' } },
  ]);
  second.close();
});

test('OpenTelemetry adapter rejects duplicate and unbounded declared sources', () => {
  const application = createApplication({ id: 'telemetry-bounds' });
  const duplicate = createActivityProjection({ id: 'same', stages: ['work'] });
  expect(() =>
    createApplicationOpenTelemetry({
      meter: new FakeMeter(),
      application,
      activities: [duplicate, duplicate],
    }),
  ).toThrow('activity ids must be unique');

  const tooMany = Array.from({ length: 65 }, (_, index) =>
    createActivityProjection({ id: `activity-${index}`, stages: ['work'] }),
  );
  expect(() =>
    createApplicationOpenTelemetry({
      meter: new FakeMeter(),
      application,
      activities: tooMany,
    }),
  ).toThrow('at most 64 activity sources');
});

test('OpenTelemetry adapter pins declared source arrays and identities', async () => {
  const application = createApplication({ id: 'telemetry-pinned' });
  const first = createActivityProjection({ id: 'first', stages: ['work'] });
  const second = createActivityProjection({ id: 'second', stages: ['work'] });
  const sources = [first];
  let drift = false;
  const identitySource = {
    getSnapshot() {
      const snapshot = first.getSnapshot();
      return drift ? { ...snapshot, id: 'changed' } : snapshot;
    },
  };
  const failures: string[] = [];
  const meter = new FakeMeter();
  const binding = createApplicationOpenTelemetry({
    meter,
    application,
    activities: sources,
  });
  sources.push(second);
  expect(await meter.one('stitchkit.application.activity.active').collect()).toHaveLength(1);
  binding.close();

  const driftMeter = new FakeMeter();
  const driftBinding = createApplicationOpenTelemetry({
    meter: driftMeter,
    application,
    activities: [identitySource],
    onCollectionError({ error }) {
      failures.push(error instanceof Error ? error.message : 'unknown');
    },
  });
  drift = true;
  expect(await driftMeter.one('stitchkit.application.activity.active').collect()).toEqual([]);
  await Promise.resolve();
  await Promise.resolve();
  expect(failures).toEqual([
    '[stitchkit] application OpenTelemetry activity id changed after binding',
  ]);
  driftBinding.close();
});

test('OpenTelemetry adapter rolls back callbacks after partial registration failure', () => {
  const application = createApplication({ id: 'telemetry-registration-failure' });
  const meter = new FakeMeter(3);
  expect(() => createApplicationOpenTelemetry({ meter, application })).toThrow(
    'callback registration failed',
  );
  const gauges = [...meter.gauges.values()].flat();
  expect(gauges).toHaveLength(4);
  for (const gauge of gauges) {
    expect(gauge.callbacks.size).toBe(0);
    expect(gauge.removed).toHaveLength(1);
  }
});
