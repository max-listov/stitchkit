import { z } from 'zod';
import { type ReleaseTarget, readReleaseTrain } from './release-train';

export const CiPlanSchema = z.object({
  schemaVersion: z.literal(1),
  targets: z.array(z.enum(['core', 'tui', 'create-stitchkit'])),
  portable: z.boolean(),
  tui: z.boolean(),
  starter: z.boolean(),
  supervised: z.boolean(),
  darwin: z.boolean(),
  artifacts: z.boolean(),
  starterModes: z.array(z.enum(['target', 'head'])),
});
export type CiPlan = z.infer<typeof CiPlanSchema>;

const GLOBAL_PATHS = [
  '.github/workflows/',
  '.githooks/',
  'bun.lock',
  'package.json',
  'scripts/',
  'release-train.json',
];

export function planCi(input: {
  event: 'push' | 'pull_request' | 'schedule' | 'workflow_dispatch';
  subject: string;
  changedPaths: readonly string[];
  releaseTargets?: readonly ReleaseTarget[];
}): CiPlan {
  const full = input.event === 'schedule' || input.event === 'workflow_dispatch';
  const train = /^release\(train\):/.test(input.subject.trim());
  const global = input.changedPaths.some((path) =>
    GLOBAL_PATHS.some((prefix) => path === prefix || path.startsWith(prefix)),
  );
  const targets = new Set<ReleaseTarget>();

  if (full || (!train && global)) {
    targets.add('core');
    targets.add('tui');
    targets.add('create-stitchkit');
  } else if (train) {
    for (const target of input.releaseTargets ?? []) targets.add(target);
  } else {
    if (input.changedPaths.some((path) => path.startsWith('packages/core/')))
      targets.add('core');
    if (input.changedPaths.some((path) => path.startsWith('packages/tui/')))
      targets.add('tui');
    if (input.changedPaths.some((path) => path.startsWith('packages/create-stitchkit/'))) {
      targets.add('create-stitchkit');
    }
  }

  const core = targets.has('core');
  const tui = targets.has('tui');
  const starterTarget = targets.has('create-stitchkit');
  const starterModes: Array<'target' | 'head'> = full
    ? ['target', 'head']
    : core
      ? ['head']
      : starterTarget
        ? ['target']
        : [];

  return CiPlanSchema.parse({
    schemaVersion: 1,
    targets: [...targets],
    portable: core || (!train && global) || full,
    tui,
    starter: starterModes.length > 0,
    supervised: core || starterTarget || full,
    darwin: core,
    artifacts: train,
    starterModes,
  });
}

async function gitOutput(args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
  return output.trim();
}

async function main(): Promise<void> {
  const event = z
    .enum(['push', 'pull_request', 'schedule', 'workflow_dispatch'])
    .parse(Bun.env.CI_EVENT);
  const head = Bun.env.CI_HEAD_SHA?.trim() || 'HEAD';
  const base = Bun.env.CI_BASE_SHA?.trim();
  const subject = await gitOutput(['log', '-1', '--format=%s', head]);
  let changedPaths: string[] = [];
  if (event !== 'schedule' && event !== 'workflow_dispatch') {
    const usableBase = base && !/^0+$/.test(base) ? base : `${head}^`;
    changedPaths = (await gitOutput(['diff', '--name-only', usableBase, head]))
      .split('\n')
      .filter(Boolean);
  }
  const releaseTargets = /^release\(train\):/.test(subject)
    ? (await readReleaseTrain(process.cwd())).releases.map((release) => release.target)
    : undefined;
  process.stdout.write(
    JSON.stringify(planCi({ event, subject, changedPaths, releaseTargets })),
  );
}

if (import.meta.main) await main();
