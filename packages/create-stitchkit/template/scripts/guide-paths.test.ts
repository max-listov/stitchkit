import { describe, expect, test } from 'bun:test';
import { inspectGuide, inspectGuides } from './guide-paths';

const present = (path: string) => path === 'packages/shared/src/index.ts';

describe('guide paths', () => {
  test('reports a path the guide names but the scaffold lacks', () => {
    const findings = inspectGuide(
      'docs/G.md',
      'In `packages/frontend/src/lib/api/client.ts`, create the api.\n',
      present,
    );
    expect(findings).toEqual([
      { guide: 'docs/G.md', line: 1, path: 'packages/frontend/src/lib/api/client.ts' },
    ]);
  });

  test('a path the guide creates is declared, not broken', () => {
    const source = 'Create `packages/shared/src/realtime.ts` (created in this step) and…\n';
    expect(inspectGuide('docs/G.md', source, present)).toEqual([]);
  });

  test('an existing path is quiet, and prose without a path is quiet', () => {
    expect(
      inspectGuide('docs/G.md', 'Export it from `packages/shared/src/index.ts`.\n', present),
    ).toEqual([]);
    expect(inspectGuide('docs/G.md', 'Pages compose features.\n', present)).toEqual([]);
  });

  test('the real guide resolves every path it does not create', async () => {
    // The denominator matters: a guide the scanner cannot read would also return [].
    const findings = await inspectGuides(`${import.meta.dir}/..`);
    expect(findings).toEqual([]);
    const anyPath = inspectGuide('docs/G.md', 'See `packages/absent/x.ts`.\n', () => false);
    expect(anyPath).toHaveLength(1);
  });
});
