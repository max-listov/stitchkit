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
  for (const asset of assets) {
    const verified: { bytes: Uint8Array; size: number; sha256: string; outputPath: string } =
      asset;
    void verified;
    // @ts-expect-error — the source path is not exposed; consumers write the verified bytes.
    void asset.sourcePath;
  }
  void architecture;
  void plugin;
} else {
  const code:
    | 'NATIVE_TARGET_UNSUPPORTED'
    | 'NATIVE_ASSET_MISSING'
    | 'NATIVE_ASSET_DIGEST_MISMATCH' = result.code;
  const state: 'unsupported' | 'missing' | 'mismatch' = result.state;
  const platform: 'darwin' = result.platform;
  if (result.state === 'mismatch') {
    const digests: {
      expected: { size: number; sha256: string };
      actual: { size: number; sha256: string };
    } = result;
    void digests;
  }
  void code;
  void state;
  void platform;
}
// @ts-expect-error — delivery is a closed protocol, no ambient Bun types are needed.
createNativePackaging({ ...options, delivery: 'single-js' });
// @ts-expect-error — platform is the closed set of platforms with native addons.
createNativePackaging({ ...options, platform: 'linux' });

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
