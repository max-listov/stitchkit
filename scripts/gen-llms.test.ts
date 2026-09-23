/**
 * The agent docs are sliced so a consumer's agent can load what it imports.
 *
 * `llms-full.txt` is ~900 KB — more than an agent's context — so the slices are
 * the only form an agent can actually read. These tests hold the three things
 * the slicing promises: no slice is over the limit, every published entrypoint
 * has one, and every guide page lands in exactly one.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertNoDuplicateBodies,
  assertSliceSizes,
  buildSlices,
  checkGuideMap,
  GUIDE_SLICES,
  packageExports,
  SLICE_LIMIT_BYTES,
  splitToFit,
} from './gen-llms';

const GUIDE_DIR = join(import.meta.dir, '../docs/guide');
const slices = buildSlices();

describe('agent docs slices', () => {
  test(`the largest slice is at most ${SLICE_LIMIT_BYTES} bytes`, () => {
    const largest = Math.max(...slices.map((slice) => slice.bytes));
    expect(largest).toBeLessThanOrEqual(SLICE_LIMIT_BYTES);
    for (const slice of slices) {
      expect(Buffer.byteLength(slice.content, 'utf8')).toBe(slice.bytes);
    }
    expect(() => assertSliceSizes(slices)).not.toThrow();
  });

  test('the size check refuses an oversized slice (mutation control)', () => {
    const bloated = { file: 'llms/bloated.txt', bytes: SLICE_LIMIT_BYTES + 1 };
    expect(() => assertSliceSizes([...slices, bloated])).toThrow('llms/bloated.txt');
    const edge = { file: 'llms/edge.txt', bytes: SLICE_LIMIT_BYTES };
    expect(() => assertSliceSizes([edge])).not.toThrow();
  });

  test('every export in packages/core/package.json has a slice', () => {
    const covered = new Set(slices.map((slice) => slice.entrypoint));
    const missing = packageExports().filter((subpath) => !covered.has(subpath));
    expect(missing).toEqual([]);
  });

  test('every guide page is mapped, and an unmapped one is refused', () => {
    const onDisk = readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'));
    expect(checkGuideMap(onDisk, GUIDE_SLICES, packageExports())).toEqual([]);
    // Mutation control: a new page nobody mapped, and a map to a missing export.
    expect(checkGuideMap([...onDisk, 'new-page.md'], GUIDE_SLICES, packageExports())).toEqual([
      'new-page.md lands in no slice (add it to GUIDE_SLICES)',
    ]);
    expect(
      checkGuideMap(
        ['cli.md'],
        { 'cli.md': { primary: './no-such-entry' } },
        packageExports(),
      ),
    ).toEqual(['cli.md → ./no-such-entry is not a package export']);
  });

  test('no guide or reference body lands in two slices', () => {
    expect(() => assertNoDuplicateBodies(slices)).not.toThrow();
    // Independent of the bookkeeping: the opening of every guide section is in one slice topic.
    for (const file of readdirSync(GUIDE_DIR).filter((f) => f.endsWith('.md'))) {
      const guide = readFileSync(join(GUIDE_DIR, file), 'utf8').trim();
      for (const section of guide.split(/^(?=## )/m)) {
        const opening = section.trim().slice(0, 200);
        const topics = new Set(
          slices.filter((s) => s.content.includes(opening)).map((s) => s.topic),
        );
        expect([file, opening.split('\n', 1)[0], topics.size]).toEqual([
          file,
          opening.split('\n', 1)[0],
          1,
        ]);
      }
    }
    // Mutation control: the same body filed under a second slice is refused.
    const [first] = slices.filter((s) => s.sources.length > 0);
    if (first === undefined) throw new Error('no slice carries a body');
    const copy = { ...first, file: 'llms/copy.txt', topic: 'stitchkit/copy' };
    expect(() => assertNoDuplicateBodies([...slices, copy])).toThrow('stitchkit/copy');
  });

  test('upgrading.md is split into version-range slices, each within the limit', () => {
    const upgrading = slices.filter((slice) => slice.file.startsWith('llms/upgrading'));
    expect(upgrading.some((slice) => slice.file === 'llms/upgrading.txt')).toBe(true);
    expect(
      upgrading.filter((slice) => /upgrading-\d/.test(slice.file)).length,
    ).toBeGreaterThan(1);
  });

  test('splitting keeps code fences whole and respects the limit', () => {
    const fence = ['```md', '# not a heading', '## not a heading either', '```'].join('\n');
    const doc = ['## A', 'x'.repeat(60), fence, '## B', 'y'.repeat(60)].join('\n');
    const pieces = splitToFit(doc, 120);
    expect(pieces.every((piece) => Buffer.byteLength(piece) <= 120)).toBe(true);
    expect(pieces.some((piece) => piece.includes(fence))).toBe(true);
  });
});
