import { mkdirSync, writeFileSync } from 'node:fs';
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
// The bytes were checked against the published digest; they are written, never read again.
for (const asset of packaging.assets) {
  const destination = join(outdir, asset.outputPath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, asset.bytes);
}
console.log(
  JSON.stringify({
    version: packaging.packageVersion,
    assets: packaging.assets.map(({ bytes: _bytes, ...asset }) =>
      typeof options.architecture === 'string'
        ? { ...asset, architecture: options.architecture }
        : asset,
    ),
  }),
);
