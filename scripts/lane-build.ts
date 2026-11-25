/**
 * Who builds the packages a lane packs.
 *
 * A lane proves the tree it was started on, so it builds that tree itself. Inside one
 * `verify` run the sequential `build` step has already built it, and the lanes after it
 * must not build again side by side: `verify` says so through the environment of the lanes
 * it starts. A `dist` left by an earlier run says nothing about the tree in front of the
 * lane, so its presence is never the reason to skip a build.
 */
export const VERIFY_BUILT_ENV = 'STITCHKIT_VERIFY_BUILT';

/** Whether the `verify` run that started this lane already built the tree it stands on. */
export function builtByVerify(env: Record<string, string | undefined> = Bun.env): boolean {
  return env[VERIFY_BUILT_ENV] === '1';
}
