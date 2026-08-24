import type {
  ManagedResource,
  ManagedResourceContext,
  ManagedResourceStartResult,
} from '../application/resource';
import {
  type ManagedResourceConformanceControls,
  type ManagedResourceConformancePhase,
  type ManagedResourceConformanceTraceEntry,
  ManagedResourceConformanceTraceEntrySchema,
  type ManagedResourceConformanceTraceOutcome,
} from './managed-resource-conformance-contract';

interface ControlledPromise {
  readonly promise: Promise<void>;
  resolve(): boolean;
  reject(error: unknown): boolean;
}

function controlledPromise(): ControlledPromise {
  const deferred = Promise.withResolvers<void>();
  let settled = false;
  void deferred.promise.catch(() => undefined);
  return {
    promise: deferred.promise,
    resolve() {
      if (settled) return false;
      settled = true;
      deferred.resolve();
      return true;
    },
    reject(error) {
      if (settled) return false;
      settled = true;
      deferred.reject(error);
      return true;
    },
  };
}

export interface ManagedResourceConformanceGates {
  readonly controls: ManagedResourceConformanceControls;
  resolve(phase: GatePhase): void;
  reject(phase: GatePhase, error: unknown): void;
  releaseAll(): void;
}

export type GatePhase = 'start' | 'readiness' | 'completion' | 'activate' | 'close' | 'force';

export class ManagedResourceConformanceTrace {
  readonly entries: ManagedResourceConformanceTraceEntry[] = [];
  private readonly waiters = new Set<{
    readonly phase: ManagedResourceConformancePhase;
    readonly outcome: ManagedResourceConformanceTraceOutcome;
    readonly resolve: () => void;
  }>();

  record(
    phase: ManagedResourceConformancePhase,
    outcome: ManagedResourceConformanceTraceOutcome,
  ): void {
    const entry = ManagedResourceConformanceTraceEntrySchema.parse({
      sequence: this.entries.length,
      phase,
      outcome,
    });
    this.entries.push(entry);
    for (const waiter of this.waiters) {
      if (waiter.phase !== phase || waiter.outcome !== outcome) continue;
      this.waiters.delete(waiter);
      waiter.resolve();
    }
  }

  has(
    phase: ManagedResourceConformancePhase,
    outcome: ManagedResourceConformanceTraceOutcome,
  ): boolean {
    return this.entries.some((entry) => entry.phase === phase && entry.outcome === outcome);
  }

  count(
    phase: ManagedResourceConformancePhase,
    outcome: ManagedResourceConformanceTraceOutcome,
  ): number {
    return this.entries.filter((entry) => entry.phase === phase && entry.outcome === outcome)
      .length;
  }

  waitFor(
    phase: ManagedResourceConformancePhase,
    outcome: ManagedResourceConformanceTraceOutcome = 'enter',
  ): Promise<void> {
    if (this.has(phase, outcome)) return Promise.resolve();
    return new Promise((resolve) => this.waiters.add({ phase, outcome, resolve }));
  }
}

export function createManagedResourceConformanceGates(
  trace: ManagedResourceConformanceTrace,
): ManagedResourceConformanceGates {
  const startup = controlledPromise();
  const readiness = controlledPromise();
  const completion = controlledPromise();
  const activation = controlledPromise();
  const close = controlledPromise();
  const force = controlledPromise();
  const gateFor = (phase: GatePhase): ControlledPromise => {
    if (phase === 'start') return startup;
    if (phase === 'readiness') return readiness;
    if (phase === 'completion') return completion;
    if (phase === 'activate') return activation;
    if (phase === 'close') return close;
    return force;
  };
  const resolve = (phase: GatePhase): void => {
    if (gateFor(phase).resolve()) trace.record(phase, 'resolve');
  };
  return {
    controls: {
      startup: startup.promise,
      readiness: readiness.promise,
      completion: completion.promise,
      activation: activation.promise,
      close: close.promise,
      force: force.promise,
    },
    resolve,
    reject(phase, error) {
      if (gateFor(phase).reject(error)) trace.record(phase, 'reject');
    },
    releaseAll() {
      resolve('start');
      resolve('readiness');
      resolve('completion');
      resolve('activate');
      resolve('close');
      resolve('force');
    },
  };
}

type AsyncResourcePhase = 'activate' | 'drain' | 'close' | 'force';

async function observePhase<T>(
  trace: ManagedResourceConformanceTrace,
  phase: ManagedResourceConformancePhase,
  invoke: () => T | Promise<T>,
): Promise<T> {
  trace.record(phase, 'enter');
  try {
    const value = await invoke();
    trace.record(phase, 'resolve');
    return value;
  } catch (error) {
    trace.record(phase, 'reject');
    throw error;
  }
}

function optionalPhase(
  resource: ManagedResource,
  trace: ManagedResourceConformanceTrace,
  phase: AsyncResourcePhase,
  invoke: ((context: ManagedResourceContext) => void | Promise<void>) | undefined,
): {
  readonly [K in AsyncResourcePhase]?: (context: ManagedResourceContext) => Promise<void>;
} {
  if (!invoke) return {};
  return {
    [phase]: (context: ManagedResourceContext) =>
      observePhase(trace, phase, () => invoke.call(resource, context)),
  };
}

export function observeManagedResource(
  resource: ManagedResource,
  required: boolean,
  trace: ManagedResourceConformanceTrace,
): ManagedResource {
  const start = async (
    context: ManagedResourceContext,
  ): Promise<ManagedResourceStartResult | undefined> => {
    trace.record('start', 'enter');
    try {
      const value = await resource.start(context);
      trace.record('start', 'resolve');
      if (value === undefined) return undefined;
      return value;
    } catch (error) {
      trace.record('start', 'reject');
      throw error;
    }
  };
  return {
    id: resource.id,
    required,
    start,
    ...optionalPhase(resource, trace, 'activate', resource.activate),
    ...(resource.stopAdmission
      ? {
          stopAdmission: (context: ManagedResourceContext) =>
            observePhase(trace, 'stop-admission', () =>
              resource.stopAdmission?.call(resource, context),
            ),
        }
      : {}),
    ...optionalPhase(resource, trace, 'drain', resource.drain),
    ...optionalPhase(resource, trace, 'close', resource.close),
    ...optionalPhase(resource, trace, 'force', resource.force),
  };
}
