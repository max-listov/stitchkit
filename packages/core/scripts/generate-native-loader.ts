import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { NativeLayoutSchema, nativeLoaderSource } from '../src/files/native-packaging-layout';

const root = resolve(import.meta.dir, '..');
const layout = NativeLayoutSchema.parse(
  JSON.parse(readFileSync(resolve(root, 'native-assets.json'), 'utf8')),
);
const loader = resolve(root, layout.loader);
const assets = Object.fromEntries(
  Object.entries(layout.assets).map(([arch, asset]) => {
    const specifier = relative(dirname(loader), resolve(root, asset)).split('\\').join('/');
    return [arch, specifier.startsWith('.') ? specifier : `./${specifier}`];
  }),
);
const contents = nativeLoaderSource(assets);
if (!existsSync(loader) || readFileSync(loader, 'utf8') !== contents)
  writeFileSync(loader, contents);
