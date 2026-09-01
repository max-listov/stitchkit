/**
 * Guard: every tree in this repository resolves ONE `zod`, and says so when it
 * stops.
 *
 * Two separate things break when they disagree, and neither error names zod as
 * the cause:
 *
 * 1. **Types.** The Agent template depends on `stitchkit` through
 *    `file:../../../core`, and the MCP SDK depends on `zod` in its own right.
 *    Zod brands its types with its own version, so two minors are two
 *    incompatible type systems — a schema built by one is not assignable to a
 *    parameter typed by the other. What surfaces is
 *    `TS2589: Type instantiation is excessively deep` and a `_zod.version.minor`
 *    mismatch in a file nobody touched.
 * 2. **Committed shape snapshots.** A generated project fingerprints its own
 *    surface as `sha256(JSON.stringify(z.toJSONSchema(schema)))`, so the
 *    fingerprint is zod's output, not ours. 4.5 encodes a nullable as
 *    `type: ['string','null']` where 4.4 wrote `anyOf`, and every affected
 *    hash moves. The starter lane fails a full lane later, pointing at a
 *    conformance check rather than at a dependency.
 *
 * Both were live at once when the toolchain was moved "to latest" in one tree.
 * A comment cannot live in a `package.json`; this can.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockedResolutions } from './update-starter';

const root = join(import.meta.dir, '..');

/** Every tree that resolves zod, by the lockfile that decides it. */
const TREES: Record<string, string> = {
  repository: 'bun.lock',
  'application template': 'packages/create-stitchkit/template/bun.lock',
  'agent template': 'packages/create-stitchkit/templates/agent/bun.lock',
};

function resolvedZod(lockfile: string): string | undefined {
  return lockedResolutions(readFileSync(join(root, lockfile), 'utf8')).get('zod');
}

describe('one zod across the repository and both templates', () => {
  test('every tree resolves the same version', () => {
    const resolutions = Object.entries(TREES).map(
      ([name, lockfile]) => [name, resolvedZod(lockfile)] as const,
    );
    for (const [name, version] of resolutions) {
      expect(version, `${name} resolves no zod`).toBeDefined();
    }
    // Reported as the whole map rather than pairwise, so a failure names which
    // tree drifted instead of only that two numbers differ. Moving zod means
    // moving all three, and regenerating the committed surface snapshots.
    const expected = resolutions[0]?.[1];
    expect(expected).toBeDefined();
    expect(Object.fromEntries(resolutions)).toEqual(
      Object.fromEntries(resolutions.map(([name]) => [name, expected])),
    );
  });

  test('the Agent template pins exactly, because a range would drift alone', () => {
    // The other two carry carets and are held in line by their lockfiles. This
    // one is dev-linked to the framework source, so it is the tree where a
    // silent minor bump costs a typecheck no error message explains.
    const manifest: unknown = JSON.parse(
      readFileSync(
        join(root, 'packages/create-stitchkit/templates/agent/package.json'),
        'utf8',
      ),
    );
    const pin = (manifest as { dependencies: Record<string, string> }).dependencies.zod;
    expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pin).toBe(resolvedZod('bun.lock'));
  });
});
