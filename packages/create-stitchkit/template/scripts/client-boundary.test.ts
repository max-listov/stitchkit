import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import {
  type ClientBoundaryScan,
  clientEntries,
  findDeclarationLeaks,
  specifiers,
} from './client-boundary';

const root = resolve(import.meta.dir, '..');
const project: ClientBoundaryScan = {
  root,
  frontendSrc: join(root, 'packages/frontend/src'),
  declaration: join(root, 'packages/config/src/declaration.ts'),
};

describe('the declaration stays out of the browser', () => {
  test('the fixture actually has client components to walk', () => {
    expect(clientEntries(project).length).toBeGreaterThan(0);
  });

  test('no client graph reaches the project declaration', () => {
    expect(
      findDeclarationLeaks(project).map((chain) =>
        chain.map((file) => relative(root, file)).join(' → '),
      ),
    ).toEqual([]);
  });
});

describe('the scanner fails however the import is written', () => {
  // Package, barrel and relative imports can reach the same declaration.
  // Every spelling must be checked against the resolved file.
  const created: string[] = [];
  afterAll(() => {
    for (const path of created) rmSync(path, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): ClientBoundaryScan {
    const base = mkdtempSync(join(tmpdir(), 'client-boundary-'));
    created.push(base);
    const write = (relativePath: string, content: string): void => {
      const path = join(base, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    };
    write(
      'packages/config/package.json',
      JSON.stringify({
        name: '@demo-shop/config',
        exports: { './declaration': './src/declaration.ts' },
      }),
    );
    write('packages/config/src/declaration.ts', 'export const appDeclaration = {};\n');
    for (const [path, content] of Object.entries(files)) write(path, content);
    return {
      root: base,
      frontendSrc: join(base, 'packages/frontend/src'),
      declaration: join(base, 'packages/config/src/declaration.ts'),
    };
  }

  test('a barrel that re-exports the declaration is a leak', () => {
    const scan = fixture({
      'packages/frontend/src/page.tsx':
        "'use client';\nimport { appDeclaration } from './lib';\nexport const value = appDeclaration;\n",
      'packages/frontend/src/lib/index.ts': "export * from '@demo-shop/config/declaration';\n",
    });
    expect(findDeclarationLeaks(scan)).toHaveLength(1);
  });

  test('a relative path into the config package is a leak', () => {
    // A relative import bypasses any check on the package's spelling.
    const scan = fixture({
      'packages/frontend/src/page.tsx':
        "'use client';\nimport { appDeclaration } from '../../config/src/declaration';\nexport const value = appDeclaration;\n",
    });
    expect(findDeclarationLeaks(scan)).toHaveLength(1);
  });

  test('a double-quoted import is a leak too', () => {
    const scan = fixture({
      'packages/frontend/src/page.tsx':
        '\'use client\';\nimport { appDeclaration } from "@demo-shop/config/declaration";\nexport const value = appDeclaration;\n',
    });
    expect(findDeclarationLeaks(scan)).toHaveLength(1);
  });

  test('a client graph that reaches nothing forbidden is clean', () => {
    // The control: without it every assertion above would also pass with a
    // scanner that reports a leak for anything.
    const scan = fixture({
      'packages/frontend/src/page.tsx':
        "'use client';\nimport { name } from './lib';\nexport const value = name;\n",
      'packages/frontend/src/lib/index.ts': "export const name = 'x';\n",
    });
    expect(findDeclarationLeaks(scan)).toEqual([]);
  });

  test('a matching subpath under a foreign scope is not a workspace import', () => {
    const scan = fixture({
      'packages/frontend/src/page.tsx':
        "'use client';\nimport { appDeclaration } from '@foreign/config/declaration';\nexport const value = appDeclaration;\n",
    });
    expect(findDeclarationLeaks(scan)).toEqual([]);
  });

  test('the manifest name resolves a package whose directory has a different name', () => {
    const scan = fixture({
      'packages/config/package.json': JSON.stringify({
        name: 'shop-configuration',
        exports: { './declaration': './src/declaration.ts' },
      }),
      'packages/frontend/src/page.tsx':
        "'use client';\nimport { appDeclaration } from 'shop-configuration/declaration';\nexport const value = appDeclaration;\n",
    });
    expect(findDeclarationLeaks(scan)).toHaveLength(1);
  });

  test('both quote styles and side-effect imports are read', () => {
    expect(
      specifiers(
        [
          "import a from 'single';",
          'import b from "double";',
          "import 'side-effect';",
          'const c = await import("dynamic");',
          "export { d } from 'reexport';",
        ].join('\n'),
      ),
    ).toEqual(['single', 'double', 'reexport', 'side-effect', 'dynamic']);
  });
});
