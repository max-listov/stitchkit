import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDirectInvocation, runUpgradeCli } from '../src/upgrade-cli';

const changelog = `# Changelog

## [0.3.0] — 2026-01-03

### ⚠️ Breaking changes

**Who must act:** users of oldThing.

- Rename oldThing to newThing.

## [0.2.0] — 2026-01-01

### Added

- A safe addition.

## [0.1.0] — 2025-12-31
`;

/** A project that depends on stitchkit, as the binary will find one. */
function consumer(installed: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'stitchkit-upgrade-cli-'));
  if (installed !== undefined) {
    const packageDirectory = join(dir, 'node_modules', 'stitchkit');
    mkdirSync(packageDirectory, { recursive: true });
    writeFileSync(
      join(packageDirectory, 'package.json'),
      JSON.stringify({ name: 'stitchkit', version: installed }),
    );
  }
  writeFileSync(join(dir, 'changelog.md'), changelog);
  return dir;
}

describe('stitchkit upgrade', () => {
  test('reads the installed version from the project it is run in', () => {
    const dir = consumer('0.1.0');
    const { output, code } = runUpgradeCli([
      'upgrade',
      '--cwd',
      dir,
      '--to',
      '0.3.0',
      '--changelog',
      join(dir, 'changelog.md'),
    ]);
    expect(code).toBe(0);
    expect(output).toContain('# Stitchkit upgrade 0.1.0 → 0.3.0');
    expect(output).toContain('Rename oldThing to newThing');
    // The additive release in the range is not a migration step.
    expect(output).not.toContain('## 0.2.0');
  });

  test('says there is nothing to do when the project is already on the target', () => {
    const dir = consumer('0.3.0');
    const { output, code } = runUpgradeCli(['upgrade', '--cwd', dir, '--to', '0.3.0']);
    expect(code).toBe(0);
    expect(output).toBe('Already on 0.3.0. Nothing to upgrade.\n');
  });

  test('names the missing install instead of guessing a baseline', () => {
    const dir = consumer(undefined);
    expect(() => runUpgradeCli(['upgrade', '--cwd', dir, '--to', '0.3.0'])).toThrow(
      /No stitchkit found in .*node_modules/,
    );
  });

  test('an option written without its value is an error, not an absence', () => {
    const dir = consumer('0.1.0');
    expect(() => runUpgradeCli(['upgrade', '--cwd', dir, '--from', '--to', '0.3.0'])).toThrow(
      '--from needs a value',
    );
  });

  test('a changelog the package did not ship is named, not silently empty', () => {
    const dir = consumer('0.1.0');
    expect(() =>
      runUpgradeCli([
        'upgrade',
        '--cwd',
        dir,
        '--to',
        '0.3.0',
        '--changelog',
        join(dir, 'absent.md'),
      ]),
    ).toThrow(/Cannot read the changelog at .*absent\.md/);
  });

  test('no arguments and an unknown command both end in the usage text', () => {
    expect(runUpgradeCli([])).toEqual({
      output: expect.stringContaining('bunx stitchkit@latest upgrade'),
      code: 0,
    });
    const unknown = runUpgradeCli(['plan']);
    expect(unknown.code).toBe(1);
    expect(unknown.output).toContain('Unknown command "plan"');
  });
});

describe('the binary runs when it is launched the way an install launches it', () => {
  /**
   * `node_modules/.bin/stitchkit` is a symlink and Node keeps it in `argv[1]`
   * while resolving the module URL to its target — so the program has to
   * recognise itself through the link, or it exits 0 having done nothing for
   * every consumer that installs it. Spawning it under Bun cannot show this:
   * Bun resolves `argv[1]` itself, so the broken comparison passes there.
   */
  test('recognises itself through the link an install creates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-upgrade-link-'));
    const target = join(dir, 'upgrade-cli.js');
    const link = join(dir, 'stitchkit');
    writeFileSync(target, '');
    symlinkSync(target, link);
    expect(isDirectInvocation(link, target)).toBe(true);
  });

  test('recognises itself when run in place, and refuses an unrelated path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stitchkit-upgrade-self-'));
    const target = join(dir, 'upgrade-cli.js');
    const other = join(dir, 'something-else.js');
    writeFileSync(target, '');
    writeFileSync(other, '');
    expect(isDirectInvocation(target, target)).toBe(true);
    expect(isDirectInvocation(other, target)).toBe(false);
    expect(isDirectInvocation(undefined, target)).toBe(false);
  });
});

describe('the package installs the binary and ships what it reads', () => {
  const manifest: { bin?: Record<string, string>; files?: string[] } = JSON.parse(
    readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8'),
  );

  test('bin installs `stitchkit` from the built entry', () => {
    expect(manifest.bin?.stitchkit).toBe('./dist/upgrade-cli.js');
  });

  test('the changelog the binary reads is inside the published file list', () => {
    expect(manifest.files).toContain('CHANGELOG.md');
  });
});
