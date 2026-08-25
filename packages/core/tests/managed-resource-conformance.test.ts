import { describe, expect, test } from 'bun:test';
import type { ManagedResource } from '../src/application/resource';
import {
  ManagedResourceConformanceError,
  type ManagedResourceConformanceFactoryInput,
  type ManagedResourceConformanceFixture,
  runManagedResourceConformance,
} from '../src/testing';

function conformingFixture(
  input: ManagedResourceConformanceFactoryInput,
): ManagedResourceConformanceFixture {
  const resource: ManagedResource = {
    id: 'controlled-adapter',
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

async function expectScenarioFailure(
  scenario: ManagedResourceConformanceFactoryInput['scenario']['id'],
  createFixture: (
    input: ManagedResourceConformanceFactoryInput,
  ) => ManagedResourceConformanceFixture,
): Promise<ManagedResourceConformanceError> {
  try {
    await runManagedResourceConformance({
      createFixture,
      scenarios: [scenario],
      watchdogTimeoutMs: 100,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(ManagedResourceConformanceError);
    if (error instanceof ManagedResourceConformanceError) return error;
  }
  throw new Error(`scenario ${scenario} unexpectedly passed`);
}

describe('runManagedResourceConformance', () => {
  test('accepts a correctly wired adapter across the canonical scenario matrix', async () => {
    await runManagedResourceConformance({
      createFixture: conformingFixture,
      watchdogTimeoutMs: 500,
    });
  });

  test('identifies missing readiness wiring', async () => {
    const error = await expectScenarioFailure('readiness-rejection', (input) => {
      const fixture = conformingFixture(input);
      return {
        ...fixture,
        resource: {
          ...fixture.resource,
          async start(context) {
            await input.controls.startup;
            context.reportHealth('healthy');
            return { completion: input.controls.completion };
          },
        },
      };
    });
    expect(error.scenarioId).toBe('readiness-rejection');
  });

  test('identifies missing completion wiring', async () => {
    const error = await expectScenarioFailure('completion-before-ready', (input) => {
      const fixture = conformingFixture(input);
      return {
        ...fixture,
        resource: {
          ...fixture.resource,
          async start() {
            await input.controls.startup;
            return { ready: input.controls.readiness };
          },
        },
      };
    });
    expect(error.scenarioId).toBe('completion-before-ready');
  });

  test('identifies leaked partial startup cleanup', async () => {
    const error = await expectScenarioFailure('partial-start-rollback', (input) => {
      const fixture = conformingFixture(input);
      return { ...fixture, resource: { ...fixture.resource, close: undefined } };
    });
    expect(error.scenarioId).toBe('partial-start-rollback');
  });

  test('identifies missing forced cleanup after a stalled close', async () => {
    const error = await expectScenarioFailure('force-after-stalled-close', (input) => {
      const fixture = conformingFixture(input);
      return { ...fixture, resource: { ...fixture.resource, force: undefined } };
    });
    expect(error.scenarioId).toBe('force-after-stalled-close');
  });

  test('requires fixture disposal and reports its failure through the scenario', async () => {
    const error = await expectScenarioFailure('clean-shutdown', (input) => ({
      ...conformingFixture(input),
      dispose: () => {
        throw new Error('fixture disposal failed');
      },
    }));
    expect(error.message).toContain('fixture disposal failed');
    await expect(
      error.trace.some((entry) => entry.phase === 'dispose' && entry.outcome === 'reject'),
    ).toBe(true);
  });

  test('does not treat undefined scenario or disposal rejections as success', async () => {
    const scenarioError = await expectScenarioFailure('clean-shutdown', (input) => {
      const fixture = conformingFixture(input);
      return {
        ...fixture,
        resource: {
          ...fixture.resource,
          async start(): Promise<void> {
            throw undefined;
          },
        },
      };
    });
    expect(scenarioError.scenarioId).toBe('clean-shutdown');

    const disposalError = await expectScenarioFailure('clean-shutdown', (input) => ({
      ...conformingFixture(input),
      dispose: () => Promise.reject(undefined),
    }));
    expect(disposalError.trace.at(-1)).toMatchObject({ phase: 'dispose', outcome: 'reject' });
  });

  test('rejects an explicitly empty scenario selection', async () => {
    await expect(
      runManagedResourceConformance({
        createFixture: conformingFixture,
        scenarios: [],
      }),
    ).rejects.toThrow('scenarios must not be empty');
  });

  test('fails when fixture disposal leaves scenario execution live', async () => {
    const never = new Promise<void>(() => undefined);
    const error = await expectScenarioFailure('clean-shutdown', () => ({
      resource: {
        id: 'leaked-adapter',
        start: () => never,
      },
      dispose: () => undefined,
    }));
    expect(error.message).toContain('execution remained live after fixture disposal');
  });

  test('reports a post-dispose rejection as settled instead of live', async () => {
    const startup = Promise.withResolvers<void>();
    const error = await expectScenarioFailure('clean-shutdown', () => ({
      resource: {
        id: 'dispose-released-adapter',
        start: () => startup.promise,
      },
      dispose: () => startup.reject(new Error('startup released by disposal')),
    }));
    expect(error.message).toContain('startup released by disposal');
    expect(error.message).not.toContain('execution remained live after fixture disposal');
  });
});
