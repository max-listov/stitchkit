import { z } from 'zod';

/**
 * One step of a scripted engine: wait for the executor to write a record of
 * a type, write records or a raw line, wait, or die.
 */
export const FakeEngineStepSchema = z.discriminatedUnion('do', [
  z.strictObject({
    do: z.literal('expect'),
    type: z.string().min(1),
    subtype: z.string().optional(),
  }),
  z.strictObject({ do: z.literal('emit'), record: z.json() }),
  z.strictObject({ do: z.literal('emit-raw'), line: z.string() }),
  z.strictObject({ do: z.literal('delay'), ms: z.int().nonnegative().max(60_000) }),
  /** Die without a word, as a killed engine does. */
  z.strictObject({ do: z.literal('crash') }),
  z.strictObject({ do: z.literal('exit'), code: z.int().min(0).max(255) }),
]);
/** Single scripted fake-engine step inferred from `FakeEngineStepSchema`. */
export type FakeEngineStep = z.infer<typeof FakeEngineStepSchema>;

/** Ordered script of fake-engine steps and transcript recording flag for conformance tests. */
export const FakeEngineScenarioSchema = z.strictObject({
  steps: z.array(FakeEngineStepSchema),
  /** Record each input's `uuid` where the engine keeps its transcript, so a reconcile finds it. */
  keepTranscript: z.boolean().default(true),
});
/** Scripted fake-engine scenario input inferred from `FakeEngineScenarioSchema`. */
export type FakeEngineScenario = z.input<typeof FakeEngineScenarioSchema>;
