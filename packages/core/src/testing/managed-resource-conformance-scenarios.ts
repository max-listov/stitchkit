import { type ApplicationHandle, createApplication } from '../application/kernel';
import type { ApplicationSnapshot } from '../application/schemas';
import {
  type ManagedResourceConformanceScenario,
  type ManagedResourceConformanceScenarioId,
  ManagedResourceConformanceScenarioSchema,
} from './managed-resource-conformance-contract';
import {
  type ManagedResourceConformanceGates,
  type ManagedResourceConformanceTrace,
  observeManagedResource,
} from './managed-resource-conformance-driver';

export const MANAGED_RESOURCE_CONFORMANCE_SCENARIOS =
  ManagedResourceConformanceScenarioSchema.array().parse([
    { id: 'clean-shutdown', required: true },
    { id: 'partial-start-rollback', required: true },
    { id: 'readiness-rejection', required: true },
    { id: 'completion-before-ready', required: true },
    { id: 'required-late-completion', required: true },
    { id: 'optional-late-completion', required: false },
    { id: 'activation-rejection', required: true },
    { id: 'shutdown-during-startup', required: true },
    { id: 'force-after-stalled-close', required: true },
  ]);

const EXPECTED_TRACE: Record<ManagedResourceConformanceScenarioId, readonly string[]> = {
  'clean-shutdown': [
    'start:enter',
    'start:resolve',
    'readiness:resolve',
    'activate:enter',
    'activate:resolve',
    'stop-admission:enter',
    'drain:enter',
    'close:enter',
    'close:resolve',
  ],
  'partial-start-rollback': ['start:enter', 'start:reject', 'close:enter', 'close:resolve'],
  'readiness-rejection': [
    'start:enter',
    'start:resolve',
    'readiness:reject',
    'close:enter',
    'close:resolve',
  ],
  'completion-before-ready': [
    'start:enter',
    'start:resolve',
    'completion:reject',
    'close:enter',
    'close:resolve',
  ],
  'required-late-completion': [
    'activate:resolve',
    'completion:reject',
    'stop-admission:enter',
    'drain:enter',
    'close:enter',
  ],
  'optional-late-completion': [
    'activate:resolve',
    'completion:reject',
    'stop-admission:enter',
    'drain:enter',
    'close:enter',
  ],
  'activation-rejection': [
    'readiness:resolve',
    'activate:enter',
    'activate:reject',
    'close:enter',
    'close:resolve',
  ],
  'shutdown-during-startup': ['start:enter', 'start:resolve', 'close:enter', 'close:resolve'],
  'force-after-stalled-close': [
    'stop-admission:enter',
    'drain:enter',
    'close:enter',
    'force:enter',
    'force:resolve',
  ],
};

interface ScenarioRuntime {
  readonly scenario: ManagedResourceConformanceScenario;
  readonly application: ApplicationHandle;
  readonly gates: ManagedResourceConformanceGates;
  readonly trace: ManagedResourceConformanceTrace;
}

interface PromiseOutcome {
  readonly status: 'resolved' | 'rejected';
  readonly error?: unknown;
}

function outcomeOf(promise: Promise<unknown>): Promise<PromiseOutcome> {
  return promise.then(
    () => ({ status: 'resolved' }),
    (error: unknown) => ({ status: 'rejected', error }),
  );
}

function requireCondition(condition: boolean, detail: string): void {
  if (!condition) throw new Error(detail);
}

function observedTrace(trace: ManagedResourceConformanceTrace): string[] {
  return trace.entries.map((entry) => `${entry.phase}:${entry.outcome}`);
}

function requireTrace(runtime: ScenarioRuntime): void {
  const expected = EXPECTED_TRACE[runtime.scenario.id];
  const observed = observedTrace(runtime.trace);
  let cursor = 0;
  for (const entry of observed) {
    if (entry === expected[cursor]) cursor += 1;
  }
  requireCondition(
    cursor === expected.length,
    `phase trace omitted or reordered "${expected[cursor] ?? 'unknown'}"`,
  );
}

async function phaseOrSettlement(
  trace: ManagedResourceConformanceTrace,
  phase: 'close' | 'force',
  settlement: Promise<unknown>,
): Promise<'phase' | 'settled'> {
  return Promise.race([
    trace.waitFor(phase).then((): 'phase' => 'phase'),
    settlement.then(
      (): 'settled' => 'settled',
      (): 'settled' => 'settled',
    ),
  ]);
}

async function startSuccessfully(runtime: ScenarioRuntime): Promise<void> {
  const starting = runtime.application.start();
  const startOutcome = outcomeOf(starting);
  await runtime.trace.waitFor('start');
  runtime.gates.resolve('start');
  runtime.gates.resolve('readiness');
  const activation = await Promise.race([
    runtime.trace.waitFor('activate').then((): PromiseOutcome => ({ status: 'resolved' })),
    startOutcome,
  ]);
  if (activation.status === 'rejected') throw activation.error;
  runtime.gates.resolve('activate');
  const outcome = await startOutcome;
  requireCondition(
    outcome.status === 'resolved',
    'application did not complete successful startup',
  );
}

async function closeNormally(runtime: ScenarioRuntime): Promise<void> {
  const shuttingDown = runtime.application.shutdown();
  const close = await phaseOrSettlement(runtime.trace, 'close', shuttingDown);
  if (close === 'phase') runtime.gates.resolve('close');
  const outcome = await outcomeOf(shuttingDown);
  requireCondition(outcome.status === 'resolved', 'application shutdown rejected');
}

async function expectStartupFailure(
  runtime: ScenarioRuntime,
  starting: Promise<ApplicationSnapshot>,
): Promise<void> {
  const close = await phaseOrSettlement(runtime.trace, 'close', starting);
  if (close === 'phase') runtime.gates.resolve('close');
  const outcome = await outcomeOf(starting);
  if (outcome.status === 'resolved') {
    await closeNormally(runtime);
    throw new Error('application startup unexpectedly resolved');
  }
  requireCondition(
    runtime.trace.count('close', 'enter') === 1,
    'attempted resource was not closed once',
  );
  await runtime.application.shutdown();
}

function waitForSnapshot(
  application: ApplicationHandle,
  predicate: (snapshot: ApplicationSnapshot) => boolean,
): Promise<ApplicationSnapshot> {
  const deferred = Promise.withResolvers<ApplicationSnapshot>();
  let unsubscribe: () => void = () => undefined;
  unsubscribe = application.subscribe((snapshot) => {
    if (!predicate(snapshot)) return;
    unsubscribe();
    deferred.resolve(snapshot);
  });
  return deferred.promise;
}

async function cleanShutdown(runtime: ScenarioRuntime): Promise<void> {
  await startSuccessfully(runtime);
  await closeNormally(runtime);
  requireCondition(
    runtime.application.getSnapshot().lifecycle === 'stopped',
    'clean shutdown did not stop the application',
  );
}

async function partialStartRollback(runtime: ScenarioRuntime): Promise<void> {
  const starting = runtime.application.start();
  await runtime.trace.waitFor('start');
  runtime.gates.reject('start', new Error('controlled partial startup rejection'));
  await expectStartupFailure(runtime, starting);
}

async function readinessRejection(runtime: ScenarioRuntime): Promise<void> {
  const starting = runtime.application.start();
  await runtime.trace.waitFor('start');
  runtime.gates.resolve('start');
  await runtime.trace.waitFor('start', 'resolve');
  runtime.gates.reject('readiness', new Error('controlled readiness rejection'));
  runtime.gates.resolve('activate');
  await expectStartupFailure(runtime, starting);
}

async function completionBeforeReady(runtime: ScenarioRuntime): Promise<void> {
  const starting = runtime.application.start();
  await runtime.trace.waitFor('start');
  runtime.gates.resolve('start');
  await runtime.trace.waitFor('start', 'resolve');
  runtime.gates.reject('completion', new Error('controlled early completion rejection'));
  runtime.gates.resolve('readiness');
  runtime.gates.resolve('activate');
  await expectStartupFailure(runtime, starting);
}

async function lateCompletion(runtime: ScenarioRuntime): Promise<void> {
  await startSuccessfully(runtime);
  const expectedHealth = runtime.scenario.required ? 'unhealthy' : 'degraded';
  const changed = waitForSnapshot(
    runtime.application,
    (snapshot) => snapshot.health === expectedHealth,
  );
  runtime.gates.reject('completion', new Error('controlled late completion rejection'));
  const snapshot = await changed;
  requireCondition(
    snapshot.lifecycle === 'ready',
    'late completion changed lifecycle ownership',
  );
  requireCondition(
    snapshot.health === expectedHealth,
    'late completion projected the wrong health',
  );
  requireCondition(
    snapshot.ready === !runtime.scenario.required,
    'late completion projected the wrong readiness',
  );
  requireCondition(
    snapshot.admission.accepting === !runtime.scenario.required,
    'late completion projected the wrong admission state',
  );
  await closeNormally(runtime);
}

async function activationRejection(runtime: ScenarioRuntime): Promise<void> {
  const starting = runtime.application.start();
  await runtime.trace.waitFor('start');
  runtime.gates.resolve('start');
  await runtime.trace.waitFor('start', 'resolve');
  runtime.gates.resolve('readiness');
  await runtime.trace.waitFor('activate');
  runtime.gates.reject('activate', new Error('controlled activation rejection'));
  await expectStartupFailure(runtime, starting);
}

async function shutdownDuringStartup(runtime: ScenarioRuntime): Promise<void> {
  const starting = runtime.application.start();
  await runtime.trace.waitFor('start');
  const shuttingDown = runtime.application.shutdown();
  runtime.gates.resolve('start');
  const close = await phaseOrSettlement(runtime.trace, 'close', shuttingDown);
  if (close === 'phase') runtime.gates.resolve('close');
  const [startOutcome, shutdownOutcome] = await Promise.all([
    outcomeOf(starting),
    outcomeOf(shuttingDown),
  ]);
  requireCondition(startOutcome.status === 'rejected', 'startup won the shutdown race');
  requireCondition(shutdownOutcome.status === 'resolved', 'shutdown race rejected');
  requireCondition(
    !runtime.trace.has('activate', 'enter'),
    'resource activated after shutdown won',
  );
}

async function forceAfterStalledClose(runtime: ScenarioRuntime): Promise<void> {
  await startSuccessfully(runtime);
  const controller = new AbortController();
  const shuttingDown = runtime.application.shutdown({
    gracePeriodMs: 60_000,
    forceTimeoutMs: 60_000,
    signal: controller.signal,
  });
  await runtime.trace.waitFor('close');
  controller.abort();
  const force = await phaseOrSettlement(runtime.trace, 'force', shuttingDown);
  if (force === 'phase') runtime.gates.resolve('force');
  const result = await shuttingDown;
  requireCondition(
    runtime.trace.count('close', 'enter') === 1,
    'close was not invoked exactly once',
  );
  requireCondition(
    runtime.trace.count('force', 'enter') === 1,
    'unfinished close did not invoke force',
  );
  requireCondition(result.outcome === 'forced', 'forced shutdown reported a clean outcome');
  requireCondition(result.reason === 'signal', 'forced shutdown lost its signal reason');
  runtime.gates.resolve('close');
}

export function expectedManagedResourceConformanceTrace(
  scenarioId: ManagedResourceConformanceScenarioId,
): readonly string[] {
  return EXPECTED_TRACE[scenarioId];
}

export async function executeManagedResourceConformanceScenario(
  scenario: ManagedResourceConformanceScenario,
  resource: Parameters<typeof observeManagedResource>[0],
  gates: ManagedResourceConformanceGates,
  trace: ManagedResourceConformanceTrace,
): Promise<void> {
  const application = createApplication({
    id: `conformance-${scenario.id}`,
    resources: [observeManagedResource(resource, scenario.required, trace)],
  });
  const runtime: ScenarioRuntime = { scenario, application, gates, trace };
  if (scenario.id === 'clean-shutdown') await cleanShutdown(runtime);
  else if (scenario.id === 'partial-start-rollback') await partialStartRollback(runtime);
  else if (scenario.id === 'readiness-rejection') await readinessRejection(runtime);
  else if (scenario.id === 'completion-before-ready') await completionBeforeReady(runtime);
  else if (
    scenario.id === 'required-late-completion' ||
    scenario.id === 'optional-late-completion'
  ) {
    await lateCompletion(runtime);
  } else if (scenario.id === 'activation-rejection') await activationRejection(runtime);
  else if (scenario.id === 'shutdown-during-startup') await shutdownDuringStartup(runtime);
  else await forceAfterStalledClose(runtime);
  requireTrace(runtime);
}
