import {
  createActivityProjection,
  createApplication,
  createApplicationSnapshotSink,
  defineManagedResource,
} from 'stitchkit/application';

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

await databaseRecipe();
await pollerRecipe();
await queueRecipe();
await operationalPublisherRecipe();
console.log('application migration recipes: ok');
