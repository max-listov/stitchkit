import type { ReleaseTarget } from './release-train';

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
