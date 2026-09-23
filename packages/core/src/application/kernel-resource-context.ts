import {
  isReady,
  type KernelState,
  publish,
  type ResourceRecord,
  reportFailure,
} from './kernel-state';
import type {
  ManagedResource,
  ManagedResourceContext,
  ManagedResourcePublished,
} from './resource';

/** The context one resource is handed for one phase — its window onto the graph. */
export function contextFor(
  state: KernelState,
  record: ResourceRecord,
  options: { signal?: AbortSignal; deadlineAt?: number; forceDeadlineAt?: number } = {},
): ManagedResourceContext {
  return {
    applicationId: state.id,
    signal: options.signal ?? state.lifetimeAbort.signal,
    ...(options.deadlineAt !== undefined && { deadlineAt: options.deadlineAt }),
    ...(options.forceDeadlineAt !== undefined && {
      forceDeadlineAt: options.forceDeadlineAt,
    }),
    now: () => performance.now(),
    use<TResource extends ManagedResource>(resource: TResource) {
      const dependencyId = resource?.id;
      if (typeof dependencyId !== 'string' || dependencyId.length === 0) {
        throw new Error(
          `[stitchkit] resource "${record.entry.id}": use() takes a managed resource, and this one has no id`,
        );
      }
      // Declared-first, on purpose. Reading a value the graph was never told
      // about is an ordering bug that happens to work today: nothing makes the
      // owner start first, so it breaks the moment declaration order changes.
      if (!record.entry.dependsOn.includes(dependencyId)) {
        throw new Error(
          `[stitchkit] resource "${record.entry.id}" used "${dependencyId}" without declaring it in dependsOn`,
        );
      }
      if (!state.published.has(dependencyId)) {
        throw new Error(
          `[stitchkit] resource "${record.entry.id}" used "${dependencyId}", which published no value from start()`,
        );
      }
      // Boundary: the store is one untyped map for the whole graph, while the
      // signature's type is computed from the caller's own literal resource
      // type. There is no representation that is both, so the bridge is here
      // and nowhere else.
      return state.published.get(dependencyId) as ManagedResourcePublished<TResource>;
    },
    reportHealth(health) {
      if (record.state === 'stopped') return;
      record.health = health;
      record.healthReported = true;
      if (health === 'healthy') record.everHealthy = true;
      state.accepting = state.activationComplete && !state.shutdownRequested && isReady(state);
      publish(state);
    },
  };
}

/**
 * A long-lived resource that ended AFTER it was ready.
 *
 * `failure` used to be a boolean, and the value the resource rejected with —
 * in scope at the call site — was dropped on the floor. So a poller, a queue
 * consumer or a bot that died an hour after `start()` recorded the phase and
 * nothing else, while the documented contract said every failure of a
 * resource's own code reports its cause. The phase label is the half an
 * operator already has; the cause is the half they need.
 *
 * `undefined` means the resource simply finished, which is not a failure.
 */
export function markLateCompletion(
  state: KernelState,
  record: ResourceRecord,
  failure?: { error: unknown },
): void {
  if (state.shutdownRequested || record.state === 'stopping' || record.state === 'stopped') {
    return;
  }
  if (failure) {
    record.failures.push('completion');
    reportFailure(state, record.entry.id, 'completion', failure.error);
  }
  record.state = 'failed';
  record.health = 'unhealthy';
  state.accepting = state.activationComplete && isReady(state);
  publish(state);
}
