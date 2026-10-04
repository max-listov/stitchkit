import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { BunPlugin } from 'bun';
import { z } from 'zod';
import { createNativePackaging } from '../src/entrypoints/files/packaging';
import { NativeLayoutSchema, nativeLoaderSource } from '../src/files/native-packaging-layout';

const options = {
  platform: 'darwin',
  architecture: 'arm64',
  delivery: 'companion',
  entryPath: 'app/proof.js',
  assetPath: 'addons/owner.node',
} satisfies Parameters<typeof createNativePackaging>[0];

describe('native packaging contract', () => {
  test('unsupported targets refuse without resolving or loading a Darwin backend', () => {
    for (const target of [
      { platform: 'linux', architecture: 'arm64' },
      { platform: 'darwin', architecture: 'riscv64' },
      { platform: 'win32', architecture: 'x64' },
    ]) {
      expect(createNativePackaging({ ...options, ...target })).toEqual({
        state: 'unsupported',
        ...target,
        code: 'NATIVE_TARGET_UNSUPPORTED',
      });
    }
  });
  test('public output paths reject traversal and entry/addon collisions before work', () => {
    for (const assetPath of [
      '../owner.node',
      '/owner.node',
      'C:/owner.node',
      'C:owner.node',
      'addons/../owner.node',
      'a\\b',
      './x',
      'a//b',
      'app/proof.js',
      'app/proof.js/owner.node',
      'app',
    ]) {
      expect(() => createNativePackaging({ ...options, assetPath })).toThrow();
    }
    for (const entryPath of ['[dir]/proof.js', 'app/[name].js', 'app/[hash].js']) {
      expect(() => createNativePackaging({ ...options, entryPath })).toThrow(
        'fixed entry path',
      );
    }
  });
  test('universal targets require a complete unique collision-free companion map', () => {
    const universal = {
      ...options,
      architecture: ['arm64', 'x64'],
      assetPath: { arm64: 'addons/arm.node', x64: 'addons/intel.node' },
    };
    for (const input of [
      { ...universal, architecture: [] },
      { ...universal, architecture: ['arm64', 'arm64'] },
      { ...universal, assetPath: { arm64: 'addons/arm.node' } },
      { ...universal, assetPath: { ...universal.assetPath, other: 'other.node' } },
      { ...universal, assetPath: { arm64: 'same.node', x64: 'same.node' } },
      { ...universal, assetPath: { arm64: 'addons', x64: 'addons/intel.node' } },
    ])
      expect(() => createNativePackaging(input)).toThrow();
    expect(createNativePackaging({ ...universal, platform: 'linux' })).toEqual({
      state: 'unsupported',
      platform: 'linux',
      architecture: 'arm64',
      code: 'NATIVE_TARGET_UNSUPPORTED',
    });
    expect(
      createNativePackaging({
        ...universal,
        architecture: ['arm64', 'riscv64'],
        assetPath: { arm64: 'arm.node', riscv64: 'other.node' },
      }),
    ).toEqual({
      state: 'unsupported',
      platform: 'darwin',
      architecture: 'riscv64',
      code: 'NATIVE_TARGET_UNSUPPORTED',
    });
  });
  test('one universal loader selects only its exact runtime target without fallback', () => {
    for (const architecture of ['arm64', 'x64', 'riscv64']) {
      const calls: string[] = [];
      const module = { exports: () => undefined };
      runInNewContext(nativeLoaderSource({ arm64: './arm.node', x64: './intel.node' }), {
        module,
        process: { arch: architecture },
        require(specifier: string) {
          calls.push(specifier);
          throw new Error('selected addon unavailable');
        },
      });
      expect(calls).toEqual([]);
      expect(() => module.exports()).toThrow('Darwin addon loading failed');
      expect(calls).toEqual(
        architecture === 'arm64'
          ? ['./arm.node']
          : architecture === 'x64'
            ? ['./intel.node']
            : [],
      );
    }
  });
  test('layout metadata rejects unsupported versions and paths escaping the package', () => {
    expect(
      NativeLayoutSchema.safeParse({
        formatVersion: 2,
        loader: 'loader.cjs',
        assets: { arm64: 'a.node', x64: 'x.node' },
      }).success,
    ).toBe(false);
    expect(
      NativeLayoutSchema.safeParse({
        formatVersion: 1,
        loader: '../loader.cjs',
        assets: { arm64: 'a.node', x64: 'x.node' },
      }).success,
    ).toBe(false);
  });
  test('one generator follows renamed assets and preserves lazy load/cause behavior', () => {
    const text = nativeLoaderSource({ arm64: './renamed/addon.node' });
    expect(text).toContain("return require('./renamed/addon.node')");
    expect(text).not.toContain('darwin-arm64.node');
    expect(text).toContain('module.exports = function');
    expect(text).toContain("new Error('Darwin addon loading failed', { cause })");
  });
  test('plugin is directly assignable to the actual Bun build protocol', () => {
    const result = createNativePackaging(options);
    if (result.state === 'ready') {
      const plugin: BunPlugin = result.plugin;
      expect(plugin.name).toBe('stitchkit-native-packaging');
    } else expect(['missing', 'unsupported']).toContain(result.state);
  });
  test('packaging target, delivery and output paths change the real Bun build graph', async () => {
    // Synthetic bytes prove bundler edges and integrity, never native execution.
    const root = mkdtempSync(join(tmpdir(), 'stitchkit-packaging-options-'));
    try {
      const layout = {
        formatVersion: 1,
        loader: 'loader.cjs',
        assets: { arm64: 'assets/arm.node', x64: 'assets/intel.node' },
      };
      writeFileSync(join(root, 'native-assets.json'), JSON.stringify(layout));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: 'stitchkit', version: '0.0.0-test', type: 'module' }),
      );
      mkdirSync(join(root, 'assets'));
      for (const asset of Object.values(layout.assets))
        writeFileSync(join(root, asset), asset);
      writeFileSync(
        join(root, layout.loader),
        nativeLoaderSource({ arm64: './assets/arm.node', x64: './assets/intel.node' }),
      );
      const moduleBuild = await Bun.build({
        entrypoints: [resolve(import.meta.dir, '../src/entrypoints/files/packaging.ts')],
        outdir: join(root, 'dist'),
        target: 'node',
        naming: { entry: 'packaging.js' },
      });
      expect(moduleBuild.success).toBe(true);
      const exported = z
        .object({
          createNativePackaging: z.custom<typeof createNativePackaging>(
            (value) => typeof value === 'function',
          ),
        })
        .parse(await import(pathToFileURL(join(root, 'dist/packaging.js')).href));
      const ready = (input: Parameters<typeof createNativePackaging>[0]) => {
        const result = exported.createNativePackaging(input);
        if (result.state !== 'ready') throw new Error(result.code);
        return result;
      };
      expect(exported.createNativePackaging({ ...options, platform: 'linux' }).state).toBe(
        'unsupported',
      );
      const arm = ready(options);
      const intel = ready({ ...options, architecture: 'x64' });
      const armAsset = arm.assets[0];
      const intelAsset = intel.assets[0];
      if (!armAsset || !intelAsset) throw new Error('Target asset is absent');
      expect(Object.keys(armAsset).sort()).toEqual(['outputPath', 'sha256', 'sourcePath']);
      expect(armAsset.sourcePath).toBe(join(root, layout.assets.arm64));
      expect(intelAsset.sourcePath).toBe(join(root, layout.assets.x64));
      expect(intelAsset.sha256).not.toBe(armAsset.sha256);
      const entry = join(root, 'input.js');
      writeFileSync(entry, `export { default as load } from './${layout.loader}';`);
      for (const [entryPath, assetPath] of [
        ['app/proof.js', 'addons/owner.node'],
        ['nested/deeper/proof.js', 'custom/native.node'],
      ]) {
        if (!entryPath || !assetPath) throw new Error('Invalid test layout');
        const packaging = ready({ ...options, entryPath, assetPath });
        const output = join(root, entryPath.split('/')[0] ?? 'output');
        const built = await Bun.build({
          entrypoints: [entry],
          outdir: output,
          target: 'node',
          naming: { entry: entryPath },
          plugins: [packaging.plugin],
        });
        expect(built.success).toBe(true);
        expect(built.outputs.map((file) => file.path)).toEqual([join(output, entryPath)]);
        const text = readFileSync(join(output, entryPath), 'utf8');
        const edge = /require\("([^"]+\.node)"\)/.exec(text)?.[1];
        if (!edge) throw new Error('Companion edge is absent');
        expect(resolve(dirname(join(output, entryPath)), edge)).toBe(join(output, assetPath));
      }
      const universal = ready({
        ...options,
        architecture: ['arm64', 'x64'],
        assetPath: { arm64: 'native/arm.node', x64: 'other/intel.node' },
      });
      expect(universal.architecture).toEqual(['arm64', 'x64']);
      expect(universal.assets.map((asset) => asset.sha256)).toEqual([
        armAsset.sha256,
        intelAsset.sha256,
      ]);
      const universalOutput = join(root, 'universal');
      const universalBuild = await Bun.build({
        entrypoints: [entry],
        outdir: universalOutput,
        target: 'node',
        naming: { entry: options.entryPath },
        plugins: [universal.plugin],
      });
      expect(universalBuild.success).toBe(true);
      expect(universalBuild.outputs.map((file) => file.path)).toEqual([
        join(universalOutput, options.entryPath),
      ]);
      const edges = [
        ...readFileSync(join(universalOutput, options.entryPath), 'utf8').matchAll(
          /require\("([^"]+\.node)"\)/g,
        ),
      ].map((match) =>
        resolve(dirname(join(universalOutput, options.entryPath)), match[1] ?? ''),
      );
      expect(edges).toEqual(
        universal.assets.map((asset) => join(universalOutput, asset.outputPath)),
      );
      rmSync(intelAsset.sourcePath);
      expect(
        exported.createNativePackaging({
          ...options,
          architecture: ['arm64', 'x64'],
          assetPath: { arm64: 'native/arm.node', x64: 'other/intel.node' },
        }),
      ).toEqual({
        state: 'missing',
        platform: 'darwin',
        architecture: 'x64',
        code: 'NATIVE_ASSET_MISSING',
      });
      const embedded = ready({ ...options, delivery: 'embedded' });
      const built = await Bun.build({
        entrypoints: [entry],
        outdir: join(root, 'embedded'),
        target: 'node',
        plugins: [embedded.plugin],
      });
      expect(built.success).toBe(true);
      const addon = built.outputs.find((file) => file.path.endsWith('.node'));
      if (!addon) throw new Error('Embedded delivery did not give Bun the addon');
      expect(createHash('sha256').update(readFileSync(addon.path)).digest('hex')).toBe(
        armAsset.sha256,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
