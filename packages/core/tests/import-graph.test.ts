/**
 * The module graph of `src/`, as declared directions between its parts.
 *
 * A part is a directory under `src/` (`contract`, `tools`, `agent-runtime`, …);
 * the root of `src/` holds nothing else. The package's public entries live in
 * `src/entrypoints/`, laid out exactly as their subpaths (`stitchkit/tools/contract`
 * is `entrypoints/tools/contract.ts`), and an entry only re-exports — its code
 * belongs to a part. Entries and the binaries listed in `entrypoints.mjs` may
 * import any part; nothing in a part imports an entry. Every other import that crosses
 * parts must be an edge declared below — so a new dependency direction is a
 * reviewed line in this file, not an accident of a convenient import.
 *
 * Two rules are stated separately because they are the architecture, not an
 * inventory:
 * - `agent-runtime` is a separate product behind a one-way boundary: it may
 *   import the core, and nothing in the core imports it. → ADR 0197.
 * - `internal` is the leaf: it imports no other part. → PRINCIPLES I8.
 */
import { describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
// @ts-expect-error — the manifest is plain ESM shared by the build and the gates.
import { BINARIES, ENTRYPOINTS } from '../entrypoints.mjs';

const SRC = resolve(import.meta.dir, '../src');

/** Declared directions. A part not listed imports no other part. */
export const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  internal: [],
  contract: ['internal'],
  'json-schema': ['internal'],
  durability: [],
  release: [],
  telegram: ['internal'],
  oauth: ['internal'],
  primitives: ['contract'],
  files: ['contract', 'internal'],
  observability: ['contract', 'internal', 'server', 'tools'],
  realtime: ['contract', 'internal', 'server'],
  browser: ['contract', 'internal', 'observability', 'realtime'],
  live: ['browser', 'contract', 'internal', 'realtime'],
  react: ['browser', 'contract', 'internal', 'realtime'],
  application: ['contract', 'internal', 'live', 'observability', 'server'],
  geo: ['application', 'internal'],
  tracking: ['browser', 'contract'],
  server: [
    'browser',
    'contract',
    'internal',
    'json-schema',
    'live',
    'observability',
    'realtime',
    'release',
  ],
  tools: [
    'browser',
    'contract',
    'durability',
    'files',
    'internal',
    'json-schema',
    'observability',
    'server',
  ],
  testing: [
    'application',
    'browser',
    'contract',
    'internal',
    'json-schema',
    'realtime',
    'server',
    'tools',
  ],
  'agent-runtime': ['contract', 'durability', 'internal', 'observability', 'server', 'tools'],
};

const entryFiles = new Set([
  ...(ENTRYPOINTS as readonly { source: string }[]).map((entry) =>
    resolve(SRC, '..', entry.source),
  ),
  ...(BINARIES as readonly { source: string }[]).map((binary) =>
    resolve(SRC, '..', binary.source),
  ),
]);

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield path;
  }
}

/** The part a source file belongs to, or null for an entrypoint. */
export function partOf(file: string): string | null {
  if (entryFiles.has(file)) return null;
  const [first] = relative(SRC, file).split('/');
  return (first ?? '').replace(/\.tsx?$/, '');
}

export interface Edge {
  from: string;
  to: string;
  file: string;
  specifier: string;
  /** `import type` / `export type` — erased at build, so it cannot form a runtime cycle. */
  typeOnly?: boolean;
}

/** Every relative import (static, `export … from`, dynamic) that crosses parts. */
export function crossingEdges(files: Iterable<string>): Edge[] {
  const edges: Edge[] = [];
  for (const file of files) {
    const from = partOf(file);
    if (from === null) continue;
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(
      /(^(?:import|export)\s+type\b[^;]*?\bfrom\s+|\bfrom\s+|\bimport\s*\(\s*|^import\s+)'(\.{1,2}\/[^']+)'/gm,
    )) {
      const specifier = match[2] ?? '';
      const typeOnly = /^(?:import|export)\s+type\b/.test(match[1] ?? '');
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(SRC)) continue;
      const [first] = relative(SRC, target).split('/');
      const to = (first ?? '').replace(/\.tsx?$/, '');
      if (to !== from) {
        edges.push({
          from,
          to,
          file: relative(SRC, file),
          specifier,
          ...(typeOnly && { typeOnly }),
        });
      }
    }
  }
  return edges;
}

/** Edges no declaration allows, with the rule each one breaks. */
export function undeclaredEdges(
  edges: readonly Edge[],
  allowed: Readonly<Record<string, readonly string[]>>,
): string[] {
  return edges
    .filter((edge) => !(allowed[edge.from] ?? []).includes(edge.to))
    .map((edge) => `${edge.file} → ${edge.specifier} (${edge.from} → ${edge.to})`);
}

/**
 * Groups of parts that reach each other through runtime imports (Tarjan's
 * strongly connected components, sizes above one). A type-only import is
 * erased, so it may point back; a runtime one may not.
 */
export function runtimeCycles(edges: readonly Edge[]): string[][] {
  const next = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.typeOnly) continue;
    const targets = next.get(edge.from) ?? new Set<string>();
    targets.add(edge.to);
    next.set(edge.from, targets);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];
  let counter = 0;
  const visit = (node: string): void => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0));
      }
    }
    if (low.get(node) !== index.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (member === undefined) break;
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1) cycles.push(component.sort());
  };
  for (const node of next.keys()) if (!index.has(node)) visit(node);
  return cycles;
}

/** Statements an entry may contain: re-exports only (a binary is a program and may not be pure). */
/** Files, not parts, at the root of a source tree — the root holds directories only. */
export function rootFiles(root: string): string[] {
  return readdirSync(root).filter((name) => !statSync(join(root, name)).isDirectory());
}

export function entryCode(text: string): string[] {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/export\s+(?:type\s+)?\{[^}]*\}\s*from\s*'[^']+';/g, '')
    .replace(/export\s+\*\s+(?:as\s+\w+\s+)?from\s*'[^']+';/g, '');
  return stripped
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

const edges = crossingEdges(sources(SRC));

describe('the module graph', () => {
  test('every crossing import is a declared direction', () => {
    expect(undeclaredEdges(edges, ALLOWED)).toEqual([]);
  });

  test('nothing in the core imports agent-runtime — only entrypoints do', () => {
    expect(edges.filter((edge) => edge.to === 'agent-runtime')).toEqual([]);
    const declared = Object.entries(ALLOWED).filter(([, targets]) =>
      targets.includes('agent-runtime'),
    );
    expect(declared).toEqual([]);
  });

  test('internal is the leaf', () => {
    expect(ALLOWED.internal).toEqual([]);
    expect(edges.filter((edge) => edge.from === 'internal')).toEqual([]);
  });

  test('no two parts depend on each other at runtime', () => {
    expect(runtimeCycles(edges)).toEqual([]);
  });

  test('a runtime cycle is found, a type-only one is not (negative control)', () => {
    const edge = (from: string, to: string, typeOnly?: boolean): Edge => ({
      from,
      to,
      file: `${from}/x.ts`,
      specifier: `../${to}/y`,
      ...(typeOnly && { typeOnly }),
    });
    expect(runtimeCycles([edge('a', 'b'), edge('b', 'c'), edge('c', 'a')])).toEqual([
      ['a', 'b', 'c'],
    ]);
    expect(runtimeCycles([edge('a', 'b'), edge('b', 'a', true)])).toEqual([]);
  });

  test('the root of src/ holds parts only', () => {
    expect(rootFiles(SRC)).toEqual([]);
  });

  test('a file at the root of src/ is found (negative control)', () => {
    const root = mkdtempSync(join(tmpdir(), 'import-graph-root-'));
    try {
      mkdirSync(join(root, 'contract'));
      writeFileSync(join(root, 'contract', 'define.ts'), '');
      expect(rootFiles(root)).toEqual([]);
      writeFileSync(join(root, 'stray.ts'), '');
      expect(rootFiles(root)).toEqual(['stray.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('src/entrypoints/ is the published list, laid out as the subpaths', () => {
    const declared = new Set(
      (ENTRYPOINTS as readonly { subpath: string; source: string }[]).map((entry) => {
        const expected = `src/entrypoints/${entry.subpath === '.' ? 'index' : entry.subpath.slice(2)}.ts`;
        expect(entry.source).toBe(expected);
        return resolve(SRC, '..', entry.source);
      }),
    );
    const present = [...sources(join(SRC, 'entrypoints'))].filter(
      (file) => !entryFiles.has(file),
    );
    expect(present.map((file) => relative(SRC, file))).toEqual([]);
    expect(declared.size).toBeGreaterThan(0);
  });

  test('an entry only re-exports', () => {
    const offenders = (ENTRYPOINTS as readonly { source: string }[])
      .map((entry) => resolve(SRC, '..', entry.source))
      .filter((file) => entryCode(readFileSync(file, 'utf8')).length > 0)
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual([]);
  });

  test('code in an entry is found (negative control)', () => {
    expect(entryCode("export { a } from './a';\nexport * from './b';")).toEqual([]);
    expect(entryCode("export { a } from './a';\nexport const b = 1;")).toEqual([
      'export const b = 1;',
    ]);
  });

  test('every declared direction is still used, so the list stays an inventory', () => {
    const used = new Set(edges.map((edge) => `${edge.from}→${edge.to}`));
    const stale = Object.entries(ALLOWED).flatMap(([from, targets]) =>
      targets.filter((to) => !used.has(`${from}→${to}`)).map((to) => `${from} → ${to}`),
    );
    expect(stale).toEqual([]);
  });

  test('the checker refuses an undeclared direction (negative control)', () => {
    const synthetic: Edge[] = [
      {
        from: 'tools',
        to: 'agent-runtime',
        file: 'tools/x.ts',
        specifier: '../agent-runtime/y',
      },
      { from: 'internal', to: 'tools', file: 'internal/x.ts', specifier: '../tools/y' },
    ];
    expect(undeclaredEdges(synthetic, ALLOWED)).toEqual([
      'tools/x.ts → ../agent-runtime/y (tools → agent-runtime)',
      'internal/x.ts → ../tools/y (internal → tools)',
    ]);
  });
});
