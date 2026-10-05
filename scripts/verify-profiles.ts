import { evidenceLanes } from './evidence-lanes';
import { readReleaseTrain } from './release-train';

/** Every portable CI lane remains available as a local diagnostic gate. */
export const VERIFY_STEPS: readonly string[] = [
  'lockfile',
  'lint',
  'check',
  'test',
  'test:postgres-stores',
  'build',
  'smoke:next-ssr',
  'smoke:node',
  'consumer-lane',
  'tui-packed-lane',
  'agent-template-lane',
  'telegram-bot-template-lane',
  'generated-templates-lane',
  'starter-lane',
  'supervised-lane',
];
export const FAST_STEPS: readonly string[] = ['lockfile', 'lint', 'check', 'test'];
/** Steps that run a subset of a fast step, so a green fast record for the tree covers them. */
export const FAST_SUBSET_STEPS: readonly string[] = ['test:release-metadata'];
export const VERIFY_GATE = 'verify';
export const FAST_GATE = 'verify:fast';
export const HEAD_STEPS: readonly string[] = ['starter-head-lane'];
export const HEAD_GATE = 'verify:head';
export const VERIFY_FLAGS: readonly string[] = [
  '--if-changed',
  '--fast',
  '--head',
  '--release',
  '--candidate',
];

export interface VerifyProfile {
  gate: string;
  steps: readonly string[];
}

export const PROFILES: Record<'full' | 'fast' | 'head' | 'candidate', VerifyProfile> = {
  full: { gate: VERIFY_GATE, steps: VERIFY_STEPS },
  // A release commit changes metadata only (ADR 0237); the code under it passed the fast gate on
  // its own push. What metadata can break is the tests that read it, so the candidate runs those.
  candidate: {
    gate: 'verify:candidate',
    steps: ['lockfile', 'lint', 'check', 'test:release-metadata'],
  },
  fast: { gate: FAST_GATE, steps: FAST_STEPS },
  head: { gate: HEAD_GATE, steps: HEAD_STEPS },
};

/** The local steps behind each CI evidence lane; real-Darwin work has none. */
const STARTER_MODE_STEPS = { target: 'starter-lane', head: 'starter-head-lane' };

export async function releaseProfile(root: string): Promise<VerifyProfile> {
  const train = await readReleaseTrain(root);
  const targets = train.releases.map((release) => release.target);
  const lanes = evidenceLanes(targets);
  const steps = [
    ...(lanes.portable
      ? ['test:postgres-stores', 'smoke:next-ssr', 'smoke:node', 'consumer-lane']
      : []),
    ...(lanes.tui ? ['tui-packed-lane'] : []),
    ...(lanes.starter
      ? ['agent-template-lane', 'telegram-bot-template-lane', 'generated-templates-lane']
      : []),
    ...lanes.starterModes.map((mode) => STARTER_MODE_STEPS[mode]),
    ...(lanes.supervised ? ['supervised-lane'] : []),
  ];
  return {
    gate: `verify:release:${targets.sort().join('+')}`,
    steps: [...FAST_STEPS, 'build', ...steps],
  };
}
