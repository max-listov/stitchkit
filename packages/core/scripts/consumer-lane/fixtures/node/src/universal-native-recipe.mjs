import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createNativePackaging } from 'stitchkit/files/packaging';

const options = JSON.parse(Bun.argv[2]);
const outdir = Bun.argv[3];
const packaging = createNativePackaging(options);
if (packaging.state !== 'ready') throw new Error(packaging.code);
const built = await Bun.build({
  entrypoints: [join(import.meta.dirname, 'darwin-artifact-controls.mjs')],
  target: 'node',
  format: 'esm',
  minify: true,
  outdir,
  naming: { entry: options.entryPath },
  splitting: false,
  plugins: [packaging.plugin],
});
if (!built.success) throw new AggregateError(built.logs, 'Universal companion build failed');
if (built.outputs.length !== 1) throw new Error('Expected exactly one complete JS bundle');
for (const asset of packaging.assets) {
  const bytes = readFileSync(asset.sourcePath);
  if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
    throw new Error('Native asset changed during build');
  const destination = join(outdir, asset.outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(asset.sourcePath, destination);
}
console.log(
  JSON.stringify({
    version: packaging.packageVersion,
    assets: packaging.assets.map((asset) =>
      typeof options.architecture === 'string'
        ? { ...asset, architecture: options.architecture }
        : asset,
    ),
  }),
);
