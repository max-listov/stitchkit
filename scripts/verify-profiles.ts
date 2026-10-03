import { type LaneInput, laneInputsForSteps } from './gate-lane-environment';
import { readReleaseTrain } from './release-train';

/** Every portable CI lane remains available as a local diagnostic gate. */
export const VERIFY_STEPS = [
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
] as const;
export const FAST_STEPS = ['lockfile', 'lint', 'check', 'test'] as const;
export const VERIFY_GATE = 'verify';
export const FAST_GATE = 'verify:fast';
export const HEAD_STEPS = ['starter-head-lane'] as const;
export const HEAD_GATE = 'verify:head';
export const VERIFY_FLAGS = [
  '--if-changed',
  '--fast',
  '--head',
  '--release',
  '--candidate',
] as const;

export interface VerifyProfile {
  gate: string;
  steps: readonly string[];
  requiredLaneInputs: readonly LaneInput[];
}

export const PROFILES: Record<'full' | 'fast' | 'head' | 'candidate', VerifyProfile> = {
  full: {
    gate: VERIFY_GATE,
    steps: VERIFY_STEPS,
    requiredLaneInputs: laneInputsForSteps(VERIFY_STEPS),
  },
  candidate: {
    gate: 'verify:candidate',
    steps: ['lockfile', 'lint', 'check'],
    requiredLaneInputs: [],
  },
  fast: { gate: FAST_GATE, steps: FAST_STEPS, requiredLaneInputs: [] },
  head: {
    gate: HEAD_GATE,
    steps: HEAD_STEPS,
    requiredLaneInputs: laneInputsForSteps(HEAD_STEPS),
  },
};

export async function releaseProfile(root: string): Promise<VerifyProfile> {
  const train = await readReleaseTrain(root);
  const targets = new Set(train.releases.map((release) => release.target));
  const lanes: string[] = [];
  if (targets.has('core'))
    lanes.push(
      'test:postgres-stores',
      'smoke:next-ssr',
      'smoke:node',
      'consumer-lane',
      'starter-head-lane',
      'supervised-lane',
    );
  if (targets.has('tui')) lanes.push('tui-packed-lane');
  if (targets.has('create-stitchkit'))
    lanes.push(
      'agent-template-lane',
      'telegram-bot-template-lane',
      'generated-templates-lane',
      'starter-lane',
      'supervised-lane',
    );
  return {
    gate: `verify:release:${train.releases
      .map((release) => release.target)
      .sort()
      .join('+')}`,
    steps: [...FAST_STEPS, 'build', ...new Set(lanes)],
    requiredLaneInputs: laneInputsForSteps(lanes),
  };
}
