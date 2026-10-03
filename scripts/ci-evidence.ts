import { z } from 'zod';
import { type CiPlan, CiPlanSchema } from './ci-plan';

const NeedsSchema = z.record(
  z.string(),
  z.object({
    result: z.enum(['success', 'failure', 'cancelled', 'skipped']),
    outputs: z.record(z.string(), z.string()).optional(),
  }),
);
const PhaseSchema = z.enum(['assembly', 'result']);
export type CiEvidencePhase = z.infer<typeof PhaseSchema>;

/** Matrix jobs report their aggregate result in the same named needs contract. */
export function expectedCiEvidence(plan: CiPlan, phase: CiEvidencePhase) {
  const jobs: Record<string, boolean> = {
    plan: true,
    repository: true,
    portable: plan.portable,
    'portable-lanes': plan.portable,
    tui: plan.tui,
    'starter-package': plan.starter,
    'darwin-contained-files': plan.darwin,
    supervised: plan.supervised,
    starter: plan.starter,
  };
  if (phase === 'result') jobs.artifacts = plan.artifacts;
  return jobs;
}

/** No missing/unknown result is a proof; only deliberately unselected jobs may skip. */
export function assertCiEvidence(value: unknown, phase: CiEvidencePhase): void {
  const needs = NeedsSchema.parse(value);
  if (needs.plan?.result !== 'success') throw new Error('CI evidence plan did not succeed');
  const json = needs.plan.outputs?.json;
  if (json === undefined) throw new Error('CI evidence plan JSON is missing');
  const plan = CiPlanSchema.parse(JSON.parse(json));
  for (const [job, required] of Object.entries(expectedCiEvidence(plan, phase))) {
    const result = needs[job]?.result;
    if (result === 'success' || (!required && result === 'skipped')) continue;
    throw new Error(
      `CI evidence ${job}: ${required ? 'required success' : 'success or unselected skip'}, received ${result ?? 'missing'}`,
    );
  }
}

if (import.meta.main) {
  const input = Bun.env.CI_NEEDS;
  if (input === undefined) throw new Error('CI_NEEDS must contain the named needs context');
  assertCiEvidence(JSON.parse(input), PhaseSchema.parse(Bun.argv[2]));
  console.log('Every selected CI evidence job succeeded');
}
