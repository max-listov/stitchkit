/** Generated from the owning native asset graph. Loading remains lazy. */
// The addon path is computed, so a bundler never follows or embeds it. A packaging
// plugin replaces this file with a static loader when an artifact must carry the addon.
module.exports = function loadDarwinAddon() {
  try {
    if (process.arch === 'arm64') return require(`${__dirname}/native/darwin-arm64.node`);
    if (process.arch === 'x64') return require(`${__dirname}/native/darwin-x64.node`);
    throw new Error('Unsupported Darwin addon architecture');
  } catch (cause) {
    throw new Error('Darwin addon loading failed', { cause });
  }
};
