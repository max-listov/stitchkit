import {
  type ManagedResourceConformanceConfig,
  ManagedResourceConformanceError,
  type ManagedResourceConformanceScenario,
  ManagedResourceConformanceScenarioIdSchema,
} from './managed-resource-conformance-contract';
import {
  createManagedResourceConformanceGates,
  ManagedResourceConformanceTrace,
} from './managed-resource-conformance-driver';
import {
  executeManagedResourceConformanceScenario,
  expectedManagedResourceConformanceTrace,
  MANAGED_RESOURCE_CONFORMANCE_SCENARIOS,
} from './managed-resource-conformance-scenarios';

const DEFAULT_WATCHDOG_TIMEOUT_MS = 2_000;

class ManagedResourceConformanceWatchdogError extends Error {
  constructor(readonly phase: 'factory' | 'scenario' | 'settlement' | 'dispose') {
    super(`emergency watchdog expired during ${phase}`);
    this.name = 'ManagedResourceConformanceWatchdogError';
  }
}

async function withWatchdog<T>(
  promise: Promise<T>,
  timeoutMs: number,
  phase: ManagedResourceConformanceWatchdogError['phase'],
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new ManagedResourceConformanceWatchdogError(phase)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function detailOf(error: unknown): string {
  if (error instanceof ManagedResourceConformanceWatchdogError) return error.message;
  if (error instanceof Error) return error.message;
  return 'unknown conformance failure';
}

async function runScenario(
  config: ManagedResourceConformanceConfig,
  scenario: ManagedResourceConformanceScenario,
  watchdogTimeoutMs: number,
): Promise<void> {
  const trace = new ManagedResourceConformanceTrace();
  const gates = createManagedResourceConformanceGates(trace);
  const fixture = await withWatchdog(
    Promise.resolve().then(() => config.createFixture({ scenario, controls: gates.controls })),
    watchdogTimeoutMs,
    'factory',
  ).catch((error: unknown) => {
    throw new ManagedResourceConformanceError(
      scenario.id,
      expectedManagedResourceConformanceTrace(scenario.id),
      trace.entries,
      detailOf(error),
    );
  });
  let failure: { readonly value: unknown } | undefined;
  const execution = executeManagedResourceConformanceScenario(
    scenario,
    fixture.resource,
    gates,
    trace,
  );
  void execution.catch(() => undefined);
  let settlementIncomplete = false;
  try {
    await withWatchdog(execution, watchdogTimeoutMs, 'scenario');
  } catch (error) {
    failure = { value: error };
  } finally {
    gates.releaseAll();
    if (failure?.value instanceof ManagedResourceConformanceWatchdogError) {
      try {
        await withWatchdog(execution, watchdogTimeoutMs, 'settlement');
      } catch (error) {
        if (error instanceof ManagedResourceConformanceWatchdogError) {
          settlementIncomplete = true;
        } else {
          failure = { value: error };
        }
      }
    }
    trace.record('dispose', 'enter');
    try {
      await withWatchdog(Promise.resolve(fixture.dispose()), watchdogTimeoutMs, 'dispose');
      trace.record('dispose', 'resolve');
    } catch (error) {
      trace.record('dispose', 'reject');
      if (failure === undefined) failure = { value: error };
    }
    if (settlementIncomplete) {
      try {
        await withWatchdog(execution, watchdogTimeoutMs, 'settlement');
        settlementIncomplete = false;
      } catch (error) {
        if (error instanceof ManagedResourceConformanceWatchdogError) {
          const original = failure?.value;
          failure = {
            value: new Error(
              `${detailOf(original)}; execution remained live after fixture disposal`,
            ),
          };
        } else {
          settlementIncomplete = false;
          failure = { value: error };
        }
      }
    }
  }
  if (failure !== undefined) {
    if (failure.value instanceof ManagedResourceConformanceError) throw failure.value;
    throw new ManagedResourceConformanceError(
      scenario.id,
      expectedManagedResourceConformanceTrace(scenario.id),
      trace.entries,
      detailOf(failure.value),
    );
  }
}

/** Run deterministic black-box lifecycle scenarios against a consumer-owned managed resource. */
export async function runManagedResourceConformance(
  config: ManagedResourceConformanceConfig,
): Promise<void> {
  const watchdogTimeoutMs = config.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS;
  if (!Number.isSafeInteger(watchdogTimeoutMs) || watchdogTimeoutMs <= 0) {
    throw new TypeError(
      '[stitchkit] managed resource conformance watchdogTimeoutMs must be positive',
    );
  }
  const selected = new Set(
    (
      config.scenarios ?? MANAGED_RESOURCE_CONFORMANCE_SCENARIOS.map((scenario) => scenario.id)
    ).map((scenario) => ManagedResourceConformanceScenarioIdSchema.parse(scenario)),
  );
  if (selected.size === 0) {
    throw new TypeError(
      '[stitchkit] managed resource conformance scenarios must not be empty',
    );
  }
  for (const scenario of MANAGED_RESOURCE_CONFORMANCE_SCENARIOS) {
    if (!selected.has(scenario.id)) continue;
    await runScenario(config, scenario, watchdogTimeoutMs);
  }
}

export {
  type ManagedResourceConformanceConfig,
  type ManagedResourceConformanceControls,
  ManagedResourceConformanceError,
  type ManagedResourceConformanceFactoryInput,
  type ManagedResourceConformanceFixture,
  type ManagedResourceConformancePhase,
  ManagedResourceConformancePhaseSchema,
  type ManagedResourceConformanceScenario,
  type ManagedResourceConformanceScenarioId,
  ManagedResourceConformanceScenarioIdSchema,
  ManagedResourceConformanceScenarioSchema,
  type ManagedResourceConformanceTraceEntry,
  ManagedResourceConformanceTraceEntrySchema,
  type ManagedResourceConformanceTraceOutcome,
  ManagedResourceConformanceTraceOutcomeSchema,
} from './managed-resource-conformance-contract';
