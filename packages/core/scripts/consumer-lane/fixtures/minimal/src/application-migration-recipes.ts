import {
  createActivityProjection,
  createApplication,
  createApplicationSnapshotSink,
  defineManagedResource,
  managedServerResource,
} from 'stitchkit/application';
import { defineContract } from 'stitchkit/contract';
import { createServer, implement } from 'stitchkit/server';
import { z } from 'zod';

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`application migration recipe failed: ${message}`);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function databaseRecipe(): Promise<void> {
  let connected = false;
  let closes = 0;
  const database = defineManagedResource({
    id: 'database',
    async start({ signal }) {
      if (signal.aborted) throw signal.reason;
      connected = true;
      throw new Error('connection validation failed after allocation');
    },
    async close() {
      if (connected) {
        connected = false;
        closes += 1;
      }
    },
  });
  const application = createApplication({ id: 'database-recipe', resources: [database] });

  let rejected = false;
  try {
    await application.start();
  } catch {
    rejected = true;
  }
  check(rejected, 'partial database start must reject');
  check(!connected && closes === 1, 'partial database allocation must close exactly once');
}

async function pollerRecipe(): Promise<void> {
  const beforeReady = deferred();
  const beforeCompletion = deferred();
  let beforeCloses = 0;
  const earlyApplication = createApplication({
    id: 'poller-before-ready-recipe',
    resources: [
      defineManagedResource({
        id: 'poller',
        start: () => ({ ready: beforeReady.promise, completion: beforeCompletion.promise }),
        close: () => {
          beforeCloses += 1;
        },
      }),
    ],
  });
  const earlyStart = earlyApplication.start();
  await Promise.resolve();
  beforeCompletion.resolve();
  let earlyRejected = false;
  try {
    await earlyStart;
  } catch {
    earlyRejected = true;
  }
  check(earlyRejected && beforeCloses === 1, 'completion before readiness must roll back');

  const afterReady = deferred();
  let failAfterReady: (error: unknown) => void = () => undefined;
  const afterCompletion = new Promise<void>((_resolve, reject) => {
    failAfterReady = reject;
  });
  const liveApplication = createApplication({
    id: 'poller-after-ready-recipe',
    resources: [
      defineManagedResource({
        id: 'poller',
        start: () => ({ ready: afterReady.promise, completion: afterCompletion }),
        close: () => undefined,
      }),
    ],
  });
  const liveStart = liveApplication.start();
  afterReady.resolve();
  await liveStart;
  failAfterReady(new Error('poller stopped'));
  await Promise.resolve();
  await Promise.resolve();
  check(!liveApplication.getSnapshot().ready, 'late poller failure must remove readiness');
  await liveApplication.shutdown();
}

async function queueRecipe(): Promise<void> {
  const acceptedWork = deferred();
  const outcomes: string[] = [];
  const application = createApplication({ id: 'queue-recipe' });
  await application.start();

  const deliver = async (delivery: 'accepted' | 'late'): Promise<void> => {
    const lease = application.admission.acquire();
    if (!lease) {
      outcomes.push(`${delivery}:nack-requeue`);
      return;
    }
    try {
      outcomes.push(`${delivery}:claimed`);
      await acceptedWork.promise;
      outcomes.push(`${delivery}:acked`);
    } finally {
      lease.release();
    }
  };

  const accepted = deliver('accepted');
  await Promise.resolve();
  const shutdown = application.shutdown();
  await deliver('late');
  acceptedWork.resolve();
  await accepted;
  const result = await shutdown;

  check(
    outcomes.join(',') === 'accepted:claimed,late:nack-requeue,accepted:acked',
    'provider delivery after admission close must be nacked/requeued',
  );
  check(
    result.acceptedOperations === 1 && result.completedOperations === 1,
    'accepted queue work must drain through the application lease',
  );
}

async function operationalPublisherRecipe(): Promise<void> {
  const firstWrite = deferred();
  const revisions: number[] = [];
  const publisher = createApplicationSnapshotSink({
    async write(snapshot: { readonly revision: number }) {
      revisions.push(snapshot.revision);
      if (snapshot.revision === 0) await firstWrite.promise;
    },
  });
  const activity = createActivityProjection({
    id: 'publisher-recipe',
    stages: ['queued', 'running'],
  });
  const unsubscribe = activity.subscribe((snapshot) => {
    publisher.publish(snapshot);
  });
  await Promise.resolve();

  const token = activity.open('queued', 'queued');
  activity.transition(token, { stage: 'running', state: 'active' });
  activity.complete(token);

  unsubscribe();
  check(
    publisher.publish(activity.getSnapshot()),
    'cleanup must explicitly admit the final absolute snapshot before sink close',
  );
  const closing = publisher.close();
  firstWrite.resolve();
  const status = await closing;
  check(
    revisions.join(',') === '0,3',
    'slow publisher must receive initial then latest snapshot',
  );
  check(status.lastDeliveredRevision === 3, 'close must flush the final accepted revision');
}

async function dependencyValueRecipe(): Promise<void> {
  const database = defineManagedResource({
    id: 'database',
    start: async () => {
      await Promise.resolve();
      return { value: { dsn: 'memory://recipes' } };
    },
  });
  let seenDsn = '';
  const worker = defineManagedResource({
    id: 'worker',
    dependsOn: [database],
    start(context) {
      // No module-local, no null guard the graph makes unreachable: the type
      // here is the published object, not "the published object or null".
      seenDsn = context.use(database).dsn;
    },
  });
  const application = createApplication({ id: 'value-recipe', resources: [database, worker] });
  await application.start();
  check(
    seenDsn === 'memory://recipes',
    'a dependant must read the value its dependency published',
  );

  let refused = '';
  const undeclared = createApplication({
    id: 'undeclared-recipe',
    resources: [
      database,
      defineManagedResource({
        id: 'stranger',
        start(context) {
          context.use(database);
        },
      }),
    ],
  });
  try {
    await undeclared.start();
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error);
  }
  check(
    refused.includes('without declaring it in dependsOn'),
    'reading a value from an undeclared dependency must be refused',
  );
  await application.shutdown();
}

async function managedHttpServerRecipe(): Promise<void> {
  const contract = defineContract(
    { prefix: 'recipes' },
    {
      ping: {
        method: 'GET',
        path: '/',
        desc: 'Answer while the application is up',
        output: z.object({ ok: z.boolean() }),
      },
    },
  );
  const services = [implement(contract, { ping: () => ({ ok: true }) })];

  let databaseReady = false;
  const database = defineManagedResource({
    id: 'database',
    start() {
      databaseReady = true;
    },
  });
  const http = managedServerResource({
    id: 'http',
    dependsOn: [database],
    // The port is bound here, during `start`, after the database is ready —
    // which is the whole reason to hand this resource a thunk instead of an
    // already-listening server.
    server: () => {
      check(databaseReady, 'the server must be created after its dependency is ready');
      return createServer({ port: 0, services });
    },
  });
  // The server's own handle, read the way any dependant would read it.
  let url = '';
  const probe = defineManagedResource({
    id: 'probe',
    dependsOn: [http],
    start(context) {
      url = context.use(http).url;
    },
  });
  const application = createApplication({
    id: 'http-recipe',
    resources: [database, http, probe],
  });
  await application.start();
  check(url.length > 0, 'the server resource must publish its handle to dependants');

  const response = await fetch(`${url}/recipes`);
  check(response.status === 200, 'the application must be listening once start resolves');
  await application.shutdown();
  let refusedAfterShutdown = false;
  try {
    await fetch(`${url}/recipes`);
  } catch {
    refusedAfterShutdown = true;
  }
  check(refusedAfterShutdown, 'the application must stop listening after shutdown');
}

await databaseRecipe();
await pollerRecipe();
await queueRecipe();
await operationalPublisherRecipe();
await dependencyValueRecipe();
await managedHttpServerRecipe();
console.log('application migration recipes: ok');
