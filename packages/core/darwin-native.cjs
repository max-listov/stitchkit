/** Generated from the owning native asset graph. Loading remains lazy. */
module.exports = function loadDarwinAddon() {
  try {
    if (process.arch === 'arm64') return require('./native/darwin-arm64.node');
    if (process.arch === 'x64') return require('./native/darwin-x64.node');
    throw new Error('Unsupported Darwin addon architecture');
  } catch (cause) {
    throw new Error('Darwin addon loading failed', { cause });
  }
};
