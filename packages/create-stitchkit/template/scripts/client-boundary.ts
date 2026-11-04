import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * What a `'use client'` graph is allowed to reach.
 *
 * The project declaration is not application data — it is what the repository
 * says about how it is built and run: role commands, working directories,
 * artifact and migration paths, and the name of every environment variable a
 * deployment supplies. One `import` from a module a client component happens to
 * use puts all of it, plus the Zod schema that parses it, into the browser
 * bundle. `app-identity.generated.ts` exposes only the public identity; the
 * scanner follows the whole graph to keep the full declaration server-only.
 *
 * The check follows resolved files: a direct package import, a barrel and a
 * relative path can all reach the same declaration. Workspace names come from
 * package manifests so the check also follows a renamed package.
 */
export interface ClientBoundaryScan {
  /** Repository root — where `packages/<name>` lives. */
  root: string;
  /** The client graph's entry directory. */
  frontendSrc: string;
  /** The module no client graph may reach. */
  declaration: string;
}

export function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'generated') continue;
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Every module specifier in a source file, in either quote style.
 *
 * Formatting is enforced elsewhere, which is exactly why this must not depend
 * on it: a check that only reads the house style stops being a check the day
 * someone pastes a line from somewhere else.
 */
export function specifiers(source: string): string[] {
  const quoted = `'([^']+)'|"([^"]+)"`;
  return [
    // `import … from 'x'` and `export … from 'x'`.
    ...[...source.matchAll(new RegExp(String.raw`from\s+(?:${quoted})`, 'g'))],
    // `import 'x'` and `import('x')`. Written out because a side-effect import
    // has no `from` — and a module pulled in for its side effects is in the
    // bundle exactly as much as one whose value is used.
    ...[...source.matchAll(new RegExp(String.raw`import\s*\(?\s*(?:${quoted})`, 'g'))],
  ].flatMap((match) => {
    const specifier = match[1] ?? match[2];
    return specifier ? [specifier] : [];
  });
}

function firstExistingFile(base: string): string | undefined {
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function resolveWorkspace(scan: ClientBoundaryScan, specifier: string): string | undefined {
  const packagesRoot = join(scan.root, 'packages');
  if (!existsSync(packagesRoot)) return undefined;
  for (const entry of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageRoot = join(packagesRoot, entry.name);
    const manifestPath = join(packageRoot, 'package.json');
    if (!existsSync(manifestPath)) continue;
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest !== 'object' || manifest === null) continue;
    const name: unknown = Reflect.get(manifest, 'name');
    if (typeof name !== 'string') continue;
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? '.' : `.${specifier.slice(name.length)}`;
    const exportsField: unknown = Reflect.get(manifest, 'exports');
    const target: unknown =
      typeof exportsField === 'string' && subpath === '.'
        ? exportsField
        : typeof exportsField === 'object' && exportsField !== null
          ? Reflect.get(exportsField, subpath)
          : undefined;
    return typeof target === 'string'
      ? firstExistingFile(resolve(packageRoot, target))
      : undefined;
  }
  return undefined;
}

export function resolveSpecifier(
  scan: ClientBoundaryScan,
  from: string,
  specifier: string,
): string | undefined {
  const base = specifier.startsWith('@/')
    ? join(scan.frontendSrc, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : undefined;
  return base ? firstExistingFile(base) : resolveWorkspace(scan, specifier);
}

/** The import chain from a client entry to the declaration, if one exists. */
export function pathToDeclaration(
  scan: ClientBoundaryScan,
  entry: string,
): string[] | undefined {
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [{ file: entry, chain: [entry] }];
  while (queue.length > 0) {
    const step = queue.shift();
    if (!step || seen.has(step.file)) continue;
    seen.add(step.file);
    const source = readFileSync(step.file, 'utf8');
    for (const specifier of specifiers(source)) {
      const next = resolveSpecifier(scan, step.file, specifier);
      if (next === scan.declaration) return [...step.chain, next];
      if (next && !seen.has(next)) queue.push({ file: next, chain: [...step.chain, next] });
    }
  }
  return undefined;
}

export function clientEntries(scan: ClientBoundaryScan): string[] {
  return sourceFiles(scan.frontendSrc).filter((file) =>
    /^\s*['"]use client['"]/m.test(readFileSync(file, 'utf8')),
  );
}

/** Every client entry whose graph reaches the declaration, as a readable chain. */
export function findDeclarationLeaks(scan: ClientBoundaryScan): string[][] {
  return clientEntries(scan).flatMap((entry) => {
    const chain = pathToDeclaration(scan, entry);
    return chain ? [chain] : [];
  });
}
