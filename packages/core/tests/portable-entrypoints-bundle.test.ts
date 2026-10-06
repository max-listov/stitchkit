import { describe, expect, test } from 'bun:test';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { nativeLoaderSource } from '../src/files/native-packaging-layout';
import { NATIVE_NOT_PACKAGED } from '../src/internal/darwin-binding-error';

const core = resolve(import.meta.dir, '..');

describe('portable entrypoints carry no native addon in a bundle', () => {
  // Reaching the default loader from a public entrypoint must not break a bundle build.
  for (const entrypoint of ['server', 'files', 'process']) {
    for (const target of ['bun', 'node'] as const) {
      test(`stitchkit/${entrypoint} bundles to one file for target ${target}`, async () => {
        const out = mkdtempSync(join(tmpdir(), 'stitchkit-portable-bundle-'));
        try {
          // `Bun.build` with an outdir yields every emitted file; `--outfile` accepts exactly one.
          const result = await Bun.build({
            entrypoints: [join(core, 'src/entrypoints', `${entrypoint}.ts`)],
            outdir: out,
            target,
            packages: 'bundle',
            external: [
              '@modelcontextprotocol/*',
              'ai',
              '@openrouter/*',
              'grammy',
              'srvx',
              'socket.io*',
              '@socket.io/*',
              '@tanstack/*',
              'react*',
              '@opentelemetry/*',
              'bun:*',
            ],
          });
          expect(result.success).toBe(true);
          expect(result.outputs.map((file) => file.kind)).toEqual(['entry-point']);
          expect(result.outputs.filter((file) => file.path.endsWith('.node'))).toEqual([]);
        } finally {
          rmSync(out, { recursive: true, force: true });
        }
      });
    }
  }

  test('bundling the default loader beside real addon files emits one file and no .node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-default-loader-'));
    try {
      copyFileSync(join(core, 'darwin-native.cjs'), join(root, 'darwin-native.cjs'));
      mkdirSync(join(root, 'native'));
      for (const architecture of ['arm64', 'x64'])
        writeFileSync(join(root, 'native', `darwin-${architecture}.node`), 'not an addon');
      writeFileSync(
        join(root, 'entry.mjs'),
        "import load from './darwin-native.cjs'; export default load;",
      );
      const result = await Bun.build({
        entrypoints: [join(root, 'entry.mjs')],
        outdir: join(root, 'dist'),
        target: 'bun',
      });
      expect(result.success).toBe(true);
      expect(result.outputs.map((file) => file.kind)).toEqual(['entry-point']);
      expect(result.outputs.filter((file) => file.path.endsWith('.node'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the checked-in default loader is the generated one and names its addons by a computed path', () => {
    const text = readFileSync(join(core, 'darwin-native.cjs'), 'utf8');
    const layout: { assets: Record<string, string> } = JSON.parse(
      readFileSync(join(core, 'native-layout.json'), 'utf8'),
    );
    const assets = Object.fromEntries(
      Object.entries(layout.assets).map(([architecture, asset]) => [
        architecture,
        `./${asset}`,
      ]),
    );
    expect(text).toBe(nativeLoaderSource(assets, 'beside-loader'));
    expect(text).not.toMatch(/require\(\s*['"]/);
  });

  test('the default loader resolves its addon from its own file and keeps the load cause', () => {
    const requested: string[] = [];
    const module = { filename: '/pkg/darwin-native.cjs', exports: () => undefined };
    runInNewContext(nativeLoaderSource({ arm64: './native/a.node' }, 'beside-loader'), {
      module,
      process: { arch: 'arm64' },
      require(specifier: string) {
        requested.push(specifier);
        throw new Error('addon absent');
      },
    });
    expect(requested).toEqual([]);
    expect(() => module.exports()).toThrow('Darwin addon loading failed');
    expect(requested).toEqual(['/pkg/native/a.node']);
  });

  test('inside a bundle the default loader refuses by name and requires nothing', () => {
    for (const filename of ['darwin-native.cjs', undefined]) {
      const requested: string[] = [];
      const module = { filename, exports: () => undefined };
      runInNewContext(nativeLoaderSource({ arm64: './native/a.node' }, 'beside-loader'), {
        module,
        process: { arch: 'arm64' },
        require(specifier: string) {
          requested.push(specifier);
        },
      });
      expect(() => module.exports()).toThrow(
        expect.objectContaining({
          code: NATIVE_NOT_PACKAGED,
          message: expect.stringContaining('createNativePackaging'),
        }),
      );
      expect(requested).toEqual([]);
    }
  });
});

/** Every occurrence of `text` in an artifact, in the two encodings Bun stores source in. */
function occurrences(bytes: Uint8Array, text: string): number {
  const haystack = Buffer.from(bytes);
  let count = 0;
  for (const needle of [Buffer.from(text, 'latin1'), Buffer.from(text, 'utf16le')]) {
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1))
      count++;
  }
  return count;
}

describe('a bundle built without native packaging carries no build-machine path', () => {
  const lockEntry =
    "import { withExclusiveLock } from '#core/files'; console.log(typeof withExclusiveLock);";
  const boundaryEntry =
    "import { createManagedFileBoundary } from '#core/files'; console.log(typeof createManagedFileBoundary);";

  async function bundle(
    source: string,
    target: 'bun' | 'node',
  ): Promise<{ text: string; root: string }> {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-native-path-'));
    const entry = join(root, 'entry.ts');
    writeFileSync(
      entry,
      source.replace('#core/files', join(core, 'src/entrypoints/files.ts')),
    );
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(root, 'dist'),
      target,
      minify: true,
    });
    expect(result.success).toBe(true);
    const [output] = result.outputs;
    if (!output) throw new Error('Bundle emitted no output');
    return { text: await output.text(), root };
  }

  for (const target of ['bun', 'node'] as const) {
    test(`a lock bundle for target ${target} names no absolute path of the package`, async () => {
      const { text, root } = await bundle(lockEntry, target);
      try {
        expect(text).toContain(NATIVE_NOT_PACKAGED);
        expect(occurrences(Buffer.from(text), core)).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    test(`a boundary-only bundle for target ${target} carries no Darwin loader`, async () => {
      const { text, root } = await bundle(boundaryEntry, target);
      try {
        expect(text).not.toContain(NATIVE_NOT_PACKAGED);
        expect(text).not.toContain('Darwin addon');
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test('a compiled lock executable names no absolute path of the package', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-native-compile-'));
    try {
      const entry = join(root, 'entry.ts');
      writeFileSync(
        entry,
        lockEntry.replace('#core/files', join(core, 'src/entrypoints/files.ts')),
      );
      const outfile = join(root, 'out');
      const result = await Bun.build({
        entrypoints: [entry],
        minify: true,
        compile: { outfile },
      });
      expect(result.success).toBe(true);
      const bytes = readFileSync(outfile);
      expect(occurrences(bytes, NATIVE_NOT_PACKAGED)).toBeGreaterThan(0);
      expect(occurrences(bytes, core)).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test('negative control: a loader that reads __dirname puts the build path into the bundle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-native-control-'));
    try {
      writeFileSync(
        join(root, 'loader.cjs'),
        'module.exports = () => require(__dirname + "/native/a.node");',
      );
      writeFileSync(join(root, 'entry.mjs'), "import load from './loader.cjs'; load;");
      const result = await Bun.build({
        entrypoints: [join(root, 'entry.mjs')],
        outdir: join(root, 'dist'),
        target: 'bun',
      });
      const [output] = result.outputs;
      if (!output) throw new Error('Bundle emitted no output');
      expect(await output.text()).toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
