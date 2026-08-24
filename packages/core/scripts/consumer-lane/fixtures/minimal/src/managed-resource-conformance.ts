import type { ManagedResource } from 'stitchkit/application';
import {
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
  runManagedResourceConformance,
} from 'stitchkit/testing';

function fixture(
  input: ManagedResourceConformanceFactoryInput,
): ManagedResourceConformanceFixture {
  const resource: ManagedResource = {
    id: 'packed-controlled-adapter',
    async start() {
      await input.controls.startup;
      return {
        ready: input.controls.readiness,
        completion: input.controls.completion,
      };
    },
    activate: () => input.controls.activation,
    stopAdmission: () => undefined,
    drain: () => undefined,
    close: () => input.controls.close,
    force: () => input.controls.force,
  };
  return { resource, dispose: () => undefined };
}

const explicitlyNamedScenario: ManagedResourceConformanceScenarioId = 'clean-shutdown';
void explicitlyNamedScenario;

function namePublicTypes(
  _controls: ManagedResourceConformanceControls,
  _phase: ManagedResourceConformancePhase,
  _scenario: ManagedResourceConformanceScenario,
  _trace: ManagedResourceConformanceTraceEntry,
  _outcome: ManagedResourceConformanceTraceOutcome,
  _error: ManagedResourceConformanceError,
): void {
  void [_controls, _phase, _scenario, _trace, _outcome, _error];
}
void namePublicTypes;
void [
  ManagedResourceConformanceError,
  ManagedResourceConformancePhaseSchema,
  ManagedResourceConformanceScenarioIdSchema,
  ManagedResourceConformanceScenarioSchema,
  ManagedResourceConformanceTraceEntrySchema,
  ManagedResourceConformanceTraceOutcomeSchema,
];

const config: ManagedResourceConformanceConfig = {
  createFixture: fixture,
  watchdogTimeoutMs: 500,
};
await runManagedResourceConformance(config);
console.log('managed resource conformance: ok');
