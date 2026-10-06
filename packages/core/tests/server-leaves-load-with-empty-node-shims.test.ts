import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const core = resolve(import.meta.dir, '..');

/**
 * A browser bundler that meets `node:*` gives each import an empty module: Vite's dependency
 * pre-bundle does exactly that. Every binding then reads `undefined`, so a module that calls a
 * Node API while it loads throws there, although nothing ever calls it.
 */
function withEmptyNodeModules(code: string): string {
  return code
    .replace(/import\s*\{([^}]*)\}\s*from\s*["']node:[^"']+["'];?/g, (_, names: string) => {
      const bindings = names
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name.length > 0)
        .map((name) => name.replace(/\s+as\s+/, ': '));
      return `const { ${bindings.join(', ')} } = {};`;
    })
    .replace(/import\s*\*\s*as\s+([\w$]+)\s+from\s*["']node:[^"']+["'];?/g, 'const $1 = {};')
    .replace(
      /import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s*["']node:[^"']+["'];?/g,
      (_, name: string, names: string) =>
        `const ${name} = {}; const { ${names
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0)
          .map((part) => part.replace(/\s+as\s+/, ': '))
          .join(', ')} } = {};`,
    )
    .replace(/import\s+([\w$]+)\s+from\s*["']node:[^"']+["'];?/g, 'const $1 = {};')
    .replace(/import\s*["']node:[^"']+["'];?/g, '');
}

describe('server leaves load where node built-ins are empty modules', () => {
  for (const leaf of ['server', 'process', 'files']) {
    test(`every export of stitchkit/${leaf} loads without calling Node`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'stitchkit-empty-node-'));
      try {
        const entry = join(root, 'entry.ts');
        writeFileSync(
          entry,
          `import * as leaf from '${join(core, 'src/entrypoints', `${leaf}.ts`)}';\nexport const names = Object.keys(leaf);\n`,
        );
        const result = await Bun.build({
          entrypoints: [entry],
          target: 'browser',
          format: 'esm',
          external: ['node:*'],
        });
        expect(result.success).toBe(true);
        const [output] = result.outputs;
        if (!output) throw new Error('Bundle emitted no output');
        const code = withEmptyNodeModules(await output.text());
        expect(code).not.toMatch(/from\s*["']node:/);
        const loaded = join(root, 'loaded.mjs');
        writeFileSync(loaded, code);
        const module: { names: string[] } = await import(pathToFileURL(loaded).href);
        expect(module.names.length).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
