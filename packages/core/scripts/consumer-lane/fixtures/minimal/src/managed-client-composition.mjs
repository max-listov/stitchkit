import assert from 'node:assert/strict';
import {
  ApplicationAdmissionError,
  createApplication,
  defineManagedResource,
} from 'stitchkit/application';

function clientResource(create) {
  let generation;
  return defineManagedResource({
    id: 'client',
    async start({ signal }) {
      const client = create();
      let destruction;
      const destroy = () => (destruction ??= Promise.resolve().then(() => client.destroy()));
      generation = { client, destroy };
      let ready = false;
      let startFailure;
      let startFailed = false;
      let cleanupFailed = false;
      let cleanupFailure;
      try {
        await client.connect(signal);
        await client.assertReady();
        signal.throwIfAborted();
        ready = true;
      } catch (error) {
        startFailure = error;
        startFailed = true;
      } finally {
        if (!ready) {
          try {
            await destroy();
          } catch (cleanup) {
            cleanupFailed = true;
            cleanupFailure = cleanup;
          }
        }
      }
      if (startFailed) {
        if (cleanupFailed)
          throw new AggregateError(
            [startFailure, cleanupFailure],
            'Client startup and cleanup failed',
            { cause: startFailure },
          );
        throw startFailure;
      }
      return { value: client };
    },
    close: () => generation?.destroy(),
    force: () => generation?.destroy(),
  });
}

function composition({ failReady = false, stuckDrain = false } = {}) {
  const clients = [];
  const order = [];
  const client = clientResource(() => {
    const record = { id: clients.length + 1, destroyed: 0 };
    clients.push(record);
    return {
      async connect(signal) {
        signal.throwIfAborted();
      },
      async assertReady() {
        if (failReady) throw new Error('partial startup');
      },
      async invoke() {
        assert.equal(record.destroyed, 0);
        return record.id;
      },
      async destroy() {
        record.destroyed++;
        order.push('client');
      },
    };
  });
  let request;
  const http = defineManagedResource({
    id: 'http',
    dependsOn: [client],
    start(context) {
      const connection = context.use(client);
      request = async () => {
        const lease = context.admission.acquire();
        if (!lease) throw new ApplicationAdmissionError();
        try {
          return await connection.invoke();
        } finally {
          lease.release();
        }
      };
    },
    drain: () => (stuckDrain ? new Promise(() => undefined) : undefined),
    close: () => {
      order.push('http');
    },
    force: () => {
      order.push('http-force');
    },
  });
  const app = createApplication({
    id: 'client-service',
    resources: [client, http],
    shutdown: { gracePeriodMs: 10, forceTimeoutMs: 100 },
  });
  return { app, client, clients, order, request: () => request() };
}

const normal = composition();
assert.equal(normal.app.admission.acquire(), null);
await normal.app.start();
assert.equal(await normal.request(), 1);
assert.equal(normal.clients[0].destroyed, 0);
assert.equal((await normal.app.restart({ resourceId: 'client' })).outcome, 'restarted');
assert.equal(await normal.request(), 2);
assert.deepEqual(
  normal.clients.map((record) => record.destroyed),
  [1, 0],
);
await normal.app.shutdown();
assert.deepEqual(normal.order, ['http', 'client', 'http', 'client']);
await assert.rejects(normal.request(), ApplicationAdmissionError);
const partial = composition({ failReady: true });
await assert.rejects(partial.app.start(), /partial startup/);
await partial.client.close();
await partial.client.force();
assert.equal(partial.clients[0].destroyed, 1);
const forced = composition({ stuckDrain: true });
await forced.app.start();
assert.equal((await forced.app.shutdown()).outcome, 'forced');
await forced.client.close();
await forced.client.force();
assert.equal(forced.clients[0].destroyed, 1);
console.log('packed managed client composition: ok');
