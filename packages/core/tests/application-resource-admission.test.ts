import { describe, expect, test } from 'bun:test';
import { createApplication } from '../src/application/kernel';
import { ApplicationAdmissionError } from '../src/application/kernel-contract';
import {
  defineManagedResource,
  type ManagedResourceAdmission,
  type ManagedResourceContext,
} from '../src/application/resource';

/*
 * A resource that fetches work asks the application whether to fetch at all.
 * The answer has to arrive exactly once per admission — a lease nobody holds
 * keeps a shutdown waiting on an operation that does not exist.
 */

function probe() {
  let admission: ManagedResourceAdmission | undefined;
  let reportHealth: ManagedResourceContext['reportHealth'] = () => undefined;
  const resource = defineManagedResource({
    id: 'poller',
    start(context) {
      admission = context.admission;
      reportHealth = context.reportHealth;
    },
  });
  const app = createApplication({ id: 'admission', resources: [resource] });
  return {
    app,
    admission: () => {
      if (!admission) throw new Error('the resource has not started');
      return admission;
    },
    health: (value: 'healthy' | 'unhealthy') => reportHealth(value),
  };
}

describe('ManagedResourceContext.admission', () => {
  test('acquire answers null until the application accepts', async () => {
    const { app, admission } = probe();
    await app.start();
    const lease = admission().acquire();
    expect(lease).not.toBeNull();
    expect(app.getSnapshot().admission.pending).toBe(1);
    lease?.release();
    expect(app.getSnapshot().admission.pending).toBe(0);
  });

  test('acquireWhenAccepting waits out a degradation and admits exactly one operation', async () => {
    const { app, admission, health } = probe();
    await app.start();
    health('unhealthy');
    const waiting = admission().acquireWhenAccepting(new AbortController().signal);
    // Several publishes before the application accepts again.
    health('unhealthy');
    await Bun.sleep(5);
    expect(app.getSnapshot().admission.pending).toBe(0);
    health('healthy');
    const lease = await waiting;
    await Bun.sleep(5);
    expect(app.getSnapshot().admission.pending).toBe(1);
    lease.release();
    expect(app.getSnapshot().admission.pending).toBe(0);
    await app.shutdown();
  });

  test('rejects with the signal reason on abort', async () => {
    const { app, admission, health } = probe();
    await app.start();
    health('unhealthy');
    const controller = new AbortController();
    const waiting = admission().acquireWhenAccepting(controller.signal);
    const reason = new Error('stopped polling');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    await app.shutdown();
  });

  test('rejects with ApplicationAdmissionError once the application is shutting down', async () => {
    const { app, admission, health } = probe();
    await app.start();
    health('unhealthy');
    const waiting = admission().acquireWhenAccepting(new AbortController().signal);
    const stopping = app.shutdown();
    await expect(waiting).rejects.toBeInstanceOf(ApplicationAdmissionError);
    await stopping;
    await expect(
      admission().acquireWhenAccepting(new AbortController().signal),
    ).rejects.toBeInstanceOf(ApplicationAdmissionError);
  });
});
