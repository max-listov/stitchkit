import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  type NativeAssetManifest,
  NativeAssetManifestSchema,
  NativeLayoutSchema,
  nativeAssetDigest,
  nativeLoaderSource,
} from '../src/files/native-packaging-layout';

// Build step: the source layout yields the default loader and the published manifest. The
// manifest records the size and SHA256 of every addon present now, so a release packed after
// the Darwin addons are in place publishes the digests of exactly the bytes it ships.
const root = resolve(import.meta.dir, '..');
const layout = NativeLayoutSchema.parse(
  JSON.parse(readFileSync(resolve(root, 'native-layout.json'), 'utf8')),
);
const loader = resolve(root, layout.loader);
const specifiers = Object.fromEntries(
  Object.entries(layout.assets).map(([arch, asset]) => {
    const specifier = relative(dirname(loader), resolve(root, asset)).split('\\').join('/');
    return [arch, specifier.startsWith('.') ? specifier : `./${specifier}`];
  }),
);

function writeIfChanged(path: string, contents: string): void {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== contents)
    writeFileSync(path, contents);
}

function publishedEntry(path: string): NativeAssetManifest['assets']['arm64'] {
  const file = resolve(root, path);
  return existsSync(file) ? { path, ...nativeAssetDigest(readFileSync(file)) } : undefined;
}

const manifest = NativeAssetManifestSchema.parse({
  formatVersion: 2,
  loader: layout.loader,
  assets: {
    arm64: publishedEntry(layout.assets.arm64),
    x64: publishedEntry(layout.assets.x64),
  },
});
writeIfChanged(loader, nativeLoaderSource(specifiers, 'beside-loader'));
writeIfChanged(resolve(root, 'native-assets.json'), `${JSON.stringify(manifest, null, 2)}\n`);
