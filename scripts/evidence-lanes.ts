import type { ReleaseTarget } from './release-train';

/**
 * Evidence is a projection of affected packages, independent of publication intent.
 * `starterHead` is the decision of `starterHeadDecision` (ADR 0099): `'skip'` drops the
 * packed local-HEAD starter lane for a core release that recorded a deferred review.
 */
export function evidenceLanes(
  targets: readonly ReleaseTarget[],
  starterHead: 'run' | 'skip' = 'run',
) {
  const core = targets.includes('core');
  const starter = targets.includes('create-stitchkit');
  const starterModes: Array<'target' | 'head'> = [];
  if (starter) starterModes.push('target');
  if (core && starterHead === 'run') starterModes.push('head');
  return {
    portable: core,
    tui: targets.includes('tui'),
    starter: core || starter,
    supervised: core || starter,
    darwin: core,
    starterModes,
  };
}
