import {
  createNativePackaging,
  type NativePackagingAsset,
  type NativePackagingOptions,
  type NativePackagingPlugin,
  type NativePackagingResult,
} from 'stitchkit/files/packaging';

const options: NativePackagingOptions = {
  platform: 'darwin',
  architecture: 'arm64',
  delivery: 'companion',
  entryPath: 'app/main.js',
  assetPath: 'addons/owner.node',
};
const result: NativePackagingResult = createNativePackaging(options);
if (result.state === 'ready') {
  const assets: NativePackagingAsset[] = result.assets;
  const plugin: NativePackagingPlugin = result.plugin;
  void assets;
  void plugin;
} else {
  const code: 'NATIVE_TARGET_UNSUPPORTED' | 'NATIVE_ASSET_MISSING' = result.code;
  void code;
}
// @ts-expect-error — delivery is a closed protocol, no ambient Bun types are needed.
createNativePackaging({ ...options, delivery: 'single-js' });
