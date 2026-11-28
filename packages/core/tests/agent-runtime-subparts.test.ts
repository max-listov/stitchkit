/**
 * The module graph inside `agent-runtime`, as declared directions between its
 * sub-parts.
 *
 * `import-graph.test.ts` holds the parts of `src/`; inside the agent runtime
 * a file's sub-part is the first word of its name, with synonyms joined
 * (`children` is `child`, `sqlite` is `store`), and every sub-part is named
 * below, so a file with an unknown prefix is refused rather than becoming a
 * sub-part of one. Only runtime imports count: a type-only import is erased.
 * A direction is a reviewed line here; the four mutual links that remain are
 * file-level exceptions with their reason, and an exception nobody uses any
 * more is refused, so the list only shrinks.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { type Edge, runtimeCycles, undeclaredEdges } from './import-graph.test';

const ROOT = resolve(import.meta.dir, '../src/agent-runtime');

const SYNONYMS: Readonly<Record<string, string>> = {
  children: 'child',
  schedules: 'schedule',
  invocations: 'invocation',
  events: 'event',
  runtime: 'run',
  terminal: 'run',
  state: 'run',
  history: 'run',
  purge: 'store',
  sqlite: 'store',
  sql: 'store',
  postgres: 'store',
  companion: 'store',
};

export const SUBPARTS: readonly string[] = [
  'admission',
  'agent',
  'ai',
  'anthropic',
  'archive',
  'branch',
  'browser',
  'child',
  'coding',
  'compaction',
  'contained',
  'context',
  'control',
  'conversations',
  'coordinator',
  'deferred',
  'event',
  'fault',
  'harness',
  'injection',
  'invocation',
  'managed',
  'models',
  'observability',
  'openai',
  'openrouter',
  'owned',
  'projections',
  'prompt',
  'protocol',
  'provider',
  'react',
  'retry',
  'run',
  'sandbox',
  'schedule',
  'schemas',
  'spill',
  'store',
  'testing',
  'workspace',
];

/** Declared runtime directions. A sub-part not listed imports no other sub-part. */
export const SUBPART_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  ai: ['run'],
  anthropic: ['provider'],
  archive: ['coding'],
  branch: [
    'archive',
    'child',
    'coding',
    'deferred',
    'event',
    'invocation',
    'provider',
    'sandbox',
    'schemas',
    'store',
  ],
  browser: ['control', 'schemas'],
  child: ['agent', 'context', 'run', 'store'],
  coding: ['contained', 'sandbox', 'workspace'],
  compaction: ['run'],
  control: ['event', 'schemas'],
  conversations: ['schemas'],
  deferred: ['context'],
  event: ['agent', 'context', 'schemas', 'store'],
  harness: ['browser', 'contained', 'control', 'event', 'models', 'prompt', 'run'],
  invocation: ['owned', 'provider', 'schemas'],
  observability: ['models', 'run', 'schemas'],
  openai: ['provider'],
  openrouter: ['models', 'provider'],
  projections: ['invocation', 'run', 'schemas', 'store'],
  prompt: ['run', 'schemas'],
  protocol: ['schemas'],
  provider: ['schemas'],
  run: [
    'admission',
    'agent',
    'context',
    'coordinator',
    'deferred',
    'event',
    'injection',
    'invocation',
    'managed',
    'models',
    'owned',
    'provider',
    'retry',
    'schemas',
    'store',
  ],
  schedule: ['agent', 'context', 'store'],
  spill: ['coding', 'store'],
  store: ['archive', 'conversations', 'schemas'],
};

// Branching is an operation of the store (`AgentRuntimeStore.branchConversation`,
// and the archive import replays the same events), built on the branch modules,
// which in turn read the store: the link is the contract, not a leftover. Making
// the branch modules part of the store would add store → coding, invocation and
// event, and event already depends on the store.
const BRANCH_IS_A_STORE_OPERATION =
  'the store offers branching and archive import, both built on the branch modules that read the store';

/** The back edge of each remaining mutual link, file by file, with why it stays. */
export const SUBPART_EXCEPTIONS: readonly {
  file: string;
  specifier: string;
  reason: string;
}[] = [
  {
    file: 'store-archive.ts',
    specifier: './branch-replay',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-branch.ts',
    specifier: './branch-contract',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-branch.ts',
    specifier: './branch-events',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-branch.ts',
    specifier: './branch-identities',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-branch.ts',
    specifier: './branch-refusal',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-branch.ts',
    specifier: './branch-replay',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-branch.ts',
    specifier: './branch-source',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-conformance-branch.ts',
    specifier: './branch-refusal',
    reason: BRANCH_IS_A_STORE_OPERATION,
  },
  {
    file: 'store-reduce-terminal.ts',
    specifier: './terminal-status',
    reason:
      'the reducer and the run classify a terminal the same way; moved into the store, the classifier would import the run history it reads',
  },
];

/** The sub-part of a file under `agent-runtime/`, or `undefined` for an unknown prefix. */
export function subpartOf(path: string): string | undefined {
  const [first] = path.split('/');
  const word = (first ?? '').replace(/\.tsx?$/, '').split('-')[0] ?? '';
  const subpart = SYNONYMS[word] ?? word;
  return SUBPARTS.includes(subpart) ? subpart : undefined;
}

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) yield path;
  }
}

/** Runtime imports between sub-parts, without the declared exceptions. */
export function subpartEdges(files: Iterable<string>): { edges: Edge[]; unknown: string[] } {
  const edges: Edge[] = [];
  const unknown: string[] = [];
  for (const file of files) {
    const path = relative(ROOT, file);
    const from = subpartOf(path);
    if (from === undefined) {
      unknown.push(path);
      continue;
    }
    for (const match of readFileSync(file, 'utf8').matchAll(
      /(^(?:import|export)\s+type\b[^;]*?\bfrom\s+|\bfrom\s+|\bimport\s*\(\s*|^import\s+)'(\.{1,2}\/[^']+)'/gm,
    )) {
      if (/^(?:import|export)\s+type\b/.test(match[1] ?? '')) continue;
      const specifier = match[2] ?? '';
      const target = resolve(dirname(file), specifier);
      if (!target.startsWith(`${ROOT}/`)) continue;
      const to = subpartOf(relative(ROOT, target));
      if (to === undefined || to === from) continue;
      if (
        SUBPART_EXCEPTIONS.some(
          (entry) => entry.file === path && entry.specifier === specifier,
        )
      ) {
        continue;
      }
      edges.push({ from, to, file: path, specifier });
    }
  }
  return { edges, unknown };
}

const files = [...sources(ROOT)];
const { edges, unknown } = subpartEdges(files);

describe('the sub-parts of agent-runtime', () => {
  test('every file belongs to a named sub-part', () => {
    expect(unknown).toEqual([]);
  });

  test('every runtime import between sub-parts is a declared direction', () => {
    expect(undeclaredEdges(edges, SUBPART_ALLOWED)).toEqual([]);
  });

  test('no two sub-parts depend on each other at runtime', () => {
    expect(runtimeCycles(edges)).toEqual([]);
  });

  test('every declared direction and every exception is still used', () => {
    const used = new Set(edges.map((edge) => `${edge.from}→${edge.to}`));
    const stale = Object.entries(SUBPART_ALLOWED).flatMap(([from, targets]) =>
      targets.filter((to) => !used.has(`${from}→${to}`)).map((to) => `${from} → ${to}`),
    );
    expect(stale).toEqual([]);
    const unusedExceptions = SUBPART_EXCEPTIONS.filter(
      (entry) =>
        !readFileSync(join(ROOT, entry.file), 'utf8').includes(`'${entry.specifier}'`),
    ).map((entry) => `${entry.file} → ${entry.specifier}`);
    expect(unusedExceptions).toEqual([]);
  });

  test('an undeclared edge and an unknown prefix are refused (negative control)', () => {
    expect(
      undeclaredEdges(
        [{ from: 'store', to: 'run', file: 'store-x.ts', specifier: './run-y' }],
        SUBPART_ALLOWED,
      ),
    ).toEqual(['store-x.ts → ./run-y (store → run)']);
    expect(subpartOf('mystery-module.ts')).toBeUndefined();
    expect(subpartOf('sqlite-rows.ts')).toBe('store');
    expect(
      runtimeCycles([
        { from: 'store', to: 'run', file: 'store-x.ts', specifier: './run-y' },
        { from: 'run', to: 'store', file: 'run-y.ts', specifier: './store-x' },
      ]),
    ).toEqual([['run', 'store']]);
  });
});
