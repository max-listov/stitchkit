/** Generated from the owning native asset graph. Loading remains lazy. */
// The addon path is computed from this file's own location, so a bundler never follows
// or embeds it and the build machine never becomes a literal of the artifact. Inside a
// bundle the file has no location (`module.filename` is not absolute there): loading
// refuses and names the packaging plugin, which replaces this file with a static loader
// when an artifact must carry the addon.
module.exports = function loadDarwinAddon() {
  const location = module.filename;
  if (typeof location !== 'string' || !location.startsWith('/')) {
    const refusal = new Error(
      'The Darwin addon is not packaged into this bundle: build it with createNativePackaging from stitchkit/files/packaging',
    );
    refusal.code = 'STITCHKIT_NATIVE_NOT_PACKAGED';
    throw refusal;
  }
  const directory = location.slice(0, location.lastIndexOf('/'));
  try {
    if (process.arch === 'arm64') return require(`${directory}/native/darwin-arm64.node`);
    if (process.arch === 'x64') return require(`${directory}/native/darwin-x64.node`);
    throw new Error('Unsupported Darwin addon architecture');
  } catch (cause) {
    throw new Error('Darwin addon loading failed', { cause });
  }
};
module.exports.stitchkitNativeLoader = 'stitchkit-native-loader:unpackaged';
