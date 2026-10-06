import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import type { BunPlugin } from 'bun';
import { z } from 'zod';
import {
  createNativePackaging,
  inspectNativeArtifact,
  type NativePackagingEmbeddedOptions,
  type NativePackagingOptions,
  type NativePackagingResult,
} from '../src/entrypoints/files/packaging';
import {
  NativeAssetManifestSchema,
  NativeLayoutSchema,
  nativeLoaderSource,
} from '../src/files/native-packaging-layout';

const options = {
  platform: 'darwin',
  architecture: 'arm64',
  delivery: 'companion',
  entryPath: 'app/proof.js',
  assetPath: 'addons/owner.node',
} satisfies Parameters<typeof createNativePackaging>[0];

describe('native packaging contract', () => {
  test('an unsupported architecture refuses without resolving or loading a Darwin backend', () => {
    expect(createNativePackaging({ ...options, architecture: 'riscv64' })).toEqual({
      state: 'unsupported',
      platform: 'darwin',
      architecture: 'riscv64',
      code: 'NATIVE_TARGET_UNSUPPORTED',
    });
  });
  test('a platform without native addons is a type error and a schema refusal', () => {
    // @ts-expect-error — `platform` is the closed set of platforms with addons.
    expect(() => createNativePackaging({ ...options, platform: 'linux' })).toThrow(z.ZodError);
    const universal = {
      ...options,
      architecture: ['arm64', 'x64'],
      assetPath: { arm64: 'addons/arm.node', x64: 'addons/intel.node' },
    };
    // @ts-expect-error — the universal form takes the same closed set.
    expect(() => createNativePackaging({ ...universal, platform: 'win32' })).toThrow(
      z.ZodError,
    );
    // Control: `darwin` passes the schema and reaches the typed architecture refusal.
    expect(createNativePackaging({ ...options, architecture: 'riscv64' }).state).toBe(
      'unsupported',
    );
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
      runInNewContext(
        nativeLoaderSource({ arm64: './arm.node', x64: './intel.node' }, 'static'),
        {
          module,
          process: { arch: architecture },
          require(specifier: string) {
            calls.push(specifier);
            throw new Error('selected addon unavailable');
          },
        },
      );
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
  test('the published manifest refuses another format version and paths escaping the package', () => {
    const entry = { path: 'a.node', size: 1, sha256: 'a'.repeat(64) };
    const manifest = { formatVersion: 2, loader: 'loader.cjs', assets: { arm64: entry } };
    expect(NativeAssetManifestSchema.safeParse(manifest).success).toBe(true);
    for (const formatVersion of [1, 3]) {
      const parsed = NativeAssetManifestSchema.safeParse({ ...manifest, formatVersion });
      expect(parsed.error?.issues[0]?.message).toBe(
        'Native asset manifest formatVersion must be 2 for this Stitchkit',
      );
    }
    // The previous format named a bare path per architecture and carried no digest.
    expect(
      NativeAssetManifestSchema.safeParse({ ...manifest, assets: { arm64: 'a.node' } })
        .success,
    ).toBe(false);
    expect(
      NativeAssetManifestSchema.safeParse({ ...manifest, loader: '../loader.cjs' }).success,
    ).toBe(false);
    expect(
      NativeAssetManifestSchema.safeParse({
        ...manifest,
        assets: { arm64: { ...entry, sha256: 'A'.repeat(64) } },
      }).success,
    ).toBe(false);
    expect(
      NativeLayoutSchema.safeParse({
        loader: 'loader.cjs',
        assets: { arm64: '../a.node', x64: 'x.node' },
      }).success,
    ).toBe(false);
  });
  test('one generator follows renamed assets and preserves lazy load/cause behavior', () => {
    const text = nativeLoaderSource({ arm64: './renamed/addon.node' }, 'static');
    expect(text).toContain("return require('./renamed/addon.node')");
    expect(text).not.toContain('darwin-arm64.node');
    expect(text).toContain('module.exports = function');
    expect(text).toContain("new Error('Darwin addon loading failed', { cause })");
  });
});

/**
 * A fixture package root: the packaging module built into it, synthetic addon bytes, the
 * loader and a published manifest. Synthetic bytes prove bundler edges and integrity, never
 * native execution.
 */
const fixtureLayout = {
  loader: 'loader.cjs',
  assets: { arm64: 'assets/arm.node', x64: 'assets/intel.node' },
};
const fixtureBytes = {
  arm64: new TextEncoder().encode('synthetic arm64 addon'),
  x64: new TextEncoder().encode('synthetic x64 addon bytes'),
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const publishedManifest = {
  formatVersion: 2,
  loader: fixtureLayout.loader,
  assets: {
    arm64: {
      path: fixtureLayout.assets.arm64,
      size: fixtureBytes.arm64.byteLength,
      sha256: sha256(fixtureBytes.arm64),
    },
    x64: {
      path: fixtureLayout.assets.x64,
      size: fixtureBytes.x64.byteLength,
      sha256: sha256(fixtureBytes.x64),
    },
  },
};

describe('native packaging against a published manifest', () => {
  let root = '';
  let packaging: typeof createNativePackaging = createNativePackaging;
  /** Replace a file instead of rewriting it, as a substituted install would. */
  const replace = (path: string, contents: Uint8Array | string) => {
    rmSync(path, { force: true });
    writeFileSync(path, contents);
  };
  const resetFixture = () => {
    replace(join(root, 'native-assets.json'), JSON.stringify(publishedManifest));
    replace(join(root, fixtureLayout.assets.arm64), fixtureBytes.arm64);
    replace(join(root, fixtureLayout.assets.x64), fixtureBytes.x64);
  };
  const ready = (input: NativePackagingOptions<boolean>) => {
    const result = packaging(input);
    if (result.state !== 'ready') throw new Error(result.code);
    return result;
  };
  const readyEmbedded = (input: NativePackagingEmbeddedOptions) => {
    const result = packaging(input);
    if (result.state !== 'ready') throw new Error(result.code);
    return result;
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'stitchkit-packaging-options-'));
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'stitchkit', version: '0.0.0-test', type: 'module' }),
    );
    mkdirSync(join(root, 'assets'));
    resetFixture();
    writeFileSync(
      join(root, fixtureLayout.loader),
      nativeLoaderSource(
        { arm64: './assets/arm.node', x64: './assets/intel.node' },
        'beside-loader',
      ),
    );
    writeFileSync(
      join(root, 'input.js'),
      `export { default as load } from './${fixtureLayout.loader}';`,
    );
    const moduleBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../src/entrypoints/files/packaging.ts')],
      outdir: join(root, 'dist'),
      target: 'node',
      naming: { entry: 'packaging.js' },
    });
    expect(moduleBuild.success).toBe(true);
    packaging = z
      .object({
        createNativePackaging: z.custom<typeof createNativePackaging>(
          (value) => typeof value === 'function',
        ),
      })
      .parse(
        await import(pathToFileURL(join(root, 'dist/packaging.js')).href),
      ).createNativePackaging;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(resetFixture);

  test('a ready asset carries the verified bytes and the published size and digest', () => {
    expect(packaging({ ...options, architecture: 'riscv64' }).state).toBe('unsupported');
    const arm = ready(options);
    const plugin: BunPlugin = arm.plugin;
    expect(plugin.name).toBe('stitchkit-native-packaging');
    const [asset] = arm.assets;
    if (!asset) throw new Error('Target asset is absent');
    expect(Object.keys(asset).sort()).toEqual(['bytes', 'outputPath', 'sha256', 'size']);
    expect(asset.bytes).toEqual(fixtureBytes.arm64);
    expect(asset.size).toBe(publishedManifest.assets.arm64.size);
    expect(asset.sha256).toBe(publishedManifest.assets.arm64.sha256);
    const [intel] = ready({ ...options, architecture: 'x64' }).assets;
    expect(intel?.sha256).toBe(publishedManifest.assets.x64.sha256);
  });

  test('one changed byte of an installed addon refuses with the expected and actual digest', () => {
    const tampered = Uint8Array.from(fixtureBytes.arm64);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    replace(join(root, fixtureLayout.assets.arm64), tampered);
    const expected = {
      size: publishedManifest.assets.arm64.size,
      sha256: publishedManifest.assets.arm64.sha256,
    };
    const refusal: NativePackagingResult = {
      state: 'mismatch',
      platform: 'darwin',
      architecture: 'arm64',
      code: 'NATIVE_ASSET_DIGEST_MISMATCH',
      expected,
      actual: { size: tampered.byteLength, sha256: sha256(tampered) },
    };
    expect(sha256(tampered)).not.toBe(expected.sha256);
    expect(packaging(options)).toEqual(refusal);
    // The universal form refuses as a whole: no partial asset list for the other target.
    expect(
      packaging({
        ...options,
        architecture: ['x64', 'arm64'],
        assetPath: { arm64: 'native/arm.node', x64: 'other/intel.node' },
      }),
    ).toEqual(refusal);
    // A longer file reports its own size and the digest of the bytes that were read.
    const longer = new Uint8Array([...fixtureBytes.arm64, 0]);
    replace(join(root, fixtureLayout.assets.arm64), longer);
    expect(packaging(options)).toEqual({
      ...refusal,
      actual: { size: expected.size + 1, sha256: sha256(longer) },
    });
  });

  test('an addon the manifest does not publish is missing, even when a file is there', () => {
    replace(
      join(root, 'native-assets.json'),
      JSON.stringify({
        ...publishedManifest,
        assets: { arm64: publishedManifest.assets.arm64 },
      }),
    );
    expect(packaging({ ...options, architecture: 'x64' })).toEqual({
      state: 'missing',
      platform: 'darwin',
      architecture: 'x64',
      code: 'NATIVE_ASSET_MISSING',
    });
    resetFixture();
    rmSync(join(root, fixtureLayout.assets.x64));
    expect(
      packaging({
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
  });

  test('a manifest of another format version throws before any asset is read', () => {
    replace(
      join(root, 'native-assets.json'),
      JSON.stringify({ formatVersion: 1, loader: 'loader.cjs', assets: fixtureLayout.assets }),
    );
    expect(() => packaging(options)).toThrow('formatVersion must be 2');
  });

  test('packaging target, delivery and output paths change the real Bun build graph', async () => {
    const entry = join(root, 'input.js');
    for (const [entryPath, assetPath] of [
      ['app/proof.js', 'addons/owner.node'],
      ['nested/deeper/proof.js', 'custom/native.node'],
    ]) {
      if (!entryPath || !assetPath) throw new Error('Invalid test layout');
      const packaged = ready({ ...options, entryPath, assetPath });
      const output = join(root, entryPath.split('/')[0] ?? 'output');
      const built = await Bun.build({
        entrypoints: [entry],
        outdir: output,
        target: 'node',
        naming: { entry: entryPath },
        plugins: [packaged.plugin],
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
      publishedManifest.assets.arm64.sha256,
      publishedManifest.assets.x64.sha256,
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
  });

  test('[hash] names a companion by its published digest, and the loader requires that name', async () => {
    const hashed = ready({
      ...options,
      architecture: ['arm64', 'x64'],
      assetPath: {
        arm64: 'addons/darwin-arm64-[hash].node',
        x64: 'addons/darwin-x64-[hash].node',
      },
    });
    expect(hashed.assets.map((asset) => asset.outputPath)).toEqual([
      `addons/darwin-arm64-${publishedManifest.assets.arm64.sha256.slice(0, 16)}.node`,
      `addons/darwin-x64-${publishedManifest.assets.x64.sha256.slice(0, 16)}.node`,
    ]);
    const output = join(root, 'hashed');
    const built = await Bun.build({
      entrypoints: [join(root, 'input.js')],
      outdir: output,
      target: 'node',
      naming: { entry: options.entryPath },
      plugins: [hashed.plugin],
    });
    expect(built.success).toBe(true);
    const edges = [
      ...readFileSync(join(output, options.entryPath), 'utf8').matchAll(
        /require\("([^"]+\.node)"\)/g,
      ),
    ].map((match) => resolve(dirname(join(output, options.entryPath)), match[1] ?? ''));
    expect(edges).toEqual(hashed.assets.map((asset) => join(output, asset.outputPath)));
    expect(() => packaging({ ...options, assetPath: 'addons/[name].node' })).toThrow(
      'only template is [hash]',
    );
  });

  test('embedded delivery names no output path and refuses one passed anyway', () => {
    const embedded = readyEmbedded({
      platform: 'darwin',
      architecture: 'arm64',
      delivery: 'embedded',
    });
    expect(embedded.architecture).toBe('arm64');
    expect(embedded.assets).toHaveLength(1);
    expect(Object.keys(embedded.assets[0] ?? {}).sort()).toEqual(['bytes', 'sha256', 'size']);
    expect(embedded.assets[0]?.bytes).toEqual(fixtureBytes.arm64);
    expect(() =>
      packaging({
        platform: 'darwin',
        architecture: 'arm64',
        delivery: 'embedded',
        // @ts-expect-error — a standalone executable has no output layout to name.
        assetPath: 'addons/owner.node',
      }),
    ).toThrow(z.ZodError);
    // A path that reaches the call untyped is refused too, never silently ignored.
    const withPaths = { ...options, delivery: 'embedded' as const };
    expect(() => packaging(withPaths)).toThrow(z.ZodError);
    expect(
      packaging({ platform: 'darwin', architecture: 'riscv64', delivery: 'embedded' }),
    ).toEqual({
      state: 'unsupported',
      platform: 'darwin',
      architecture: 'riscv64',
      code: 'NATIVE_TARGET_UNSUPPORTED',
    });
  });

  test('embedded delivery gives Bun the verified bytes, not a second read of the file', async () => {
    const embedded = readyEmbedded({
      platform: 'darwin',
      architecture: 'arm64',
      delivery: 'embedded',
    });
    // A substitution after verification must not reach the artifact.
    replace(join(root, fixtureLayout.assets.arm64), 'substituted after verification');
    const built = await Bun.build({
      entrypoints: [join(root, 'input.js')],
      outdir: join(root, 'embedded'),
      target: 'node',
      plugins: [embedded.plugin],
    });
    expect(built.success).toBe(true);
    const addon = built.outputs.find((file) => file.path.endsWith('.node'));
    if (!addon) throw new Error('Embedded delivery did not give Bun the addon');
    expect(new Uint8Array(readFileSync(addon.path))).toEqual(fixtureBytes.arm64);
  });

  /** A second `stitchkit` installation beside the fixture, with its own default loader. */
  const foreignInstallation = (directory: string, version: string) => {
    const other = join(root, directory);
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'stitchkit', version }));
    writeFileSync(
      join(other, fixtureLayout.loader),
      nativeLoaderSource({ arm64: './assets/arm.node' }, 'beside-loader'),
    );
    const entry = join(root, `${directory}-input.js`);
    writeFileSync(
      entry,
      `export { default as load } from './${directory}/${fixtureLayout.loader}';`,
    );
    return { other, entry };
  };

  test('a loader of another installation fails the build and names both', async () => {
    const companion = ready(options);
    const embedded = readyEmbedded({
      platform: 'darwin',
      architecture: 'arm64',
      delivery: 'embedded',
    });
    for (const [directory, version] of [
      ['other-version', '9.9.9'],
      ['same-version-elsewhere', '0.0.0-test'],
    ] as const) {
      const { other, entry } = foreignInstallation(directory, version);
      for (const [plugin, extra] of [
        [companion.plugin, { naming: { entry: options.entryPath }, splitting: false }],
        [embedded.plugin, {}],
      ] as const) {
        const failure = await Bun.build({
          entrypoints: [entry],
          outdir: join(root, `foreign-${directory}`),
          target: 'node',
          plugins: [plugin],
          ...extra,
        }).then(
          () => null,
          (error: unknown) => error,
        );
        const text = String(
          failure instanceof AggregateError ? failure.errors.join('\n') : failure,
        );
        expect(text).toContain(`stitchkit 0.0.0-test (${root})`);
        expect(text).toContain(`stitchkit ${version} (${other})`);
        expect(text).toContain(
          'Call createNativePackaging from the stitchkit the entry imports',
        );
      }
    }
  });

  test('an entry of the managed file boundary and atomic writes builds with the plugin', async () => {
    writeFileSync(
      join(root, 'boundary.js'),
      `export { createManagedFileBoundary, writeFileAtomic } from '${resolve(import.meta.dir, '../src/entrypoints/files.ts')}';`,
    );
    const built = await Bun.build({
      entrypoints: [join(root, 'boundary.js')],
      outdir: join(root, 'boundary'),
      target: 'node',
      naming: { entry: options.entryPath },
      splitting: false,
      plugins: [ready(options).plugin],
    });
    expect(built.success).toBe(true);
    const [output] = built.outputs;
    if (!output) throw new Error('no output');
    expect(inspectNativeArtifact(new Uint8Array(await output.arrayBuffer()))).toBe(
      'no-loader',
    );
  });

  test('inspectNativeArtifact reads the loader an artifact carries', async () => {
    const build = async (
      name: string,
      entry: string,
      plugin?: NativePackagingResult<boolean>,
    ) => {
      const result = await Bun.build({
        entrypoints: [join(root, entry)],
        outdir: join(root, `inspect-${name}`),
        target: 'node',
        minify: name.endsWith('min'),
        ...(plugin?.state === 'ready'
          ? {
              plugins: [plugin.plugin],
              naming: { entry: options.entryPath },
              splitting: false,
            }
          : {}),
      });
      const output = result.outputs.find((file) => file.kind === 'entry-point');
      if (!output) throw new Error('no entry output');
      return new Uint8Array(await output.arrayBuffer());
    };
    writeFileSync(
      join(root, 'no-loader.js'),
      'export const value = "STITCHKIT_NATIVE_NOT_PACKAGED";',
    );
    const packaging = ready(options);
    expect(inspectNativeArtifact(await build('packaged', 'input.js', packaging))).toBe(
      'packaged',
    );
    expect(inspectNativeArtifact(await build('packaged-min', 'input.js', packaging))).toBe(
      'packaged',
    );
    expect(inspectNativeArtifact(await build('unpackaged', 'input.js'))).toBe('unpackaged');
    expect(inspectNativeArtifact(await build('unpackaged-min', 'input.js'))).toBe(
      'unpackaged',
    );
    // A compiled executable with the embedded plugin carries the plugin's loader.
    const executable = join(root, 'inspect-compiled', 'proof');
    const compiled = await Bun.build({
      entrypoints: [join(root, 'input.js')],
      compile: { outfile: executable },
      plugins: [
        readyEmbedded({ platform: 'darwin', architecture: 'arm64', delivery: 'embedded' })
          .plugin,
      ],
    });
    expect(compiled.success).toBe(true);
    expect(inspectNativeArtifact(new Uint8Array(readFileSync(executable)))).toBe('packaged');
    // Negative control: the error code alone is not a loader.
    expect(inspectNativeArtifact(await build('no-loader', 'no-loader.js'))).toBe('no-loader');
    // Bun stores source with a non-ASCII character as UTF-16; the marker is found there too.
    const utf16 = Buffer.from(`"é" ${nativeLoaderSource({}, 'beside-loader')}`, 'utf16le');
    expect(inspectNativeArtifact(new Uint8Array(utf16))).toBe('unpackaged');
  });
});
