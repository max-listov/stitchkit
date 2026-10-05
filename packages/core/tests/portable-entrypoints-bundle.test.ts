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

  test('the default loader resolves its addon from its own directory and keeps the load cause', () => {
    const requested: string[] = [];
    const module = { exports: () => undefined };
    runInNewContext(nativeLoaderSource({ arm64: './native/a.node' }, 'beside-loader'), {
      module,
      process: { arch: 'arm64' },
      __dirname: '/pkg',
      require(specifier: string) {
        requested.push(specifier);
        throw new Error('addon absent');
      },
    });
    expect(requested).toEqual([]);
    expect(() => module.exports()).toThrow('Darwin addon loading failed');
    expect(requested).toEqual(['/pkg/native/a.node']);
  });
});
