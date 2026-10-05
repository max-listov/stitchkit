import { z } from 'zod';
import { evidenceLanes } from './evidence-lanes';
import { git } from './local-git';
import { askReleaseCi, type CiRunSummary } from './release-ci';
import { ciAlreadyAnsweredFor } from './release-prepush';
import { isReleaseCommitSubject } from './release-subject';
import { type ReleaseTarget, ReleaseTargetSchema } from './release-train';

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
  .check((context) => {
    const plan = context.value;
    if (new Set(plan.targets).size !== plan.targets.length) {
      context.issues.push({
        code: 'custom',
        input: context.value,
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
        context.issues.push({
          code: 'custom',
          input: context.value,
          path: [field],
          message: `${field} contradicts evidence targets`,
        });
      }
    }
  });
export type CiPlan = z.infer<typeof CiPlanSchema>;

/** A change under any of these selects every package: they feed all lanes. */
const GLOBAL_PATHS = [
  '.github/workflows/',
  '.githooks/',
  'bun.lock',
  'package.json',
  'scripts/',
];

const EventSchema = z.enum(['push', 'pull_request', 'schedule', 'workflow_dispatch']);
type CiEvent = z.infer<typeof EventSchema>;

/**
 * The evidence for one commit. A release commit, a scheduled run and a manual
 * run select every package; only an ordinary push or pull request narrows by
 * the paths it changed.
 */
export function planCi(input: {
  event: CiEvent;
  subject: string;
  changedPaths: readonly string[];
}): CiPlan {
  const release = isReleaseCommitSubject(input.subject);
  const targets = new Set<ReleaseTarget>();
  const global = input.changedPaths.some((path) =>
    GLOBAL_PATHS.some(
      (prefix) => path === prefix || (prefix.endsWith('/') && path.startsWith(prefix)),
    ),
  );
  if (release || global || input.event === 'schedule' || input.event === 'workflow_dispatch') {
    targets.add('core');
    targets.add('tui');
    targets.add('create-stitchkit');
  } else {
    if (input.changedPaths.some((path) => path.startsWith('packages/core/')))
      targets.add('core');
    if (input.changedPaths.some((path) => path.startsWith('packages/tui/')))
      targets.add('tui');
    if (input.changedPaths.some((path) => path.startsWith('packages/create-stitchkit/')))
      targets.add('create-stitchkit');
  }
  return CiPlanSchema.parse({
    schemaVersion: 1,
    targets: [...targets],
    ...evidenceLanes([...targets]),
    artifacts: release,
  });
}

/** The plan of a push whose SHA already has a successful push run: nothing is selected. */
export function answeredPlan(): CiPlan {
  return CiPlanSchema.parse({
    schemaVersion: 1,
    targets: [],
    ...evidenceLanes([]),
    artifacts: false,
  });
}

const gitOutput = (args: string[]) => git(process.cwd(), args);

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

/**
 * Evidence is per SHA: when a push run for `head` already succeeded, a second
 * push of the same SHA (the master fast-forward of a release branch) selects
 * nothing. A failed or unreachable lookup selects by the ordinary rules.
 */
export async function planPush(
  input: {
    event: CiEvent;
    head: string;
    subject: () => Promise<string>;
    paths: () => Promise<string[]>;
  },
  ask: (sha: string) => Promise<readonly CiRunSummary[]> = (sha) =>
    askReleaseCi(process.cwd(), sha),
  report: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
): Promise<CiPlan> {
  if (input.event === 'push' && /^[0-9a-f]{40}$/.test(input.head)) {
    const answered = await ciAlreadyAnsweredFor([input.head], ask);
    if (answered.green) {
      report(`[plan] ${answered.because}; selecting no evidence`);
      return answeredPlan();
    }
    report(`[plan] ${answered.because}; planning from the change`);
  }
  const wide = input.event === 'schedule' || input.event === 'workflow_dispatch';
  return planCi({
    event: input.event,
    subject: await input.subject(),
    changedPaths: wide ? [] : await input.paths(),
  });
}

if (import.meta.main) {
  const event = EventSchema.parse(Bun.env.CI_EVENT);
  const head = Bun.env.CI_HEAD_SHA?.trim() || 'HEAD';
  const base = Bun.env.CI_BASE_SHA?.trim();
  const plan = await planPush({
    event,
    head,
    subject: async () => (await gitOutput(['log', '-1', '--format=%s', head])).trim(),
    paths: () => changedCiPaths(head, base),
  });
  process.stdout.write(JSON.stringify(plan));
}
