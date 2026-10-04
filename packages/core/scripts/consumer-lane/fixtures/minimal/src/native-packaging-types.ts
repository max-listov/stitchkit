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
  const architecture: 'arm64' | 'x64' = result.architecture;
  void architecture;
  void assets;
  void plugin;
} else {
  const code: 'NATIVE_TARGET_UNSUPPORTED' | 'NATIVE_ASSET_MISSING' = result.code;
  void code;
}
// @ts-expect-error — delivery is a closed protocol, no ambient Bun types are needed.
createNativePackaging({ ...options, delivery: 'single-js' });

const universalOptions: NativePackagingOptions<true> = {
  ...options,
  delivery: 'companion',
  architecture: ['arm64', 'x64'],
  assetPath: { arm64: 'addons/arm.node', x64: 'addons/intel.node' },
};
const universal: NativePackagingResult<true> = createNativePackaging(universalOptions);
if (universal.state === 'ready') {
  const architectures: ('arm64' | 'x64')[] = universal.architecture;
  const assets: NativePackagingAsset<true>[] = universal.assets;
  for (const asset of assets) {
    const architecture: 'arm64' | 'x64' = asset.architecture;
    void architecture;
  }
  void architectures;
}
// @ts-expect-error — embedded compile accepts exactly one target.
createNativePackaging({ ...universalOptions, delivery: 'embedded' });
