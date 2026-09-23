/**
 * The public surface on a budget.
 *
 * `public-surface.json` pins WHICH names each entrypoint exports, and it is
 * regenerated whenever the surface changes on purpose — so it records growth
 * without ever questioning it. From 592 names on 9 entrypoints (0.49) to over
 * 2 200 on 38 in five weeks is what that looks like. This budget is the other
 * half: a ceiling per entrypoint and a declared list of names two entrypoints
 * share, each with its reason. Exceeding a ceiling or sharing a new name is a
 * reviewed edit to `public-surface-budget.json`, never a side effect of
 * regenerating the snapshot. Names that looked like leaks and stay are listed
 * under `reviewed` with their reason. → ADR 0198.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const FIXTURES = `${import.meta.dir}/fixtures`;

const SurfaceSchema = z.record(z.string(), z.array(z.string()));
const BudgetSchema = z.object({
  limits: z.record(z.string(), z.number().int().nonnegative()),
  overlaps: z.array(
    z.object({
      entrypoints: z.tuple([z.string(), z.string()]),
      reason: z.string().min(10),
      names: z.array(z.string()).min(1),
    }),
  ),
  // Names that looked like leaks and were kept on purpose, each with why — the
  // record of a review, so the same question is not asked again from scratch.
  reviewed: z.array(
    z.object({
      entrypoint: z.string(),
      names: z.array(z.string()).min(1),
      reason: z.string().min(10),
    }),
  ),
});
type Surface = z.infer<typeof SurfaceSchema>;
type Budget = z.infer<typeof BudgetSchema>;

/** Every way the surface departs from its budget, as readable lines. */
export function budgetViolations(surface: Surface, budget: Budget): string[] {
  const violations: string[] = [];
  for (const [entry, names] of Object.entries(surface)) {
    const limit = budget.limits[entry];
    if (limit === undefined) violations.push(`${entry}: no limit declared`);
    else if (names.length > limit) {
      violations.push(`${entry}: ${names.length} exports over its limit of ${limit}`);
    }
  }
  const declared = new Map(
    budget.overlaps.map((overlap) => [
      [...overlap.entrypoints].sort().join(' ∩ '),
      new Set(overlap.names),
    ]),
  );
  const entries = Object.keys(surface).sort();
  for (const [index, left] of entries.entries()) {
    for (const right of entries.slice(index + 1)) {
      const key = `${left} ∩ ${right}`;
      const leftNames = new Set(surface[left]);
      const shared = (surface[right] ?? []).filter((name) => leftNames.has(name)).sort();
      const allowed = declared.get(key) ?? new Set<string>();
      const undeclared = shared.filter((name) => !allowed.has(name));
      if (undeclared.length > 0) {
        violations.push(`${key}: shares ${undeclared.join(', ')} without a declared reason`);
      }
      const stale = [...allowed].filter((name) => !shared.includes(name));
      if (stale.length > 0)
        violations.push(`${key}: declares ${stale.join(', ')} it no longer shares`);
    }
  }
  return violations;
}

const surface = SurfaceSchema.parse(
  JSON.parse(readFileSync(`${FIXTURES}/public-surface.json`, 'utf8')),
);
const budget = BudgetSchema.parse(
  JSON.parse(readFileSync(`${FIXTURES}/public-surface-budget.json`, 'utf8')),
);

describe('the public surface budget', () => {
  test('every entrypoint is within its ceiling and shares only declared names', () => {
    expect(budgetViolations(surface, budget)).toEqual([]);
  });

  test('a ceiling is not loose: it is the current count, so shrinking moves it too', () => {
    const loose = Object.entries(budget.limits)
      .filter(([entry, limit]) => limit !== (surface[entry]?.length ?? -1))
      .map(([entry, limit]) => `${entry}: limit ${limit}, exports ${surface[entry]?.length}`);
    expect(loose).toEqual([]);
  });

  test('a name kept after review is still exported where the review found it', () => {
    const gone = budget.reviewed.flatMap(({ entrypoint, names }) =>
      names
        .filter((name) => !(surface[entrypoint] ?? []).includes(name))
        .map((name) => `${entrypoint}: ${name}`),
    );
    expect(gone).toEqual([]);
  });

  test('an extra export and an undeclared shared name are both refused (negative control)', () => {
    const grown: Surface = {
      ...surface,
      'stitchkit/tools': [...(surface['stitchkit/tools'] ?? []), 'createCli'],
    };
    expect(budgetViolations(grown, budget)).toEqual([
      expect.stringMatching(/^stitchkit\/tools: \d+ exports over its limit of \d+$/),
      'stitchkit/cli ∩ stitchkit/tools: shares createCli without a declared reason',
    ]);
  });
});
