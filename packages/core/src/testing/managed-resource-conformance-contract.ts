import { z } from 'zod';
import type { ManagedResource } from '../application/resource';

export const ManagedResourceConformanceScenarioIdSchema = z.enum([
  'clean-shutdown',
  'partial-start-rollback',
  'readiness-rejection',
  'completion-before-ready',
  'required-late-completion',
  'optional-late-completion',
  'activation-rejection',
  'shutdown-during-startup',
  'force-after-stalled-close',
]);
export type ManagedResourceConformanceScenarioId = z.infer<
  typeof ManagedResourceConformanceScenarioIdSchema
>;

export const ManagedResourceConformanceScenarioSchema = z.discriminatedUnion('id', [
  z.object({ id: z.literal('clean-shutdown'), required: z.literal(true) }).readonly(),
  z.object({ id: z.literal('partial-start-rollback'), required: z.literal(true) }).readonly(),
  z.object({ id: z.literal('readiness-rejection'), required: z.literal(true) }).readonly(),
  z.object({ id: z.literal('completion-before-ready'), required: z.literal(true) }).readonly(),
  z
    .object({ id: z.literal('required-late-completion'), required: z.literal(true) })
    .readonly(),
  z
    .object({ id: z.literal('optional-late-completion'), required: z.literal(false) })
    .readonly(),
  z.object({ id: z.literal('activation-rejection'), required: z.literal(true) }).readonly(),
  z.object({ id: z.literal('shutdown-during-startup'), required: z.literal(true) }).readonly(),
  z
    .object({ id: z.literal('force-after-stalled-close'), required: z.literal(true) })
    .readonly(),
]);
export type ManagedResourceConformanceScenario = z.infer<
  typeof ManagedResourceConformanceScenarioSchema
>;

export const ManagedResourceConformancePhaseSchema = z.enum([
  'start',
  'readiness',
  'completion',
  'activate',
  'stop-admission',
  'drain',
  'close',
  'force',
  'dispose',
]);
export type ManagedResourceConformancePhase = z.infer<
  typeof ManagedResourceConformancePhaseSchema
>;

export const ManagedResourceConformanceTraceOutcomeSchema = z.enum([
  'enter',
  'resolve',
  'reject',
]);
export type ManagedResourceConformanceTraceOutcome = z.infer<
  typeof ManagedResourceConformanceTraceOutcomeSchema
>;

export const ManagedResourceConformanceTraceEntrySchema = z
  .object({
    sequence: z.number().int().nonnegative(),
    phase: ManagedResourceConformancePhaseSchema,
    outcome: ManagedResourceConformanceTraceOutcomeSchema,
  })
  .strict()
  .readonly();
export type ManagedResourceConformanceTraceEntry = z.infer<
  typeof ManagedResourceConformanceTraceEntrySchema
>;

/** Provider-like promises controlled by the conformance runner, not by wall-clock sleeps. */
export interface ManagedResourceConformanceControls {
  readonly startup: Promise<void>;
  readonly readiness: Promise<void>;
  readonly completion: Promise<void>;
  readonly activation: Promise<void>;
  readonly close: Promise<void>;
  readonly force: Promise<void>;
}

export interface ManagedResourceConformanceFactoryInput {
  readonly scenario: ManagedResourceConformanceScenario;
  readonly controls: ManagedResourceConformanceControls;
}

export interface ManagedResourceConformanceFixture {
  readonly resource: ManagedResource;
  /** Release fixture-owned handles/listeners. Required and bounded by the harness watchdog. */
  dispose(): void | Promise<void>;
}

export interface ManagedResourceConformanceConfig {
  createFixture(
    input: ManagedResourceConformanceFactoryInput,
  ): ManagedResourceConformanceFixture | Promise<ManagedResourceConformanceFixture>;
  /** Defaults to every scenario. A subset is useful for capability-specific adapters. */
  scenarios?: readonly ManagedResourceConformanceScenarioId[];
  /** Emergency harness bound only; semantic ordering uses barriers and AbortSignal. */
  watchdogTimeoutMs?: number;
}

export class ManagedResourceConformanceError extends Error {
  readonly code = 'MANAGED_RESOURCE_CONFORMANCE_FAILED';

  constructor(
    readonly scenarioId: ManagedResourceConformanceScenarioId,
    readonly expected: readonly string[],
    readonly trace: readonly ManagedResourceConformanceTraceEntry[],
    detail: string,
  ) {
    const observed =
      trace.length === 0
        ? '(empty)'
        : trace.map((entry) => `${entry.phase}:${entry.outcome}`).join(' -> ');
    super(
      `[stitchkit] managed resource conformance "${scenarioId}" failed: ${detail}; ` +
        `expected ${expected.join(' -> ')}; observed ${observed}`,
    );
    this.name = 'ManagedResourceConformanceError';
  }
}
