/**
 * The `stitchkit/application` factories nothing else in this lane executes.
 *
 * Thirteen factories leave that entrypoint. Seven are reached by some fixture;
 * six were reached by none — `createDecisionPipeline`,
 * `createApplicationEventSink`, `createApplicationHealthHandler`,
 * `createApplicationOperationalHandlers`, `createRevisionSignal` and
 * `createWatchHub`. Their declarations are checked, since
 * `check-declarations-strict` compiles every emitted one, and the in-repo suite
 * exercises them thoroughly from `src`. What nothing did was *run* them out of
 * the packed tarball.
 *
 * That is the gap this lane exists for, and its whole history is defects that
 * live only in the built copy: an environment read a bundler constant-folded, a
 * `node:` construction evaluated at module scope, a type public in a signature
 * and exported nowhere. The entrypoint as a whole is exercised elsewhere, so a
 * module-initialisation failure would already show; a single name folded away,
 * mis-exported, or broken only in `dist` would not.
 *
 * The peer-free fixture on purpose: none of these six should want an optional
 * peer, and asserting that is half of what is being asserted.
 */
import {
  type ApplicationSnapshot,
  createApplication,
  createApplicationEventSink,
  createApplicationHealthHandler,
  createApplicationOperationalHandlers,
  createDecisionPipeline,
  createRevisionSignal,
  createWatchHub,
  type WatchSubscriber,
  watchKey,
} from 'stitchkit/application';

const failures: string[] = [];
const check = (name: string, ok: boolean): void => {
  if (!ok) failures.push(name);
};

// 1. A decision pipeline, including the timeout that deliberately has no default.
const pipeline = createDecisionPipeline<{ scope: string }>(
  [
    { id: 'defer-reads', decide: () => ({ outcome: 'defer' as const }) },
    {
      id: 'refuse-writes',
      decide: (input) =>
        input.scope === 'write'
          ? { outcome: 'deny' as const, reason: 'writes are refused here' }
          : { outcome: 'allow' as const },
    },
  ],
  { policyTimeoutMs: 1_000 },
);
const allowed = await pipeline.decide({ scope: 'read' });
const denied = await pipeline.decide({ scope: 'write' });
check('pipeline allows a read', allowed.outcome === 'allow');
check('pipeline denies a write', denied.outcome === 'deny');
check('pipeline reports the deciding words', denied.reason === 'writes are refused here');
check('pipeline names its policies', pipeline.policyIds.length === 2);

// 2. A revision signal: one advance wakes everyone behind it, not just the first.
const signal = createRevisionSignal({ maxWaiters: 4 });
const parked = [signal.wait(0), signal.wait(0)];
const advanced = signal.advance();
const woken = await Promise.all(parked);
check(
  'revision signal wakes both waiters',
  woken.every((result) => result.outcome === 'changed'),
);
check('revision signal is monotonic', advanced.revision === 1);
check('revision signal closes clean', signal.close().state === 'closed');

// 3. A watch hub: two subscribers to one question cause one read.
const listeners = new Set<() => void>();
let reads = 0;
const hub = createWatchHub({
  read: async () => {
    reads += 1;
    return { notes: reads };
  },
  watchable: () => true,
  invalidatedBy: () => ['notes.changed'],
  subscribe: (_topic, listener) => {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
});
const received: unknown[] = [];
const subscriber: WatchSubscriber = {
  value: (frame) => void received.push(frame.value),
  state: () => undefined,
};
const key = watchKey({ service: 'notes', action: 'list' }, { folder: 'a' });
const opened = hub.attach(subscriber).open(key, { folder: 'a' });
const second = hub.attach({ value: () => undefined, state: () => undefined }).open(key, {
  folder: 'a',
});
for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
await new Promise((resolve) => setTimeout(resolve, 25));
check('watch hub accepted the key', opened.accepted && second.accepted);
check('watch hub read once for two subscribers', hub.readCount() === 1);
check('watch hub delivered the value', received.length >= 1);
hub.close();

// 4. An event sink and both operational handler factories, over a real handle.
const revisions: number[] = [];
const sink = createApplicationEventSink({
  write: (event) => void revisions.push(event.revision),
});
const application = createApplication({
  id: 'primitives',
  onSnapshot: (snapshot: ApplicationSnapshot) => sink.publish(snapshot),
});
await application.start();
const liveness = createApplicationHealthHandler(application, { kind: 'liveness' });
const readiness = createApplicationHealthHandler(application, { kind: 'readiness' });
const operational = createApplicationOperationalHandlers(application);
check('liveness answers 200', liveness().status === 200);
check('readiness answers 200', readiness().status === 200);
check('the status handler answers 200', operational.status().status === 200);
await application.shutdown();
await sink.close();
check('the event sink saw lifecycle revisions', revisions.length > 1);

// Thrown, not `process.exit`: this fixture compiles with `types: []`, which is
// the point of it — a consumer who installed no Node types is exactly who must
// be able to use these names. A throw is a non-zero exit here anyway.
if (failures.length > 0) {
  throw new Error(`application primitives conformance FAILED: ${failures.join(', ')}`);
}
console.log('application primitives conformance: ok (6 previously unexercised factories)');
