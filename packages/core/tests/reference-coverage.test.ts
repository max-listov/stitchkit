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

const SRC = `${import.meta.dir}/../src`;
const REFERENCE = `${import.meta.dir}/../../../docs/api/reference.md`;

/** The public entrypoints, mapped to their source module. */
const ENTRYPOINTS: Record<string, string> = {
  stitchkit: 'index.ts',
  'stitchkit/contract': 'contract/index.ts',
  'stitchkit/server': 'server/index.ts',
  'stitchkit/tools': 'tools.ts',
  'stitchkit/react': 'react.ts',
  'stitchkit/node': 'node.ts',
  'stitchkit/cli': 'cli.ts',
  'stitchkit/observability': 'observability/index.ts',
};

/** Export names declared by an entry module — `export { … }` / `export type { … }`. */
function exportsOf(file: string): string[] {
  const txt = readFileSync(`${SRC}/${file}`, 'utf8');
  const names = new Set<string>();
  for (const match of txt.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) names.add(name);
    }
  }
  // `export * from './x'` re-exports — index.ts pulls all of contract this way.
  // Those names are covered by their own module's entry, so skip star lines.
  return [...names];
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

  for (const [entry, file] of Object.entries(ENTRYPOINTS)) {
    test(`every export of ${entry} is documented`, () => {
      const missing = exportsOf(file).filter((name) => !documented.has(name));
      expect(missing).toEqual([]);
    });
  }
});
