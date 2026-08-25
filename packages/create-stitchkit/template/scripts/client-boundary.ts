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
 * bundle. That is the exact mistake `app-identity.generated.ts` exists to
 * prevent, made from the other side — and it shipped, because nothing checked
 * the graph, only the file that imports directly.
 *
 * The check is a resolved FILE, not a spelling. Matching the string
 * `@app/config/declaration` catches the one way the leak was written the first
 * time and misses the two ways it comes back: a barrel that re-exports it, and
 * a relative path into the config package. Both end at the same file, so that
 * is what this follows.
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

/** `@app/config/declaration` → the file its package's `exports` map names. */
function resolveWorkspace(scan: ClientBoundaryScan, specifier: string): string | undefined {
  const parts = specifier.split('/');
  if (parts[0] !== '@app' || !parts[1]) return undefined;
  const packageRoot = join(scan.root, 'packages', parts[1]);
  const manifestPath = join(packageRoot, 'package.json');
  if (!existsSync(manifestPath)) return undefined;
  const subpath = parts.length > 2 ? `./${parts.slice(2).join('/')}` : '.';
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const exportsField =
    typeof manifest === 'object' && manifest !== null
      ? Reflect.get(manifest, 'exports')
      : undefined;
  const target =
    typeof exportsField === 'object' && exportsField !== null
      ? Reflect.get(exportsField, subpath)
      : undefined;
  if (typeof target !== 'string') return undefined;
  return firstExistingFile(resolve(packageRoot, target));
}

export function resolveSpecifier(
  scan: ClientBoundaryScan,
  from: string,
  specifier: string,
): string | undefined {
  if (specifier.startsWith('@app/')) return resolveWorkspace(scan, specifier);
  const base = specifier.startsWith('@/')
    ? join(scan.frontendSrc, specifier.slice(2))
    : specifier.startsWith('.')
      ? resolve(dirname(from), specifier)
      : undefined;
  return base ? firstExistingFile(base) : undefined;
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
