import { describe, expect, test } from 'bun:test';
import { comparePreOneVersions } from './release-notes';
import {
  assertFixedAffects,
  FIXED_AFFECTS_SINCE,
  validateReleaseTag,
} from './release-validate';

const ENTRYPOINTS = new Set(['stitchkit', 'stitchkit/process', 'stitchkit/server']);
const notes = (items: string) => `### Fixed\n\n${items}\n`;

describe('a fix to a public entrypoint names what it touches', () => {
  test('an item that leads with an entrypoint and carries a readable line passes', () => {
    expect(() =>
      assertFixedAffects(
        notes(
          '- `stitchkit/process`: a group stops.\n  **Affects:** `stitchkit/process` runNativeCommand\n- `stitchkit/server`: closing.\n  **Affects:** `stitchkit/server` behaviour',
        ),
        '0.110.7',
        ENTRYPOINTS,
      ),
    ).not.toThrow();
  });

  test('an item that leads with an entrypoint and has no line is refused, with the way to write one', () => {
    expect(() =>
      assertFixedAffects(
        notes('- `stitchkit/process`: a group stops.'),
        '0.110.7',
        ENTRYPOINTS,
      ),
    ).toThrow(
      /fixed item .* leads with `stitchkit\/process` and has no "\*\*Affects:\*\*" line/,
    );
  });

  test('an item that does not lead with an entrypoint needs no line, and may carry one', () => {
    expect(() =>
      assertFixedAffects(
        notes(
          '- CI waits for the registry.\n- A fast guard no longer overtakes.\n  **Affects:** `stitchkit/process` runNativeCommand',
        ),
        '0.110.7',
        ENTRYPOINTS,
      ),
    ).not.toThrow();
  });

  test('every Fixed heading of the release is judged, not only the first', () => {
    const second =
      '### Fixed\n\n- ok\n\n### Added\n\n- x\n\n### Fixed\n\n- `stitchkit/server`: closing.\n';
    expect(() => assertFixedAffects(second, '0.110.7', ENTRYPOINTS)).toThrow(
      /stitchkit\/server/,
    );
  });

  test('a star, an unpublished entrypoint and a malformed line are refused', () => {
    const item = (line: string) =>
      notes(`- \`stitchkit/process\`: a group stops.\n  **Affects:** ${line}`);
    expect(() =>
      assertFixedAffects(item('`stitchkit/process` *'), '0.110.7', ENTRYPOINTS),
    ).toThrow(/removes no entrypoint/);
    expect(() =>
      assertFixedAffects(item('`stitchkit/ghost` runNativeCommand'), '0.110.7', ENTRYPOINTS),
    ).toThrow(/`stitchkit\/ghost`.*does not export/);
    expect(() => assertFixedAffects(item('runNativeCommand'), '0.110.7', ENTRYPOINTS)).toThrow(
      /malformed/,
    );
  });

  test('the rule starts after 0.110.6', () => {
    expect(FIXED_AFFECTS_SINCE).toBe('0.110.7');
    expect(comparePreOneVersions('0.110.6', FIXED_AFFECTS_SINCE)).toBeLessThan(0);
    expect(comparePreOneVersions('0.110.7', FIXED_AFFECTS_SINCE)).toBe(0);
    expect(comparePreOneVersions('0.111.0', FIXED_AFFECTS_SINCE)).toBeGreaterThan(0);
  });
});

describe('the release gate applies the rule to a core release', () => {
  const WORKSPACES = ['packages/core', 'packages/tui', 'packages/create-stitchkit'];
  const tree = (changelogBody: string) => (relativePath: string) => {
    const files: Record<string, string> = {
      'packages/core/package.json': JSON.stringify({
        version: '9.9.0',
        exports: { '.': {}, './process': {} },
      }),
      'CHANGELOG.md': `## [9.9.0] - x\n\n${changelogBody}\n`,
      'docs/guide/upgrading.md': '# Upgrading\n',
      'bun.lock': WORKSPACES.map(
        (dir) =>
          `    "${dir}": {\n      "name": "x",\n      "version": "${dir === 'packages/core' ? '9.9.0' : '0.0.0'}",\n    },`,
      ).join('\n'),
    };
    for (const dir of WORKSPACES)
      files[`${dir}/package.json`] ??= JSON.stringify({ version: '0.0.0' });
    const contents = files[relativePath];
    return contents === undefined
      ? Promise.reject(new Error(`no ${relativePath} in this tree`))
      : Promise.resolve(contents);
  };
  const judge = (body: string) =>
    validateReleaseTag('/unused', 'v9.9.0', { read: tree(body), checkStarterLockfile: false });

  test('an unlabelled fix to an entrypoint refuses the tag; the labelled one passes', async () => {
    await expect(judge('### Fixed\n\n- `stitchkit/process`: a group stops.')).rejects.toThrow(
      /fixed item .* has no "\*\*Affects:\*\*" line/,
    );
    await expect(
      judge(
        '### Fixed\n\n- `stitchkit/process`: a group stops.\n  **Affects:** `stitchkit/process` runNativeCommand',
      ),
    ).resolves.toMatchObject({ version: '9.9.0' });
  });
});
