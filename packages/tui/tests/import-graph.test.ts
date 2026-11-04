import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const source = path.join(import.meta.dir, '../src');

/** Specifiers a module loads when it is evaluated: static value imports and re-exports. */
function staticImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const match of text.matchAll(
    /^(?:import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm,
  )) {
    if (match[1]) found.push(match[1]);
  }
  return found;
}

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Unresolved import ${specifier} from ${from}`);
}

/** Every package an entry loads at evaluation, with the local file that pulls it in. */
function reach(entry: string): Map<string, string> {
  const packages = new Map<string, string>();
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const specifier of staticImports(file)) {
      const local = resolveLocal(file, specifier);
      if (local) visit(local);
      else if (!packages.has(specifier)) packages.set(specifier, path.relative(source, file));
    }
  };
  visit(path.join(source, entry));
  return packages;
}

const named = (packages: Map<string, string>, pattern: RegExp): string[] =>
  [...packages].filter(([name]) => pattern.test(name)).map(([name, by]) => `${name} <- ${by}`);

describe('terminal package import graph', () => {
  test('the core loads no renderer, React or agent runtime', () => {
    expect(named(reach('core/index.ts'), /^(react|@opentui\/|stitchkit)/)).toEqual([]);
  });

  test('the widgets load no agent runtime, so a monitor needs no stitchkit', () => {
    expect(named(reach('widgets/index.ts'), /^stitchkit/)).toEqual([]);
  });

  test('the CLI loads React only after choosing its build', () => {
    expect(named(reach('cli.ts'), /^(react|@opentui\/)/)).toEqual([]);
    const cli = readFileSync(path.join(source, 'cli.ts'), 'utf8');
    expect(cli.indexOf("process.env.NODE_ENV ??= 'production'")).toBeGreaterThan(-1);
    expect(cli.indexOf("process.env.NODE_ENV ??= 'production'")).toBeLessThan(
      cli.indexOf("await import('./run')"),
    );
  });

  test('the graph reader sees a renderer where there is one', () => {
    expect(named(reach('index.ts'), /^@opentui\//).length).toBeGreaterThan(0);
  });
});
