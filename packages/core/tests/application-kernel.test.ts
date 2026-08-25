import { describe, expect, test } from 'bun:test';
import { AgentRuntimeConflictError } from '../src/agent-runtime';
import { type ActivityToken, ActivityTokenBrand } from '../src/application/activity';
import type { ApplicationResourceFailure } from '../src/application/kernel';
import { ApplicationAdmissionError, createApplication } from '../src/application/kernel';
import type { ManagedResourceContext } from '../src/application/resource';
import { defineManagedResource } from '../src/application/resource';
import { managedServerResource } from '../src/application/server-resource';
import { isStitchErrorCode, STITCH_ERROR_STATUS } from '../src/contract';
import type {
  ManagedServerHandle,
  ShutdownOptions,
  ShutdownResult,
} from '../src/server/shutdown';

const cleanServerResult: ShutdownResult = {
  outcome: 'clean',
  acceptedRequests: 0,
  completedRequests: 0,
  pendingRequests: 0,
  pendingWebSockets: 0,
  pendingRequestsAtForce: 0,
  pendingWebSocketsAtForce: 0,
  abortedRequests: 0,
  forcedWebSockets: 0,
  durationMs: 0,
};

describe('managed application kernel', () => {
  test('validates the whole graph before side effects', () => {
    let starts = 0;
    expect(() =>
      createApplication({
        id: 'duplicate',
        resources: [
          {
            id: 'resource',
            start: () => {
              starts += 1;
            },
          },
          {
            id: 'resource',
            start: () => {
              starts += 1;
            },
          },
        ],
      }),
    ).toThrow('duplicate resource id');
    expect(starts).toBe(0);

    expect(() =>
      createApplication({
        id: 'missing',
        resources: [{ id: 'resource', dependsOn: ['absent'], start: () => undefined }],
      }),
    ).toThrow('depends on missing resource');
    expect(() =>
      createApplication({
        id: 'cycle',
        resources: [
          { id: 'one', dependsOn: ['two'], start: () => undefined },
          { id: 'two', dependsOn: ['one'], start: () => undefined },
        ],
      }),
    ).toThrow('dependency cycle');
    expect(() =>
      createApplication({
        id: 'required-optional',
        resources: [
          { id: 'optional', required: false, start: () => undefined },
          { id: 'required', dependsOn: ['optional'], start: () => undefined },
        ],
      }),
    ).toThrow('cannot depend on optional');
  });

  test('starts in stable topological order and activates only after all resources are ready', async () => {
    const order: string[] = [];
    const app = createApplication({
      id: 'ordered',
      resources: [
        {
          id: 'consumer',
          dependsOn: ['database'],
          start: () => void order.push('consumer:start'),
          activate: () => void order.push('consumer:activate'),
          close: () => void order.push('consumer:close'),
        },
        {
          id: 'database',
          start: () => void order.push('database:start'),
          activate: () => void order.push('database:activate'),
          close: () => void order.push('database:close'),
        },
      ],
    });

    const first = app.start();
    expect(app.start()).toBe(first);
    await first;
    expect(order).toEqual([
      'database:start',
      'consumer:start',
      'database:activate',
      'consumer:activate',
    ]);
    expect(app.getSnapshot()).toMatchObject({
      lifecycle: 'ready',
      health: 'healthy',
      ready: true,
    });

    await app.shutdown();
    expect(order.slice(-2)).toEqual(['consumer:close', 'database:close']);
  });

  test('rolls back every attempted resource including the start that rejected', async () => {
    const order: string[] = [];
    const app = createApplication({
      id: 'rollback',
      resources: [
        {
          id: 'first',
          start: () => void order.push('first:start'),
          close: () => void order.push('first:close'),
        },
        {
          id: 'partial',
          start() {
            order.push('partial:start');
            throw new Error('partial allocation failed');
          },
          close: () => void order.push('partial:close'),
        },
      ],
    });

    await expect(app.start()).rejects.toThrow('partial allocation failed');
    expect(order).toEqual(['first:start', 'partial:start', 'partial:close', 'first:close']);
    expect(app.getSnapshot().lifecycle).toBe('failed');
  });

  test('continues startup rollback after a close failure and reports both causes', async () => {
    const order: string[] = [];
    const phases: string[] = [];
    const app = createApplication({
      id: 'rollback-errors',
      resources: [
        {
          id: 'first',
          start: () => void order.push('first:start'),
          stopAdmission: () => void phases.push('first:admission'),
          drain: () => void phases.push('first:drain'),
          close: () => void order.push('first:close'),
        },
        {
          id: 'partial',
          start() {
            order.push('partial:start');
            throw new Error('start failed');
          },
          close() {
            order.push('partial:close');
            throw new Error('close failed');
          },
        },
      ],
    });

    await expect(app.start()).rejects.toBeInstanceOf(AggregateError);
    expect(order).toEqual(['first:start', 'partial:start', 'partial:close', 'first:close']);
    expect(app.getSnapshot().lifecycle).toBe('failed');
    const shutdown = await app.shutdown();
    expect(order).toEqual(['first:start', 'partial:start', 'partial:close', 'first:close']);
    expect(phases).toEqual([]);
    expect(shutdown).toMatchObject({
      outcome: 'forced',
      cleanupComplete: false,
      resources: [
        { id: 'first', state: 'closed' },
        { id: 'partial', state: 'force-failed', failures: ['start', 'close', 'force'] },
      ],
    });
  });

  test('fails readiness when a long-lived completion settles before ready', async () => {
    let finishCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      finishCompletion = resolve;
    });
    const ready = new Promise<void>(() => undefined);
    let closes = 0;
    const app = createApplication({
      id: 'completion-before-ready',
      resources: [
        {
          id: 'worker',
          start: () => ({ ready, completion }),
          close: () => {
            closes += 1;
          },
        },
      ],
    });

    const starting = app.start();
    await Promise.resolve();
    finishCompletion();
    await expect(starting).rejects.toThrow('completed before reaching readiness');
    expect(closes).toBe(1);
    expect(app.getSnapshot()).toMatchObject({ lifecycle: 'failed', ready: false });
  });

  test('optional failure degrades without claiming healthy', async () => {
    const app = createApplication({
      id: 'degraded',
      resources: [
        { id: 'required', start: () => undefined },
        {
          id: 'optional',
          required: false,
          start() {
            throw new Error('optional unavailable');
          },
        },
      ],
    });
    await app.start();
    expect(app.getSnapshot()).toMatchObject({
      lifecycle: 'ready',
      health: 'degraded',
      ready: true,
    });
    await app.shutdown();
  });

  test('observes a long-lived completion failure and removes required readiness', async () => {
    let rejectCompletion: (error: unknown) => void = () => undefined;
    const completion = new Promise<void>((_resolve, reject) => {
      rejectCompletion = reject;
    });
    const app = createApplication({
      id: 'late-failure',
      resources: [{ id: 'poller', start: () => ({ completion }) }],
    });
    await app.start();
    rejectCompletion(new Error('polling stopped'));
    await Promise.resolve();
    await Promise.resolve();
    expect(app.getSnapshot()).toMatchObject({
      lifecycle: 'ready',
      health: 'unhealthy',
      ready: false,
    });
    await app.shutdown();
  });

  test('keeps optional late completion degraded while required admission stays open', async () => {
    let finishCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      finishCompletion = resolve;
    });
    const app = createApplication({
      id: 'optional-late-completion',
      resources: [
        { id: 'required', start: () => undefined },
        { id: 'optional', required: false, start: () => ({ completion }) },
      ],
    });
    await app.start();
    finishCompletion();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.getSnapshot()).toMatchObject({
      lifecycle: 'ready',
      health: 'degraded',
      ready: true,
      admission: { accepting: true },
    });
    const lease = app.admission.acquire();
    expect(lease).not.toBeNull();
    lease?.release();
    await app.shutdown();
  });

  test('keeps health, readiness and canonical admission truth synchronized after startup', async () => {
    let context: ManagedResourceContext | undefined;
    const app = createApplication({
      id: 'runtime-health',
      resources: [
        {
          id: 'worker',
          start: (value) => {
            context = value;
          },
        },
      ],
    });
    await app.start();

    context?.reportHealth('unhealthy');
    expect(app.getSnapshot()).toMatchObject({
      health: 'unhealthy',
      ready: false,
      admission: { accepting: false },
    });
    expect(app.admission.acquire()).toBeNull();

    context?.reportHealth('healthy');
    expect(app.getSnapshot()).toMatchObject({
      health: 'healthy',
      ready: true,
      admission: { accepting: true },
    });
    const lease = app.admission.acquire();
    expect(lease).not.toBeNull();
    lease?.release();
    await app.shutdown();
  });

  test('never opens admission from a health report while activation is incomplete', async () => {
    let readAccepting = (): boolean => false;
    const observed: boolean[] = [];
    const app = createApplication({
      id: 'activation-gate',
      resources: [
        {
          id: 'first',
          start: () => undefined,
          activate(context) {
            context.reportHealth('healthy');
            observed.push(readAccepting());
          },
        },
        {
          id: 'second',
          start: () => undefined,
          activate: () => void observed.push(readAccepting()),
        },
      ],
    });
    readAccepting = () => app.getSnapshot().admission.accepting;

    await app.start();
    expect(observed).toEqual([false, false]);
    expect(app.getSnapshot().admission.accepting).toBeTrue();
    await app.shutdown();
  });

  test('rejects startup when a required resource loses health during activation', async () => {
    let closes = 0;
    const app = createApplication({
      id: 'activation-health-loss',
      resources: [
        {
          id: 'worker',
          start: () => undefined,
          activate(context) {
            context.reportHealth('unhealthy');
          },
          close: () => {
            closes += 1;
          },
        },
      ],
    });

    await expect(app.start()).rejects.toThrow('lost readiness during activation');
    expect(closes).toBe(1);
    expect(app.getSnapshot()).toMatchObject({ lifecycle: 'failed', ready: false });
  });

  test('shutdown during activation prevents later activation and closes attempted resources once', async () => {
    let releaseActivation: () => void = () => undefined;
    const activationBarrier = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });
    let activationStarted: () => void = () => undefined;
    const enteredActivation = new Promise<void>((resolve) => {
      activationStarted = resolve;
    });
    const order: string[] = [];
    const app = createApplication({
      id: 'activation-shutdown',
      resources: [
        {
          id: 'first',
          start: () => undefined,
          async activate() {
            activationStarted();
            await activationBarrier;
          },
          close: () => void order.push('first:close'),
        },
        {
          id: 'second',
          start: () => undefined,
          activate: () => void order.push('second:activate'),
          close: () => void order.push('second:close'),
        },
      ],
    });
    const starting = app.start();
    await enteredActivation;
    const shuttingDown = app.shutdown({ gracePeriodMs: 100, forceTimeoutMs: 20 });
    releaseActivation();

    await expect(starting).rejects.toThrow('interrupted by shutdown');
    await expect(shuttingDown).resolves.toMatchObject({ outcome: 'clean' });
    expect(order).toEqual(['second:close', 'first:close']);
  });

  test('does not activate an optional resource after its optional dependency failed activation', async () => {
    let dependentActivations = 0;
    const app = createApplication({
      id: 'activation-dependency',
      resources: [
        {
          id: 'optional-dependency',
          required: false,
          start: () => undefined,
          activate() {
            throw new Error('activation failed');
          },
        },
        {
          id: 'optional-dependent',
          required: false,
          dependsOn: ['optional-dependency'],
          start: () => undefined,
          activate: () => {
            dependentActivations += 1;
          },
        },
      ],
    });

    await app.start();
    expect(dependentActivations).toBe(0);
    expect(app.getSnapshot()).toMatchObject({
      lifecycle: 'ready',
      health: 'degraded',
      resources: [
        { id: 'optional-dependency', state: 'failed' },
        { id: 'optional-dependent', state: 'failed' },
      ],
    });
    await app.shutdown();
  });

  test('isolates synchronous and asynchronous snapshot observers from lifecycle work', async () => {
    let calls = 0;
    const app = createApplication({
      id: 'observer-isolation',
      onSnapshot() {
        calls += 1;
        if (calls % 2 === 0) return Promise.reject(new Error('async observer failed'));
        throw new Error('sync observer failed');
      },
    });

    await expect(app.start()).resolves.toMatchObject({ lifecycle: 'ready' });
    const lease = app.admission.acquire();
    lease?.release();
    await expect(app.shutdown()).resolves.toMatchObject({ outcome: 'clean' });
    expect(calls).toBeGreaterThan(0);
  });

  test('closes admission atomically and drains an idempotent lease', async () => {
    const app = createApplication({ id: 'admission' });
    await app.start();
    const lease = app.admission.acquire();
    expect(lease).not.toBeNull();
    const shuttingDown = app.shutdown();
    expect(app.admission.acquire()).toBeNull();
    await expect(app.admission.run(async () => undefined)).rejects.toBeInstanceOf(
      ApplicationAdmissionError,
    );
    let settled = false;
    void shuttingDown.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    lease?.release();
    lease?.release();
    const result = await shuttingDown;
    expect(result).toMatchObject({
      outcome: 'clean',
      acceptedOperations: 1,
      completedOperations: 1,
      pendingOperations: 0,
    });
  });

  test('shutdown during startup aborts later starts and closes attempted resources once', async () => {
    let finishStart: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const order: string[] = [];
    const app = createApplication({
      id: 'startup-race',
      resources: [
        {
          id: 'slow',
          start: () => barrier,
          close: () => void order.push('slow:close'),
        },
        {
          id: 'never',
          start: () => void order.push('never:start'),
        },
      ],
    });
    const starting = app.start();
    await Promise.resolve();
    const shuttingDown = app.shutdown({ gracePeriodMs: 100 });
    finishStart();
    await expect(starting).rejects.toThrow('interrupted by shutdown');
    await shuttingDown;
    expect(order).toEqual(['slow:close']);
  });

  test('shutdown deadline bounds a start callback that ignores abort', async () => {
    let finishStart: () => void = () => undefined;
    const neverUntilReleased = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    let closes = 0;
    const app = createApplication({
      id: 'bounded-start',
      resources: [
        {
          id: 'stuck',
          start: () => neverUntilReleased,
          close: () => {
            closes += 1;
          },
        },
      ],
    });
    const starting = app.start();
    await Promise.resolve();
    const result = await app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 20 });
    expect(result).toMatchObject({ outcome: 'forced', reason: 'deadline' });
    expect(closes).toBe(1);
    expect(app.getSnapshot().lifecycle).toBe('stopped');
    finishStart();
    await expect(starting).rejects.toThrow('interrupted by shutdown');
    expect(app.getSnapshot().lifecycle).toBe('stopped');
  });

  test('forces resources concurrently against one pair of absolute deadlines', async () => {
    let releaseForces: () => void = () => undefined;
    const forceBarrier = new Promise<void>((resolve) => {
      releaseForces = resolve;
    });
    let observedBothForces: () => void = () => undefined;
    const bothForces = new Promise<void>((resolve) => {
      observedBothForces = resolve;
    });
    const contexts: Array<{ deadlineAt?: number; forceDeadlineAt?: number }> = [];
    const resource = (id: string) => ({
      id,
      start: () => undefined,
      drain: () => new Promise<void>(() => undefined),
      async force(context: { deadlineAt?: number; forceDeadlineAt?: number }) {
        contexts.push(context);
        if (contexts.length === 2) observedBothForces();
        await forceBarrier;
      },
    });
    const app = createApplication({
      id: 'shared-deadlines',
      resources: [resource('one'), resource('two')],
    });
    await app.start();

    const shuttingDown = app.shutdown({ gracePeriodMs: 5, forceTimeoutMs: 100 });
    await bothForces;
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.deadlineAt).toBe(contexts[1]?.deadlineAt);
    expect(contexts[0]?.forceDeadlineAt).toBe(contexts[1]?.forceDeadlineAt);
    // Deadlines are derived from `performance.now()`, so they are fractional and
    // the difference is exact only to floating-point precision: asserting
    // `toBe(100)` failed on roughly four runs in ten with 99.99999999999997.
    // The property under test is additivity, and this still pins it — an
    // absolute force deadline would be off by the whole grace period.
    expect((contexts[0]?.forceDeadlineAt ?? 0) - (contexts[0]?.deadlineAt ?? 0)).toBeCloseTo(
      100,
      6,
    );
    releaseForces();
    await expect(shuttingDown).resolves.toMatchObject({
      outcome: 'forced',
      reason: 'deadline',
      cleanupComplete: true,
    });
  });

  test('continues forced cleanup of other resources after a close failure', async () => {
    const order: string[] = [];
    const app = createApplication({
      id: 'close-failure',
      resources: [
        {
          id: 'first',
          start: () => undefined,
          close: () => void order.push('first:close'),
        },
        {
          id: 'second',
          start: () => undefined,
          close() {
            order.push('second:close');
            throw new Error('close failed');
          },
        },
      ],
    });
    await app.start();

    const result = await app.shutdown({ forceTimeoutMs: 100 });
    expect(order).toEqual(['second:close', 'first:close']);
    expect(result).toMatchObject({
      outcome: 'forced',
      cleanupComplete: false,
      resources: [
        { id: 'first', state: 'closed' },
        { id: 'second', state: 'force-failed', failures: ['close', 'force'] },
      ],
    });
  });

  test('fans out stop-admission even when one resource rejects the phase', async () => {
    const stopped: string[] = [];
    const app = createApplication({
      id: 'admission-fanout',
      resources: [
        {
          id: 'first',
          start: () => undefined,
          stopAdmission: () => void stopped.push('first'),
        },
        {
          id: 'second',
          start: () => undefined,
          stopAdmission() {
            stopped.push('second');
            throw new Error('admission failed');
          },
        },
      ],
    });
    await app.start();

    await expect(app.shutdown()).resolves.toMatchObject({ outcome: 'forced' });
    expect(stopped).toEqual(['second', 'first']);
  });

  test('managed server rollback starts and awaits its real shutdown exactly once', async () => {
    const calls: ShutdownOptions[] = [];
    const server: ManagedServerHandle<unknown> = {
      url: 'http://local.invalid',
      port: 0,
      runtime: undefined,
      status: {
        state: 'running',
        acceptedRequests: 0,
        completedRequests: 0,
        pendingRequests: 0,
        pendingWebSockets: 0,
      },
      shutdown(options) {
        calls.push(options ?? {});
        return Promise.resolve(cleanServerResult);
      },
    };
    const app = createApplication({
      id: 'server-rollback',
      resources: [
        managedServerResource({ id: 'http', server }),
        {
          id: 'failure',
          dependsOn: ['http'],
          start() {
            throw new Error('startup failed');
          },
        },
      ],
    });

    await expect(app.start()).rejects.toThrow('startup failed');
    expect(calls).toHaveLength(1);
    expect(app.getSnapshot().resources[0]).toMatchObject({ id: 'http', state: 'stopped' });
    await app.shutdown();
    expect(calls).toHaveLength(1);
  });

  test('managed server starts at force immediately when graceful admission never ran', async () => {
    const calls: ShutdownOptions[] = [];
    const server: ManagedServerHandle<unknown> = {
      url: 'http://local.invalid',
      port: 0,
      runtime: undefined,
      status: {
        state: 'running',
        acceptedRequests: 0,
        completedRequests: 0,
        pendingRequests: 0,
        pendingWebSockets: 0,
      },
      shutdown(options) {
        calls.push(options ?? {});
        return Promise.resolve(cleanServerResult);
      },
    };
    let finishStart: () => void = () => undefined;
    const stuckStart = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const app = createApplication({
      id: 'server-force-before-admission',
      resources: [
        managedServerResource({ id: 'http', server }),
        { id: 'stuck', dependsOn: ['http'], start: () => stuckStart },
      ],
    });
    const starting = app.start();
    await Promise.resolve();
    await Promise.resolve();

    const result = await app.shutdown({ gracePeriodMs: 1, forceTimeoutMs: 100 });
    expect(result).toMatchObject({ outcome: 'forced', cleanupComplete: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gracePeriodMs).toBe(0);
    expect(calls[0]?.forceTimeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.forceTimeoutMs).toBeLessThanOrEqual(100);
    finishStart();
    await expect(starting).rejects.toThrow('interrupted by shutdown');
  });

  test('managed server shutdown starts once with the original application force signal', async () => {
    const calls: ShutdownOptions[] = [];
    let release: (result: ShutdownResult) => void = () => undefined;
    const server: ManagedServerHandle<unknown> = {
      url: 'http://local.invalid',
      port: 0,
      runtime: undefined,
      status: {
        state: 'running',
        acceptedRequests: 0,
        completedRequests: 0,
        pendingRequests: 0,
        pendingWebSockets: 0,
      },
      shutdown(options) {
        calls.push(options ?? {});
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    };
    const app = createApplication({
      id: 'server-adapter',
      resources: [managedServerResource({ id: 'http', server })],
    });
    await app.start();
    const controller = new AbortController();
    const shuttingDown = app.shutdown({
      gracePeriodMs: 1_000,
      forceTimeoutMs: 100,
      signal: controller.signal,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);
    controller.abort();
    expect(calls[0]?.signal?.aborted).toBe(true);
    release(cleanServerResult);
    await shuttingDown;
    expect(calls).toHaveLength(1);
  });
});

/**
 * Every phase, named — not a count of events.
 *
 * The previous version of this test built one application with three faulty
 * resources and asserted `seen.length > 0`. It passed while most phases
 * reported nothing, because a shutdown SHORT-CIRCUITS: the first failure sets
 * `gracefulFailed` and the drain and close loops never run. So the check has to
 * be one application per phase, each asserting the exact resource, the exact
 * phase and the exact cause.
 */
describe('every failing phase reports the cause the phase label cannot carry', () => {
  interface PhaseCase {
    phase: ApplicationResourceFailure['phase'];
    message: string;
    build: (
      observe: (failure: ApplicationResourceFailure) => void,
    ) => ReturnType<typeof createApplication>;
    run: (app: ReturnType<typeof createApplication>) => Promise<void>;
  }

  const swallow = async (work: Promise<unknown>): Promise<void> => {
    await work.catch(() => undefined);
  };

  const CASES: PhaseCase[] = [
    {
      phase: 'start',
      message: 'start exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-start',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => {
                throw new Error('start exploded');
              },
            }),
          ],
        }),
      run: (app) => swallow(app.start()),
    },
    {
      phase: 'ready',
      message: 'ready exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-ready',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => ({ ready: Promise.reject(new Error('ready exploded')) }),
            }),
          ],
        }),
      run: (app) => swallow(app.start()),
    },
    {
      phase: 'completion',
      // The kernel wraps the rejection so the phase is carried by the TYPE, not
      // by the resource's own message; `cause` keeps what the resource threw.
      message: '[stitchkit] resource "faulty" completed before reaching readiness',
      build: (observe) =>
        createApplication({
          id: 'phase-completion',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => ({
                ready: new Promise<void>(() => undefined),
                completion: Promise.reject(new Error('the worker exited')),
              }),
            }),
          ],
        }),
      run: (app) => swallow(app.start()),
    },
    {
      phase: 'close',
      message: 'rollback close exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-rollback-close',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => undefined,
              close: () => {
                throw new Error('rollback close exploded');
              },
            }),
            defineManagedResource({
              id: 'later',
              start: () => {
                throw new Error('later start exploded');
              },
            }),
          ],
        }),
      // The startup fails at `later`, so the kernel rolls `faulty` back — and
      // that rollback close is the path that used to record the phase and drop
      // the cause entirely.
      run: (app) => swallow(app.start()),
    },
    {
      phase: 'admission',
      message: 'admission exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-admission',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => undefined,
              stopAdmission: () => {
                throw new Error('admission exploded');
              },
            }),
          ],
        }),
      run: async (app) => {
        await app.start();
        await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
      },
    },
    {
      phase: 'drain',
      message: 'drain exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-drain',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => undefined,
              drain: () => {
                throw new Error('drain exploded');
              },
            }),
          ],
        }),
      run: async (app) => {
        await app.start();
        await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
      },
    },
    {
      phase: 'close',
      message: 'close exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-close',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => undefined,
              close: () => {
                throw new Error('close exploded');
              },
            }),
          ],
        }),
      run: async (app) => {
        await app.start();
        await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
      },
    },
    {
      phase: 'force',
      // A resource whose `close` was already invoked and never settled. There
      // is nothing left to call, so it ends `force-failed` — and used to end
      // there with no cause at all, which reads as an unexplained failure
      // rather than the timeout it is.
      message:
        '[stitchkit] resource "faulty" was already closing and did not settle before the force deadline',
      build: (observe) =>
        createApplication({
          id: 'phase-force-stalled-close',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => undefined,
              close: () => new Promise<void>(() => undefined),
            }),
          ],
        }),
      run: async (app) => {
        await app.start();
        await app.shutdown({ gracePeriodMs: 20, forceTimeoutMs: 20 });
      },
    },
    {
      phase: 'force',
      message: 'force exploded',
      build: (observe) =>
        createApplication({
          id: 'phase-force',
          onResourceFailure: observe,
          resources: [
            defineManagedResource({
              id: 'faulty',
              start: () => undefined,
              drain: () => {
                throw new Error('drain exploded');
              },
              force: () => {
                throw new Error('force exploded');
              },
            }),
          ],
        }),
      run: async (app) => {
        await app.start();
        await app.shutdown({ gracePeriodMs: 20, forceTimeoutMs: 50 });
      },
    },
  ];

  for (const testCase of CASES) {
    test(`${testCase.phase}: ${testCase.message}`, async () => {
      const seen: ApplicationResourceFailure[] = [];
      const app = testCase.build((failure) => void seen.push(failure));
      await testCase.run(app);

      const matched = seen.filter(
        (failure) =>
          failure.phase === testCase.phase &&
          failure.error instanceof Error &&
          failure.error.message === testCase.message,
      );
      expect({ phase: testCase.phase, reported: matched.length }).toEqual({
        phase: testCase.phase,
        reported: 1,
      });
      expect(matched[0]?.resourceId).toBe('faulty');
    });
  }

  test('a long-lived resource that fails AFTER start() reports its cause', async () => {
    // The phase this table originally missed, and the reason it missed it: the
    // failure arrives through a promise rejection handler rather than a `catch`,
    // so an audit that walked `catch` blocks against `reportFailure` could not
    // see it. A poller that dies an hour after startup is the ordinary case.
    const seen: ApplicationResourceFailure[] = [];
    const completion = Promise.withResolvers<void>();
    const app = createApplication({
      id: 'phase-late-completion',
      onResourceFailure: (failure) => void seen.push(failure),
      resources: [
        defineManagedResource({
          id: 'faulty',
          start: () => ({ ready: Promise.resolve(), completion: completion.promise }),
        }),
      ],
    });

    await app.start();
    expect(app.getSnapshot().lifecycle).toBe('ready');
    expect(seen).toEqual([]);

    completion.reject(new Error('the poller died'));
    await Bun.sleep(10);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.resourceId).toBe('faulty');
    expect(seen[0]?.phase).toBe('completion');
    expect(seen[0]?.error instanceof Error && seen[0].error.message).toBe('the poller died');
    expect(app.getSnapshot().health).toBe('unhealthy');
    await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
  });

  test('a long-lived resource that simply finishes is not reported as a failure', async () => {
    const seen: ApplicationResourceFailure[] = [];
    const completion = Promise.withResolvers<void>();
    const app = createApplication({
      id: 'phase-late-completion-clean',
      onResourceFailure: (failure) => void seen.push(failure),
      resources: [
        defineManagedResource({
          id: 'faulty',
          start: () => ({ ready: Promise.resolve(), completion: completion.promise }),
        }),
      ],
    });

    await app.start();
    completion.resolve();
    await Bun.sleep(10);

    expect(seen).toEqual([]);
    await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
  });

  test('a shutdown that overtakes a startup is not reported as a resource failure', async () => {
    // The kernel interrupting itself is not a resource throwing. Reporting it
    // would bury the failure that mattered under one the operator cannot act on.
    const seen: ApplicationResourceFailure[] = [];
    const app = createApplication({
      id: 'phase-interrupted',
      onResourceFailure: (failure) => void seen.push(failure),
      resources: [
        defineManagedResource({
          id: 'slow',
          start: async () => {
            await Bun.sleep(50);
          },
        }),
      ],
    });

    const starting = app.start().catch(() => undefined);
    await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
    await starting;

    expect(
      seen.filter((failure) => /interrupted by shutdown/.test(String(failure.error))),
    ).toEqual([]);
  });

  test('an async observer that rejects cannot break the lifecycle it observes', async () => {
    // `(failure) => void` accepted an `async` observer, and its rejected promise
    // was invisible to the synchronous try/catch around the call — an unhandled
    // rejection during a shutdown, from the one callback that exists to make
    // failures visible.
    const app = createApplication({
      id: 'async-observer',
      onResourceFailure: async () => {
        await Bun.sleep(0);
        throw new Error('observer exploded');
      },
      resources: [
        defineManagedResource({
          id: 'faulty',
          start: () => undefined,
          close: () => {
            throw new Error('close exploded');
          },
        }),
      ],
    });

    await app.start();
    const result = await app.shutdown({ gracePeriodMs: 50, forceTimeoutMs: 50 });
    expect(result.outcome).toBe('forced');
    await Bun.sleep(10);
  });
});

test('an optional resource failing to start does not lose its cause', async () => {
  const seen: ApplicationResourceFailure[] = [];
  const app = createApplication({
    id: 'optional-cause',
    onResourceFailure: (failure) => void seen.push(failure),
    resources: [
      defineManagedResource({
        id: 'optional',
        required: false,
        start: () => {
          throw new Error('optional start exploded');
        },
      }),
    ],
  });

  // A required resource rethrows, so its cause always survives. An optional one
  // is swallowed by design — the application keeps running — which is exactly
  // why the cause has to leave through this channel instead.
  await app.start();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.resourceId).toBe('optional');
  expect(seen[0]?.phase).toBe('start');
  const cause = seen[0]?.error;
  expect(cause instanceof Error && cause.message).toBe('optional start exploded');
  await app.shutdown();
});

test('a throwing failure observer cannot break the shutdown it observes', async () => {
  const app = createApplication({
    id: 'hostile-observer',
    onResourceFailure: () => {
      throw new Error('observer exploded');
    },
    resources: [
      defineManagedResource({
        id: 'faulty',
        required: false,
        start: () => {
          throw new Error('start exploded');
        },
      }),
    ],
  });

  await app.start();
  expect((await app.shutdown()).outcome).toBeString();
});

test('the public surface can be used from outside the module that declares it', async () => {
  // Each of these was reachable only by name: the error class was thrown from
  // public paths and exported nowhere, the brand made a public interface
  // unimplementable, and the shutdown options accepted an HTTP field the kernel
  // never read.
  expect(isStitchErrorCode('APPLICATION_NOT_ACCEPTING')).toBe(true);
  expect(STITCH_ERROR_STATUS.APPLICATION_NOT_ACCEPTING).toBe(503);

  const conflict = new AgentRuntimeConflictError('probe');
  expect(conflict instanceof AgentRuntimeConflictError).toBe(true);

  // A hand-written projection compiles because the brand is reachable.
  const token: ActivityToken = { [ActivityTokenBrand]: true };
  expect(token[ActivityTokenBrand]).toBe(true);

  const app = createApplication({ id: 'surface' });
  await app.start();
  // @ts-expect-error `retryAfterSeconds` belongs to the managed server resource.
  await app.shutdown({ gracePeriodMs: 0, retryAfterSeconds: 30 });
});
