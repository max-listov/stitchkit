import { z } from 'zod';
import { runNativeCommand } from '../packages/core/src/process/command';

export const CiRunListSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    head_sha: z.string(),
    event: z.string(),
    conclusion: z.string().nullable(),
  }),
);
export type CiRunSummary = z.infer<typeof CiRunListSchema>[number];

/** The successful exact-SHA push run of the heavy CI — or a loud, specific refusal. */
export function selectSuccessfulCiRun(runs: readonly CiRunSummary[], sha: string): number {
  const matching = runs.filter((run) => run.head_sha === sha && run.event === 'push');
  const successful = matching.find((run) => run.conclusion === 'success');
  if (successful) return successful.id;
  if (matching.length === 0) {
    throw new Error(`no push CI run exists for exact SHA ${sha}`);
  }
  throw new Error(
    `no successful push CI run for exact SHA ${sha} — found: ${matching
      .map((run) => run.conclusion ?? 'pending')
      .join(', ')}`,
  );
}

/** Remote evidence is queried through the bounded native command owner. */
export async function askReleaseCi(root: string, sha: string): Promise<CiRunSummary[]> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('CI requires a full commit SHA');
  const result = await runNativeCommand({
    executable: 'gh',
    args: [
      'api',
      `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
      '--jq',
      '.workflow_runs',
    ],
    cwd: root,
    envPolicy: 'ambient',
    timeoutMs: 45_000,
    capture: true,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `GitHub CI query refused: ${new TextDecoder().decode(result.stderr).trim()}`,
    );
  return CiRunListSchema.parse(JSON.parse(new TextDecoder().decode(result.stdout)));
}

export async function requireSuccessfulReleaseCi(
  sha: string,
  ask: (sha: string) => Promise<readonly CiRunSummary[]>,
): Promise<number> {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('CI requires a full commit SHA');
  return selectSuccessfulCiRun(await ask(sha), sha);
}
