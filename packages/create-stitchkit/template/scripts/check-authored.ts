import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';

const roots = ['packages', 'scripts', 'e2e'];
const rootFiles = ['playwright.config.ts', 'ecosystem.config.cjs', 'ecosystem.dev.config.cjs'];
const processEnvMarker = ['process', 'env'].join('.');
const replacedThemePackage = ['next', 'themes'].join('-');
const generatedDirectories = new Set(['.git', '.next', 'dist', 'node_modules']);
// The supervision files used to read the environment directly to build an argv
// for the web role. They no longer do — a role reads its own bindings — so they
// are no longer environment boundaries, and this list is smaller by two.
const processEnvBoundaries = new Set([
  'packages/frontend/src/env.ts',
  'packages/config/src/server.ts',
  'scripts/tooling-env.ts',
]);

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function inspect(path: string, source: string): string[] {
  const result = parseSync(path, source);
  const failures = result.errors.map((error) => `${path}: parse error: ${error.message}`);
  const visitor = new Visitor({
    TSAsExpression(node) {
      failures.push(`${path}:${lineAt(source, node.start)}: type assertion`);
    },
    TSTypeAssertion(node) {
      failures.push(`${path}:${lineAt(source, node.start)}: type assertion`);
    },
    TSAnyKeyword(node) {
      failures.push(`${path}:${lineAt(source, node.start)}: explicit any`);
    },
  });
  visitor.visit(result.program);
  if (source.includes(processEnvMarker) && !processEnvBoundaries.has(path)) {
    failures.push(`${path}: direct environment access outside a validated env boundary`);
  }
  if (source.includes(replacedThemePackage)) {
    failures.push(`${path}: use @wrksz/themes as the single theme runtime`);
  }
  if (path.startsWith('packages/frontend/') || path.startsWith('packages/shared/')) {
    for (const specifier of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const dependency = specifier[1];
      if (
        dependency === '@app/db' ||
        dependency?.startsWith('@prisma/') ||
        (path.startsWith('packages/shared/') && dependency?.startsWith('node:')) ||
        (path.startsWith('packages/shared/') && dependency === 'bun')
      ) {
        failures.push(
          `${path}: server-only dependency ${dependency} crossed the browser boundary`,
        );
        // Two separate reasons meet on this line, and the second one is the
        // quiet one. Shipping a database client to the browser is the obvious
        // failure; the other is that a route reaching a data source makes the
        // BUILD depend on data — bytes that are neither code nor a binding, so
        // the artifact stops being a function of the source and starts being a
        // function of whichever machine had the database. Three answers are
        // legitimate, chosen per route: render at runtime (what this template
        // does), declare a frozen export as `build.inputs` in `project.json`
        // and let `scripts/build-inputs.ts` pin its digest, or generate the
        // bytes as a release step.
        if (path.startsWith('packages/frontend/src/app/')) {
          failures.push(
            `${path}: a route reading data makes the build depend on it — render at runtime, declare the export in build.inputs, or generate it as a release step`,
          );
        }
      }
    }
  }
  return failures;
}

async function visitDirectory(directory: string): Promise<string[]> {
  const failures: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && generatedDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (path.includes('/src/generated')) continue;
    if (entry.isDirectory()) {
      failures.push(...(await visitDirectory(path)));
      continue;
    }
    if (!['.cjs', '.ts', '.tsx'].includes(extname(path))) continue;
    failures.push(...inspect(path, await readFile(path, 'utf8')));
  }
  return failures;
}

const failures = [
  ...(await Promise.all(roots.map(visitDirectory))).flat(),
  ...(
    await Promise.all(
      rootFiles.map(async (path) => inspect(path, await readFile(path, 'utf8'))),
    )
  ).flat(),
];
const webPackage = await readFile('packages/frontend/package.json', 'utf8');
if (webPackage.includes(replacedThemePackage)) {
  failures.push(
    'packages/frontend/package.json: use @wrksz/themes as the single theme runtime',
  );
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
