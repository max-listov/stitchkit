import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseSync, Visitor } from 'oxc-parser';

const roots = ['packages', 'scripts'];
const processEnvMarker = ['process', 'env'].join('.');
const replacedThemePackage = ['next', 'themes'].join('-');
const generatedDirectories = new Set(['.git', '.next', 'dist', 'node_modules']);
const processEnvBoundaries = new Set([
  'packages/frontend/src/env.ts',
  'packages/config/src/server.ts',
  'scripts/tooling-env.ts',
]);

function inspect(path: string, source: string): string[] {
  const result = parseSync(path, source);
  const failures = result.errors.map((error) => `${path}: parse error: ${error.message}`);
  const visitor = new Visitor({
    TSAsExpression(node) {
      failures.push(`${path}:${node.loc?.start.line ?? 1}: type assertion`);
    },
    TSTypeAssertion(node) {
      failures.push(`${path}:${node.loc?.start.line ?? 1}: type assertion`);
    },
    TSAnyKeyword(node) {
      failures.push(`${path}:${node.loc?.start.line ?? 1}: explicit any`);
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
    if (!['.ts', '.tsx'].includes(extname(path))) continue;
    failures.push(...inspect(path, await readFile(path, 'utf8')));
  }
  return failures;
}

const failures = (await Promise.all(roots.map(visitDirectory))).flat();
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
