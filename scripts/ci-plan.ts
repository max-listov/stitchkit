import { z } from 'zod';
import { isReleaseCommitSubject, releaseScopeForSubject } from './release-plan';
import { type ReleaseTarget, ReleaseTargetSchema, readReleaseTrain } from './release-train';

/** Evidence is a projection of affected packages, independent of publication intent. */
export function evidenceLanes(targets: readonly ReleaseTarget[]) {
  const core = targets.includes('core');
  const starter = targets.includes('create-stitchkit');
  const starterModes: Array<'target' | 'head'> = [];
  if (starter) starterModes.push('target');
  if (core) starterModes.push('head');
  return {
    portable: core,
    tui: targets.includes('tui'),
    starter: core || starter,
    supervised: core || starter,
    darwin: core,
    starterModes,
  };
}

export const CiPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    targets: z.array(ReleaseTargetSchema),
    portable: z.boolean(),
    tui: z.boolean(),
    starter: z.boolean(),
    supervised: z.boolean(),
    darwin: z.boolean(),
    artifacts: z.boolean(),
    starterModes: z.array(z.enum(['target', 'head'])),
  })
  .strict()
  .superRefine((plan, context) => {
    if (new Set(plan.targets).size !== plan.targets.length) {
      context.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'duplicate evidence target',
      });
    }
    const expected = evidenceLanes(plan.targets);
    const fields: Array<keyof typeof expected> = [
      'portable',
      'tui',
      'starter',
      'supervised',
      'darwin',
      'starterModes',
    ];
    for (const field of fields) {
      if (JSON.stringify(plan[field]) !== JSON.stringify(expected[field])) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `${field} contradicts evidence targets`,
        });
      }
    }
  });
export type CiPlan = z.infer<typeof CiPlanSchema>;

const GLOBAL_PATHS = [
  '.github/workflows/',
  '.githooks/',
  'bun.lock',
  'package.json',
  'scripts/',
];

export function planCi(input: {
  event: 'push' | 'pull_request' | 'schedule' | 'workflow_dispatch';
  subject: string;
  changedPaths: readonly string[];
  releaseTargets?: readonly ReleaseTarget[];
}): CiPlan {
  const full = input.event === 'schedule' || input.event === 'workflow_dispatch';
  const release = isReleaseCommitSubject(input.subject);
  const scope = release ? releaseScopeForSubject(input.subject) : undefined;
  const global = input.changedPaths.some((path) =>
    GLOBAL_PATHS.some(
      (prefix) => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)),
    ),
  );
  const targets = new Set<ReleaseTarget>();

  if (full || global) {
    targets.add('core');
    targets.add('tui');
    targets.add('create-stitchkit');
  } else {
    if (scope === 'train') {
      for (const target of input.releaseTargets ?? []) targets.add(target);
    } else if (scope !== undefined) {
      targets.add(scope === 'starter' ? 'create-stitchkit' : scope);
    }
    if (input.changedPaths.some((path) => path.startsWith('packages/core/')))
      targets.add('core');
    if (input.changedPaths.some((path) => path.startsWith('packages/tui/')))
      targets.add('tui');
    if (input.changedPaths.some((path) => path.startsWith('packages/create-stitchkit/'))) {
      targets.add('create-stitchkit');
    }
  }

  return CiPlanSchema.parse({
    schemaVersion: 1,
    targets: [...targets],
    ...evidenceLanes([...targets]),
    artifacts: release,
  });
}

async function gitOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return output;
}

/** A new branch has no before SHA; its whole tree is conservative evidence. */
export async function changedCiPaths(
  head: string,
  base: string | undefined,
  read: (args: string[]) => Promise<string> = gitOutput,
): Promise<string[]> {
  const command =
    base && !/^0+$/.test(base)
      ? ['diff', '--no-renames', '--name-only', '-z', base, head]
      : ['ls-tree', '-r', '--name-only', '-z', head];
  return (await read(command)).split('\0').filter(Boolean);
}

async function main(): Promise<void> {
  const event = z
    .enum(['push', 'pull_request', 'schedule', 'workflow_dispatch'])
    .parse(Bun.env.CI_EVENT);
  const head = Bun.env.CI_HEAD_SHA?.trim() || 'HEAD';
  const base = Bun.env.CI_BASE_SHA?.trim();
  const subject = (await gitOutput(['log', '-1', '--format=%s', head])).trim();
  let changedPaths: string[] = [];
  if (event !== 'schedule' && event !== 'workflow_dispatch') {
    changedPaths = await changedCiPaths(head, base);
  }
  const releaseTargets =
    isReleaseCommitSubject(subject) && releaseScopeForSubject(subject) === 'train'
      ? (await readReleaseTrain(process.cwd())).releases.map((release) => release.target)
      : undefined;
  process.stdout.write(
    JSON.stringify(planCi({ event, subject, changedPaths, releaseTargets })),
  );
}

if (import.meta.main) await main();
