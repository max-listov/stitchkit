import { describe, expect, test } from 'bun:test';
import { planUpgrade, renderUpgradePlan } from '../src/internal/upgrade-plan';

const changelog = `# Changelog

## [0.3.0] — 2026-01-03

### ⚠️ Breaking changes

**Who must act:** users of oldThing.

- Rename oldThing to newThing.

### Added

- New thing.

## [0.2.1] — 2026-01-02

### Fixed

- Safe fix.

## [0.2.0] — 2026-01-01

### ⚠️ Breaking changes

**Who must act:** anyone implementing Foo,
and anyone reading Bar.

- Foo gained a field.

## [0.1.0] — 2025-12-31
`;

describe('upgrade plan', () => {
  test('selects only crossed breaking releases and orders them ascending', () => {
    const plan = planUpgrade(changelog, '0.1.0', '0.3.0');
    expect(plan.map(({ version }) => version)).toEqual(['0.2.0', '0.3.0']);
    expect(plan[0]?.whoMustAct).toBe('anyone implementing Foo, and anyone reading Bar.');
  });

  test('excludes the installed version and additive releases', () => {
    expect(planUpgrade(changelog, '0.2.0', '0.2.1')).toEqual([]);
  });

  test('renders one executable range document', () => {
    const rendered = renderUpgradePlan(
      planUpgrade(changelog, '0.1.0', '0.2.0'),
      '0.1.0',
      '0.2.0',
    );
    expect(rendered).toContain('# Stitchkit upgrade 0.1.0 → 0.2.0');
    expect(rendered).toContain('Foo gained a field');
  });

  test('rejects backwards and malformed ranges', () => {
    expect(() => planUpgrade(changelog, '0.3.0', '0.2.0')).toThrow('must increase');
    expect(() => planUpgrade(changelog, 'latest', '0.3.0')).toThrow('exact semver');
  });

  test('plans two known ranges from the repository changelog', async () => {
    const real = await Bun.file(new URL('../../../CHANGELOG.md', import.meta.url)).text();
    expect(planUpgrade(real, '0.79.0', '0.80.1').map(({ version }) => version)).toEqual([
      '0.80.0',
    ]);
    const long = planUpgrade(real, '0.72.1', '0.80.1').map(({ version }) => version);
    expect(long[0]).toBe('0.73.0');
    expect(long.at(-1)).toBe('0.80.0');
    expect(
      planUpgrade(real, '0.52.0', '0.80.1').some(({ version }) => version === '0.62.0'),
    ).toBe(true);
  });
});
