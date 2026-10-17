import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpgradeCli } from '../src/entrypoints/bin/upgrade-cli';
import { parseAffectsLine } from '../src/internal/upgrade-affects';
import { planFixes, planUpgrade } from '../src/internal/upgrade-plan';

const CHANGELOG = `# Changelog

## [0.4.0] - 2026-02-01

### Fixed

- \`stitchkit/process\`: stopping a group no longer blocks.
  **Affects:** \`stitchkit/process\` runNativeCommand
- \`stitchkit/files\`: a read keeps the lock longer.
  **Affects:** \`stitchkit/files\` readManagedFile
- \`stitchkit/server\`: the event loop is kept free while closing.
  **Affects:** \`stitchkit/server\` behaviour
- CI waits for the registry.

### Fixed

- \`stitchkit/cli\` — an empty argument is kept.

## [0.3.1] - 2026-01-20

### Added

- \`stitchkit/live\` — a new thing.

## [0.3.0] - 2026-01-10

### Fixed

- \`stitchkit/process\`: an older fix.
  **Affects:** \`stitchkit/process\` runNativeCommand
`;

describe('the fixes of an upgrade range', () => {
  test('the fixes that name what they touch are listed oldest first, the others only counted', () => {
    const fixes = planFixes(CHANGELOG, '0.3.0', '0.4.0');
    expect(fixes.declared.map((item) => item.title.slice(0, 20))).toEqual([
      'stopping a group no ',
      'a read keeps the loc',
      'the event loop is ke',
    ]);
    // The unlabelled CI item and the item of the second `### Fixed` heading.
    expect(fixes.withoutAffects).toBe(2);
    expect(fixes.declared[0]?.version).toBe('0.4.0');
    expect(fixes.declared[0]?.affects).toEqual(
      parseAffectsLine('`stitchkit/process` runNativeCommand'),
    );
  });

  test('a release without a breaking section still gives its fixes, and the plan is unchanged', () => {
    expect(planUpgrade(CHANGELOG, '0.3.0', '0.4.0')).toEqual([]);
    expect(planFixes(CHANGELOG, '0.3.1', '0.4.0').declared).toHaveLength(3);
    expect(planFixes(CHANGELOG, '0.4.0', '0.4.0'.replace('0.4.0', '0.4.1')).declared).toEqual(
      [],
    );
  });

  test('a heading written inside a fenced block does not end the Fixed section', () => {
    const fenced = [
      '## [0.5.0] - 2026-03-01',
      '',
      '### Fixed',
      '',
      '- `stitchkit/process`: a fix that quotes a changelog.',
      '  ```md',
      '  ### Added',
      '  ```',
      '  **Affects:** `stitchkit/process` runNativeCommand',
      '- `stitchkit/files`: a second fix after the fence.',
      '  **Affects:** `stitchkit/files` readManagedFile',
      '',
      '## [0.4.0] - 2026-02-01',
      '',
    ].join('\n');
    const fixes = planFixes(fenced, '0.4.0', '0.5.0');
    expect(fixes.declared.map((item) => item.entrypoints)).toEqual([
      ['stitchkit/process'],
      ['stitchkit/files'],
    ]);
  });

  test('the range must run forward, like the breaking plan', () => {
    expect(() => planFixes(CHANGELOG, '0.4.0', '0.3.0')).toThrow(/must increase/);
  });
});

describe('stitchkit upgrade prints the fixes against the project imports', () => {
  function project(source: string): { cwd: string; changelog: string; done: () => void } {
    const cwd = mkdtempSync(join(tmpdir(), 'upgrade-fixes-'));
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'app.ts'), source);
    const changelog = join(cwd, 'CHANGELOG.md');
    writeFileSync(changelog, CHANGELOG);
    return { cwd, changelog, done: () => rmSync(cwd, { recursive: true, force: true }) };
  }
  const run = (cwd: string, changelog: string, extra: string[] = []) =>
    runUpgradeCli([
      'upgrade',
      '--from',
      '0.3.0',
      '--to',
      '0.4.0',
      '--cwd',
      cwd,
      '--changelog',
      changelog,
      ...extra,
    ]);

  test('one fix affects the project, one is not used, one is behavioural', () => {
    const { cwd, changelog, done } = project(
      [
        "import { runNativeCommand } from 'stitchkit/process';",
        "import { createServer } from 'stitchkit/server';",
        '',
      ].join('\n'),
    );
    try {
      const { output, code } = run(cwd, changelog);
      expect(code).toBe(0);
      const fixes = output.slice(output.indexOf('## Fixes that touch this project'));
      expect(fixes).toContain('stopping a group no longer blocks: **affects this project**');
      expect(fixes).toContain('src/app.ts:1 `runNativeCommand`');
      expect(fixes).toContain('a read keeps the lock longer: **not used here**');
      expect(fixes).toContain('closing: **behavioural — check by hand**');
      expect(fixes).toContain('  - src/app.ts');
      expect(fixes).toContain('2 more fixes in this range carry no machine line');
    } finally {
      done();
    }
  });

  test('--json carries the fixes next to the breaking items', () => {
    const { cwd, changelog, done } = project(
      "import { runNativeCommand } from 'stitchkit/process';\n",
    );
    try {
      const document: unknown = JSON.parse(run(cwd, changelog, ['--json']).output);
      expect(document).toMatchObject({
        items: [],
        fixesWithoutAffects: 2,
        fixes: [
          { version: '0.4.0', verdict: 'affects', uses: [{ name: 'runNativeCommand' }] },
          { verdict: 'not-used' },
          { verdict: 'not-used' },
        ],
      });
    } finally {
      done();
    }
  });

  test('a range with no fixes prints no section, and the same version still answers with fixes: []', () => {
    const { cwd, changelog, done } = project('export {};\n');
    try {
      const output = runUpgradeCli([
        'upgrade',
        '--from',
        '0.3.0',
        '--to',
        '0.3.1',
        '--cwd',
        cwd,
        '--changelog',
        changelog,
      ]).output;
      expect(output).not.toContain('Fixes that touch');
      const same = runUpgradeCli(['upgrade', '--from', '0.4.0', '--to', '0.4.0', '--json']);
      expect(JSON.parse(same.output)).toMatchObject({
        items: [],
        fixes: [],
        fixesWithoutAffects: 0,
      });
    } finally {
      done();
    }
  });
});

describe('the released changelog', () => {
  const changelog = readFileSync(join(import.meta.dir, '../../../CHANGELOG.md'), 'utf8');

  test('every machine line of every Fixed item reads, so no consumer range can crash on one', () => {
    const fixes = planFixes(changelog, '0.1.0', '99.0.0');
    expect(fixes.declared.length).toBeGreaterThanOrEqual(5);
  });

  test('the process fixes between 0.108.1 and 0.110.6 name runNativeCommand', () => {
    const named = planFixes(changelog, '0.108.1', '0.110.6').declared.filter((item) =>
      item.affects?.some(
        (target) =>
          target.kind === 'symbols' &&
          target.entrypoint === 'stitchkit/process' &&
          target.symbols.some((symbol) => symbol.name === 'runNativeCommand'),
      ),
    );
    expect(named.map((item) => item.version)).toEqual([
      '0.109.4',
      '0.110.0',
      '0.110.1',
      '0.110.6',
      '0.110.6',
    ]);
  });
});
