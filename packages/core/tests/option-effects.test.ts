/**
 * Guard: a declared option has to be load-bearing.
 *
 * Six shipped defects share one shape — an option is accepted, typed and
 * documented, and on some path simply not honoured. `transports:
 * ['websocket']` did not refuse polling; a route group's `onError` was never
 * dispatched; `managedServerResource` never started the server it was handed a
 * thunk for; `bindProcessSignals` substituted schema defaults over the
 * application's declared budget. Every one of them typechecked.
 *
 * Types cannot catch this class by construction: a type proves an option can be
 * PASSED and says nothing about whether passing it changes anything. So the
 * check is coverage, mechanically enumerated from the real types the way
 * `reference-coverage.test.ts` enumerates exports.
 *
 * What it proves is deliberately narrow: that a NAMED test claims this option.
 * Not that the test is good — the same contract `reference-coverage` has, and
 * still the whole distance between six silent defects and a red gate.
 *
 * The covered surfaces are chosen by failure mode, not by importance. A wrong
 * `port` fails loudly on the first request; an unenforced allowlist, a
 * never-dispatched hook and an unapplied grace period all look exactly like
 * success. → `docs/backlog/done/2026-08-31-a-declared-option-must-be-load-bearing.md`
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from '@typescript/typescript6';
import { z } from 'zod';

const SRC = `${import.meta.dir}/../src`;
const TESTS = import.meta.dir;
const REGISTRY = `${TESTS}/fixtures/option-effects.json`;

/** Where each covered configuration type is exported from. */
const COVERED: Record<string, string> = {
  ShutdownOptions: 'server/index.ts',
  ProcessSignalsOptions: 'server/index.ts',
  SocketIOServerConfig: 'server/index.ts',
  RouteGroup: 'server/index.ts',
  LifecycleHooks: 'server/index.ts',
  ManagedServerResourceConfig: 'application.ts',
};

const EntrySchema = z.union([
  z.object({ test: z.string().min(1) }),
  z.object({ exempt: z.string().min(20) }),
]);
const RegistrySchema = z.record(z.string(), z.record(z.string(), EntrySchema));

const program = ts.createProgram(
  [...new Set(Object.values(COVERED))].map((file) => join(SRC, file)),
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    noEmit: true,
  },
);
const checker = program.getTypeChecker();

/** The declared members of one exported configuration type. */
function membersOf(typeName: string, file: string): string[] {
  const source = program.getSourceFile(join(SRC, file));
  const moduleSymbol = source && checker.getSymbolAtLocation(source);
  if (!moduleSymbol) throw new Error(`cannot resolve entrypoint ${file}`);
  const symbol = checker
    .getExportsOfModule(moduleSymbol)
    .find((exported) => exported.getName() === typeName);
  if (!symbol) throw new Error(`${typeName} is not exported from ${file}`);
  const declared = checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol));
  if (declared.length > 0) return declared.map((property) => property.getName()).sort();
  // A `z.input<typeof Schema>` alias has no declared type of its own; the type
  // at its declaration is the inferred object.
  const declaration = symbol.declarations?.[0];
  if (!declaration) throw new Error(`${typeName} has no declaration`);
  return checker
    .getPropertiesOfType(checker.getTypeAtLocation(declaration))
    .map((property) => property.getName())
    .sort();
}

/** Every `test('…')` name defined anywhere in this suite. */
function definedTestNames(): Set<string> {
  const names = new Set<string>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'fixtures' && entry.name !== 'node_modules') walk(path);
        continue;
      }
      if (!entry.name.endsWith('.test.ts')) continue;
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(
        /\btest(?:\.\w+)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g,
      )) {
        if (match[2]) names.add(match[2]);
      }
    }
  };
  walk(TESTS);
  return names;
}

describe('a declared option is load-bearing', () => {
  const registry = RegistrySchema.parse(JSON.parse(readFileSync(REGISTRY, 'utf8')));
  const defined = definedTestNames();

  test('the registry can find the tests it names', () => {
    // Proves the walker works before anything is judged by it: a registry that
    // named nothing findable would otherwise look exactly like a clean sweep.
    expect(defined.size).toBeGreaterThan(500);
    expect(defined.has('the registry can find the tests it names')).toBe(true);
  });

  for (const [typeName, file] of Object.entries(COVERED)) {
    test(`every option of ${typeName} names a test that exercises it`, () => {
      const members = membersOf(typeName, file);
      const entries = registry[typeName] ?? {};
      expect(members.filter((member) => !(member in entries))).toEqual([]);
      // The registry may not outlive the type: a stale entry is a claim about
      // an option that no longer exists.
      expect(
        Object.keys(entries)
          .filter((name) => !members.includes(name))
          .sort(),
      ).toEqual([]);
    });

    test(`every test ${typeName} names is a real test`, () => {
      const entries = registry[typeName] ?? {};
      const missing = Object.entries(entries)
        .filter(([, entry]) => 'test' in entry && !defined.has(entry.test))
        .map(
          ([option, entry]) => `${typeName}.${option} → ${'test' in entry ? entry.test : ''}`,
        );
      expect(missing).toEqual([]);
    });
  }

  test('the registry covers exactly the types this gate claims to cover', () => {
    expect(Object.keys(registry).sort()).toEqual(Object.keys(COVERED).sort());
  });
});
