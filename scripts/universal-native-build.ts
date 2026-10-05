import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  NativeAssetManifestSchema,
  nativeLoaderSource,
} from '../packages/core/src/files/native-packaging-layout';
import {
  assertIsolated,
  fileDigest,
  run,
  type UniversalManifest,
  UniversalManifestSchema,
} from './universal-native-contract';

const repository = resolve(import.meta.dir, '..');
const core = join(repository, 'packages/core');
const output = resolve(Bun.argv[2] ?? '');
if (!Bun.argv[2]) throw new Error('Universal archive output directory is required');
const scratch = mkdtempSync(join(tmpdir(), 'stitchkit-universal-build-'));
const fixture = join(scratch, 'consumer');
const materialized = join(scratch, 'materialized');
mkdirSync(fixture);
mkdirSync(materialized);
try {
  run(
    'bun',
    [
      '../../scripts/package-build-lock.ts',
      '--',
      'bun',
      'pm',
      'pack',
      '--destination',
      scratch,
    ],
    core,
  );
  const version = z
    .object({ version: z.string() })
    .parse(JSON.parse(readFileSync(join(core, 'package.json'), 'utf8'))).version;
  const tarball = join(scratch, `stitchkit-${version}.tgz`);
  assert.ok(existsSync(tarball));
  const fixtureManifest = JSON.parse(
    readFileSync(join(core, 'scripts/consumer-lane/fixtures/node/package.json'), 'utf8'),
  );
  fixtureManifest.dependencies.stitchkit = `file:${tarball}`;
  writeFileSync(join(fixture, 'package.json'), JSON.stringify(fixtureManifest));
  run('bun', ['install', '--no-save', '--ignore-scripts'], fixture);
  for (const file of [
    'darwin-artifact-controls.mjs',
    'contained-files.mjs',
    'universal-native-recipe.mjs',
  ])
    copyFileSync(
      join(core, 'scripts/consumer-lane/fixtures/node/src', file),
      join(fixture, file),
    );
  const packageRoot = join(fixture, 'node_modules/stitchkit');
  const metadataPath = join(packageRoot, 'native-assets.json');
  const published = NativeAssetManifestSchema.parse(
    JSON.parse(readFileSync(metadataPath, 'utf8')),
  );
  for (const architecture of ['arm64', 'x64'] satisfies Array<'arm64' | 'x64'>)
    assert.ok(
      published.assets[architecture],
      `Packed manifest lacks the ${architecture} digest`,
    );
  const artifacts: UniversalManifest['artifacts'] = [];
  async function build(
    mode: UniversalManifest['artifacts'][number]['mode'],
    architecture: 'arm64' | 'x64' | ['arm64', 'x64'],
  ) {
    const multiple = Array.isArray(architecture);
    const options = multiple
      ? {
          platform: 'darwin',
          architecture,
          delivery: 'companion',
          entryPath: 'app/proof.js',
          assetPath: { arm64: 'addons/arm.node', x64: 'addons/intel.node' },
        }
      : {
          platform: 'darwin',
          architecture,
          delivery: 'companion',
          entryPath: 'app/proof.js',
          assetPath: 'addons/owner.node',
        };
    const directory = join(materialized, mode);
    const packaging = z
      .object({
        version: z.string(),
        assets: z.array(
          z.object({
            outputPath: z.string(),
            size: z.number(),
            sha256: z.string(),
            architecture: z.enum(['arm64', 'x64']),
          }),
        ),
      })
      .parse(
        JSON.parse(
          run(
            'bun',
            [join(fixture, 'universal-native-recipe.mjs'), JSON.stringify(options), directory],
            fixture,
          ),
        ),
      );
    assert.equal(packaging.version, version);
    const files: UniversalManifest['artifacts'][number]['files'] = [
      { path: 'app/proof.js', sha256: fileDigest(join(directory, 'app/proof.js')) },
    ];
    for (const asset of packaging.assets) {
      // The digest is the one the package published at build time, not one of the local file.
      assert.equal(asset.sha256, published.assets[asset.architecture]?.sha256);
      assert.equal(fileDigest(join(directory, asset.outputPath)), asset.sha256);
      files.push({
        path: asset.outputPath,
        sha256: asset.sha256,
        architecture: asset.architecture,
      });
    }
    artifacts.push({
      mode,
      entryPath: 'app/proof.js',
      architectures: multiple ? architecture : [architecture],
      files,
    });
  }
  await build('universal', ['arm64', 'x64']);
  await build('single-arm64', 'arm64');
  await build('single-x64', 'x64');
  // One changed byte of an installed addon refuses packaging; the file is replaced, never
  // rewritten in place, so a shared Bun-cache inode is not touched.
  const arm = published.assets.arm64;
  assert.ok(arm);
  const armPath = join(packageRoot, arm.path);
  const original = readFileSync(armPath);
  const tampered = Buffer.from(original);
  tampered[0] = (tampered[0] ?? 0) ^ 0xff;
  rmSync(armPath);
  writeFileSync(armPath, tampered);
  assert.throws(
    () =>
      run(
        'bun',
        [
          join(fixture, 'universal-native-recipe.mjs'),
          JSON.stringify({
            platform: 'darwin',
            architecture: 'arm64',
            delivery: 'companion',
            entryPath: 'app/proof.js',
            assetPath: 'addons/owner.node',
          }),
          join(scratch, 'tampered'),
        ],
        fixture,
      ),
    /NATIVE_ASSET_DIGEST_MISMATCH/,
  );
  rmSync(armPath);
  writeFileSync(armPath, original);
  // Owning fault injection changes metadata, imports and assets; consumer recipe stays identical.
  const renamed = {
    ...published,
    loader: 'qualified/loader.cjs',
    assets: Object.fromEntries(
      (['arm64', 'x64'] satisfies Array<'arm64' | 'x64'>).map((architecture) => {
        const entry = published.assets[architecture];
        assert.ok(entry);
        const path = architecture === 'arm64' ? 'qualified/a.node' : 'qualified/b.node';
        return [architecture, { ...entry, path }];
      }),
    ),
  };
  mkdirSync(join(packageRoot, 'qualified'));
  for (const architecture of ['arm64', 'x64'] satisfies Array<'arm64' | 'x64'>) {
    const from = published.assets[architecture]?.path;
    const to = renamed.assets[architecture]?.path;
    assert.ok(from && to);
    renameSync(join(packageRoot, from), join(packageRoot, to));
  }
  rmSync(join(packageRoot, published.loader));
  writeFileSync(
    join(packageRoot, renamed.loader),
    nativeLoaderSource({ arm64: './a.node', x64: './b.node' }, 'beside-loader'),
  );
  rmSync(metadataPath);
  writeFileSync(metadataPath, JSON.stringify(renamed));
  const manifestPath = join(packageRoot, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.imports['#stitchkit-darwin-native'] = `./${renamed.loader}`;
  // Replace the manifest inode, never a shared Bun-cache inode.
  rmSync(manifestPath);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await build('renamed', ['arm64', 'x64']);
  const proof = UniversalManifestSchema.parse({ version, artifacts });
  assert.equal(
    proof.artifacts.find((artifact) => artifact.mode === 'renamed')?.files[0]?.sha256,
    proof.artifacts.find((artifact) => artifact.mode === 'universal')?.files[0]?.sha256,
    'Owning private layout changes preserve consumer JS bytes',
  );
  writeFileSync(join(materialized, 'manifest.json'), JSON.stringify(proof, null, 2));
  mkdirSync(output, { recursive: true });
  const archive = join(output, 'universal-native.tar');
  run('tar', ['-cf', archive, '-C', materialized, '.'], scratch);
  rmSync(materialized, { recursive: true });
  rmSync(fixture, { recursive: true });
  const relocated = join(scratch, 'offline');
  mkdirSync(relocated);
  assertIsolated(relocated);
  run('tar', ['-xf', archive, '-C', relocated], scratch);
  for (const artifact of proof.artifacts) {
    for (const file of artifact.files)
      assert.equal(fileDigest(join(relocated, artifact.mode, file.path)), file.sha256);
    if (process.platform === 'linux') {
      for (const file of artifact.files)
        if (file.architecture) rmSync(join(relocated, artifact.mode, file.path));
      for (const runtime of ['bun', 'node']) {
        const args = [
          ...(runtime === 'bun' ? ['--no-install'] : []),
          join(relocated, artifact.mode, artifact.entryPath),
          '--expect-linux',
        ];
        assert.ok(
          run(runtime, args, relocated)
            .split(/\r?\n/)
            .includes('Universal artifact Linux without Darwin addons: ok'),
        );
      }
    }
  }
  console.log(
    JSON.stringify({
      version,
      archiveSha256: fileDigest(archive),
      jsSha256: proof.artifacts.map((artifact) => ({
        mode: artifact.mode,
        sha256: artifact.files[0]?.sha256,
      })),
    }),
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
