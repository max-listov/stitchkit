/** A lazy, statically discoverable addon edge shared by Node and Bun consumers. */
module.exports = function loadDarwinAddon() {
  // The catch also keeps non-Darwin builds independent of unavailable slices.
  // Bun compile selects its target architecture and embeds that literal addon.
  try {
    if (process.arch === 'arm64') return require('./native/darwin-arm64.node');
    if (process.arch === 'x64') return require('./native/darwin-x64.node');
    throw new Error('Unsupported Darwin addon architecture');
  } catch (cause) {
    throw new Error('Darwin addon loading failed', { cause });
  }
};
