/**
 * Guard: every public export is documented in `docs/api/reference.md`.
 *
 * `reference.md` is the source `scripts/gen-llms.ts` turns into `llms.txt` /
 * `llms-full.txt` — the map a consumer's agent reads. An export missing from
 * the reference is invisible to that agent even though it ships. This scans the
 * real entrypoint modules for their export names and asserts each appears as a
 * backticked token somewhere in the reference, so the doc can never silently
 * fall behind the surface again.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import { z } from 'zod';
// @ts-expect-error — the manifest is plain ESM shared by the build and the gates.
import { ENTRYPOINTS as RAW_MANIFEST } from '../entrypoints.mjs';

interface ManifestEntry {
  readonly subpath: string;
  readonly source: string;
  readonly browser: boolean;
}
const MANIFEST = RAW_MANIFEST as readonly ManifestEntry[];

const SRC = `${import.meta.dir}/../src`;
const REFERENCE = `${import.meta.dir}/../../../docs/api/reference.md`;
const SURFACE_SNAPSHOT = `${import.meta.dir}/fixtures/public-surface.json`;

/**
 * The public entrypoints, mapped to their source module — from the manifest.
 *
 * This used to be a literal map maintained beside the build scripts, the
 * exports map, the guide table and the consumer-lane matrix. The tests below
 * already caught three of the ways those five could disagree; they could not
 * catch the sixth, which is the one that shipped: an entry promised browser-safe
 * by the guide and built on the server lane, where no gate looked at it.
 */
const ENTRYPOINTS: Record<string, string> = Object.fromEntries(
  MANIFEST.map((entry) => [
    entry.subpath === '.' ? 'stitchkit' : `stitchkit/${entry.subpath.slice(2)}`,
    entry.source.replace(/^src\//, ''),
  ]),
);

describe('the published entrypoint list is one list', () => {
  // Three drifts are possible and none of them fails a build: an export added
  // to package.json and nowhere else, an entrypoint missing from the map this
  // file walks, and a row in the guide that never got a maturity. Each one is
  // invisible to review and cheap to catch here.
  const packageJson: unknown = JSON.parse(readFileSync(join(SRC, '../package.json'), 'utf8'));
  const published = Object.keys((packageJson as { exports: Record<string, unknown> }).exports)
    .filter((key) => key.startsWith('.'))
    .map((key) => (key === '.' ? 'stitchkit' : `stitchkit/${key.slice(2)}`));

  test('every published export is covered by the reference walk', () => {
    expect(published.filter((entry) => !(entry in ENTRYPOINTS))).toEqual([]);
    expect(Object.keys(ENTRYPOINTS).filter((entry) => !published.includes(entry))).toEqual([]);
  });

  test('a browser-safe entry says so in the guide, and a server-only one does not', () => {
    const guide = readFileSync(join(SRC, '../../../docs/guide/getting-started.md'), 'utf8');
    const rows = new Map(
      [...guide.matchAll(/^\| `(stitchkit(?:\/[\w-]+)*)` \|([^|]*)\|/gm)].map((row) => [
        row[1] ?? '',
        row[2] ?? '',
      ]),
    );
    // The drift this exists for shipped: `stitchkit/remote` was sold here as
    // "browser and server, stable" while it was built on the server lane, so no
    // gate ever bundled it for a browser. The guide made a promise the build did
    // not keep, and nothing compared the two.
    const wrong = MANIFEST.filter((entry) => {
      const name = entry.subpath === '.' ? 'stitchkit' : `stitchkit/${entry.subpath.slice(2)}`;
      const cell = rows.get(name) ?? '';
      return entry.browser !== /browser/i.test(cell);
    }).map((entry) => entry.subpath);
    expect(wrong).toEqual([]);
  });

  test('a browser-safe entry is exercised on the browser target by the consumer lane', () => {
    const matrix = readFileSync(
      join(SRC, '../scripts/consumer-lane/optional-peer-matrix.mjs'),
      'utf8',
    );
    const targets = new Map<string, string[]>();
    for (const row of matrix.matchAll(/subpath: '([^']+)',[\s\S]*?target: '([^']+)'/g)) {
      targets.set(row[1] ?? '', [...(targets.get(row[1] ?? '') ?? []), row[2] ?? '']);
    }
    // At least one row, not every row: a subpath legitimately has several, and
    // an entry that works in a browser AND on a server should be exercised as
    // both. What must not happen is a browser promise with no browser row.
    const unexercised = MANIFEST.filter(
      (entry) => entry.browser && !(targets.get(entry.subpath) ?? []).includes('browser'),
    ).map((entry) => entry.subpath);
    expect(unexercised).toEqual([]);
  });

  test('every published export has a guide row that declares its maturity', () => {
    const guide = readFileSync(join(SRC, '../../../docs/guide/getting-started.md'), 'utf8');
    const rows = new Map(
      [...guide.matchAll(/^\| `(stitchkit(?:\/[\w-]+)*)` \|([^\n]*)$/gm)].map((row) => [
        row[1] ?? '',
        row[2] ?? '',
      ]),
    );
    expect(published.filter((entry) => !rows.has(entry))).toEqual([]);
    expect(
      published.filter((entry) => !/\b(stable|evolving)\b/.test(rows.get(entry) ?? '')),
    ).toEqual([]);
  });
});

const entryFiles = Object.values(ENTRYPOINTS).map((file) => join(SRC, file));
const program = ts.createProgram(entryFiles, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  skipLibCheck: true,
  noEmit: true,
});
const checker = program.getTypeChecker();

/** Every name reachable from an entrypoint, including transitive `export *` declarations. */
function exportsOf(file: string): string[] {
  const source = program.getSourceFile(join(SRC, file));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`cannot resolve public entrypoint ${file}`);
  return checker.getExportsOfModule(moduleSymbol).map((symbol) => symbol.getName());
}

/** Every backticked identifier in the reference — the "documented" set. */
function documentedNames(): Set<string> {
  const txt = readFileSync(REFERENCE, 'utf8');
  const names = new Set<string>();
  for (const match of txt.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)) {
    if (match[1]) names.add(match[1]);
  }
  return names;
}

describe('reference.md coverage', () => {
  const documented = documentedNames();
  const expectedSurface = z
    .record(z.string(), z.array(z.string()))
    .parse(JSON.parse(readFileSync(SURFACE_SNAPSHOT, 'utf8')));

  for (const [entry, file] of Object.entries(ENTRYPOINTS)) {
    test(`every export of ${entry} is documented`, () => {
      const missing = exportsOf(file).filter((name) => !documented.has(name));
      expect(missing).toEqual([]);
    });

    test(`public surface of ${entry} matches its exact snapshot`, () => {
      const expected = expectedSurface[entry];
      if (!expected) throw new Error(`missing public-surface snapshot for ${entry}`);
      expect(exportsOf(file).sort()).toEqual(expected);
    });
  }
});
