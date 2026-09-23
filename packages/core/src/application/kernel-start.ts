import type { ResolvedManagedResource } from './graph';
import { contextFor, markLateCompletion } from './kernel-resource-context';
import { closeAttempted } from './kernel-rollback';
import {
  ApplicationStartupInterruptedError,
  isReady,
  isStartResult,
  type KernelState,
  publish,
  ResourceCompletionBeforeReadyError,
  recordOf,
  reportFailure,
  snapshot,
} from './kernel-state';
import type { ApplicationSnapshot } from './schemas';

/**
 * Start these resources, in order.
 *
 * Extracted so a subtree restart runs the SAME code as a full startup
 * rather than a second copy of it. Only two things differ between the two
 * callers: which resources are being started, and whose abort signal ends
 * the attempt. Everything a resource can do on the way up — publish a value
 * before readiness, settle its completion first, report its own health —
 * is behaviour a restart has to reproduce exactly, and the only way to be
 * sure it does is for there to be one implementation.
 */
export async function startEach(
  state: KernelState,
  entries: readonly ResolvedManagedResource[],
  signal: AbortSignal,
): Promise<void> {
  for (const entry of entries) {
    if (state.shutdownRequested || signal.aborted) {
      throw new ApplicationStartupInterruptedError();
    }
    const record = recordOf(state, entry.id);
    const dependencyFailed = entry.dependsOn.some(
      (dependencyId) => state.records.get(dependencyId)?.state !== 'ready',
    );
    if (dependencyFailed) {
      record.state = 'failed';
      record.health = 'unhealthy';
      record.failures.push('start');
      publish(state);
      if (entry.required) {
        throw new Error(
          `[stitchkit] required resource "${entry.id}" has an unavailable dependency`,
        );
      }
      continue;
    }
    record.attempted = true;
    record.state = 'starting';
    publish(state);
    try {
      const started = await entry.resource.start(
        contextFor(state, record, { signal: signal }),
      );
      if (state.shutdownRequested || signal.aborted) {
        throw new ApplicationStartupInterruptedError();
      }
      if (isStartResult(started)) {
        record.runtime = started;
        // Published before readiness is awaited: a dependant only runs after
        // this resource reaches `ready`, and a resource that reports its own
        // readiness asynchronously still handed the value over here.
        if (started.value !== undefined) state.published.set(entry.id, started.value);
        let resourceReady = started.ready === undefined;
        let completionSettled = false;
        let completionFailure: unknown;
        const completion = started.completion?.then(
          () => {
            completionSettled = true;
            if (resourceReady) markLateCompletion(state, record);
          },
          (error: unknown) => {
            completionSettled = true;
            completionFailure = error;
            if (resourceReady) markLateCompletion(state, record, { error });
          },
        );
        if (started.ready && completion) {
          const readiness: Promise<'ready'> = started.ready.then(() => 'ready');
          const completionBeforeReady: Promise<'completion'> = completion.then(
            () => 'completion',
          );
          const first = await Promise.race([readiness, completionBeforeReady]);
          if (first === 'completion') {
            throw new ResourceCompletionBeforeReadyError(entry.id, completionFailure);
          }
          resourceReady = true;
          if (completionSettled) {
            throw new ResourceCompletionBeforeReadyError(entry.id, completionFailure);
          }
        } else if (started.ready) {
          await started.ready;
          resourceReady = true;
        } else if (completion) {
          void completion;
        }
      }
      if (state.shutdownRequested || signal.aborted) {
        throw new ApplicationStartupInterruptedError();
      }
      record.state = 'ready';
      // Only when the resource said nothing. A resource that reported its
      // own health during `start` has already answered this question, and
      // the answer is more specific than the default.
      if (!record.healthReported) {
        record.health = 'healthy';
        record.everHealthy = true;
      }
      publish(state);
    } catch (error) {
      // A shutdown arriving mid-startup does not make the resource's own
      // error stop being one. Only the kernel's own interruption is silent
      // here; anything the resource threw is recorded and reported, and
      // then re-thrown because the startup is over either way.
      const interrupted = state.shutdownRequested || signal.aborted;
      if (!(error instanceof ApplicationStartupInterruptedError)) {
        record.failures.push(
          error instanceof ResourceCompletionBeforeReadyError
            ? 'completion'
            : record.runtime?.ready
              ? 'ready'
              : 'start',
        );
        record.state = 'failed';
        record.health = 'unhealthy';
        reportFailure(
          state,
          entry.id,
          record.failures[record.failures.length - 1] ?? 'start',
          error,
        );
        publish(state);
      }
      if (interrupted || entry.required) throw error;
    }
  }
}

/** Activate these resources, in order. Same reasoning as `startEach`. */
export async function activateEach(
  state: KernelState,
  entries: readonly ResolvedManagedResource[],
  signal: AbortSignal,
): Promise<void> {
  for (const entry of entries) {
    if (state.shutdownRequested || signal.aborted) {
      throw new ApplicationStartupInterruptedError();
    }
    const record = state.records.get(entry.id);
    if (record?.state !== 'ready') continue;
    const dependencyUnavailable = entry.dependsOn.some((dependencyId) => {
      const dependency = state.records.get(dependencyId);
      return dependency?.state !== 'ready' || !dependency.activated;
    });
    if (dependencyUnavailable) {
      record.failures.push('start');
      record.state = 'failed';
      record.health = 'unhealthy';
      publish(state);
      if (entry.required) {
        throw new Error(
          `[stitchkit] required resource "${entry.id}" has an unavailable activation dependency`,
        );
      }
      continue;
    }
    try {
      // The check still fires for every required resource that is not ready
      // and healthy after activating — that is what pushes the phase onto
      // `failures`, calls `onResourceFailure`, and stops the cascade before
      // the next resource's `activate` arms a schedule or opens a long
      // poll. Loosening it to "lost it" alone kept the startup failing (the
      // final readiness gate still refuses) but reported no phase for it and
      // let every downstream activation run first.
      //
      // Only the WORDING depends on history: this test read "lost
      // readiness" when becoming ready assigned `healthy` unconditionally,
      // and a resource that reported `degraded` during `start` would
      // otherwise be told it lost something it never had.
      await entry.resource.activate?.(contextFor(state, record));
      if (state.shutdownRequested || signal.aborted) {
        throw new ApplicationStartupInterruptedError();
      }
      record.activated = true;
      if (entry.required && (record.state !== 'ready' || record.health !== 'healthy')) {
        const observed = `${record.state}/${record.health}`;
        throw new Error(
          record.everHealthy
            ? `[stitchkit] required resource "${entry.id}" lost readiness during activation (${observed})`
            : `[stitchkit] required resource "${entry.id}" is not healthy (${observed}). A required resource must be healthy for the application to be ready; a resource that is expected to start degraded belongs behind \`required: false\`.`,
        );
      }
    } catch (error) {
      // Same rule as the phase above: only the kernel's own interruption is
      // silent, and a resource that threw while activating is reported.
      const interrupted = state.shutdownRequested || signal.aborted;
      if (!(error instanceof ApplicationStartupInterruptedError)) {
        record.failures.push('start');
        record.state = 'failed';
        record.health = 'unhealthy';
        reportFailure(state, entry.id, 'start', error);
        publish(state);
      }
      if (interrupted || entry.required) throw error;
    }
  }
}

/**
 * The refusal a startup ends with when every phase ran and a required
 * resource is still not ready and healthy.
 *
 * Named, and described for what it is. "Lost readiness" was the only
 * way to get here while becoming ready assigned `healthy`
 * unconditionally; a resource that reports its own health can now
 * arrive here having never been healthy, and a message about losing
 * something is then a false lead.
 *
 * The advice is branched for the same reason, in the other direction:
 * telling the operator of a database that just dropped to put it behind
 * `required: false` is the worst possible suggestion. `everHealthy` is
 * the fact that separates the two: it says whether the resource ever
 * had the state it is now missing.
 */
function notReadyAfterStartup(state: KernelState): Error {
  const blocking = [...state.records.values()]
    .filter(
      (record) =>
        record.entry.required && (record.state !== 'ready' || record.health !== 'healthy'),
    )
    .map((record) => `${record.entry.id} (${record.state}/${record.health})`);
  // Cannot be empty today — `isReady()` being false means the same
  // predicate matches at least one required record — but a message that
  // renders as "required resources ." if that stops holding is a
  // formatting assumption, not a fact.
  if (blocking.length === 0) blocking.push('(none identified)');
  const chosen = [...state.records.values()].some(
    (record) => record.entry.required && record.health !== 'healthy' && !record.everHealthy,
  );
  return new Error(
    `[stitchkit] the application is not ready after startup — required ${blocking.length === 1 ? 'resource' : 'resources'} ${blocking.join(', ')}. A required resource must be healthy for the application to be ready; ${
      chosen
        ? 'a resource that is expected to start degraded belongs behind `required: false`.'
        : 'this one was healthy and stopped being so — read `onResourceFailure` for the cause.'
    }`,
  );
}

async function runStart(state: KernelState): Promise<ApplicationSnapshot> {
  state.lifecycle = 'starting';
  publish(state);
  let startFailure: unknown;
  try {
    await startEach(state, state.ordered, state.startupAbort.signal);

    state.lifecycle = 'ready';
    publish(state);
    await activateEach(state, state.ordered, state.startupAbort.signal);
    if (state.shutdownRequested) {
      throw new ApplicationStartupInterruptedError();
    }
    if (!isReady(state)) {
      throw notReadyAfterStartup(state);
    }
    state.activationComplete = true;
    state.accepting = isReady(state);
    publish(state);
    return snapshot(state);
  } catch (error) {
    startFailure = error;
  }

  if (!state.shutdownRequested) {
    const rollbackErrors = await closeAttempted(state);
    state.lifecycle = 'failed';
    state.accepting = false;
    publish(state);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [startFailure, ...rollbackErrors],
        '[stitchkit] application startup and rollback failed',
        { cause: startFailure },
      );
    }
  }
  throw startFailure;
}

/** `start()`: one attempt per application, shared by every caller. */
export function start(state: KernelState): Promise<ApplicationSnapshot> {
  if (state.startPromise) return state.startPromise;
  if (state.lifecycle !== 'created') {
    return Promise.reject(
      new Error(`[stitchkit] application cannot start from lifecycle "${state.lifecycle}"`),
    );
  }
  const started = runStart(state);
  state.startPromise = started;
  void started.catch(() => undefined);
  return started;
}
