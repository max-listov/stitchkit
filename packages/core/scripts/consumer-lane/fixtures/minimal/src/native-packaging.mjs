import assert from 'node:assert/strict';
import { createNativePackaging } from 'stitchkit/files/packaging';

const options = {
  platform: 'darwin',
  architecture: process.arch,
  delivery: 'companion',
  entryPath: 'app/proof.js',
  assetPath: 'addons/owner.node',
};
// A platform without native addons is refused by the schema, before any target is resolved.
assert.throws(() => createNativePackaging({ ...options, platform: 'linux' }), /platform/);
assert.deepEqual(createNativePackaging({ ...options, architecture: 'invalid' }), {
  state: 'unsupported',
  platform: 'darwin',
  architecture: 'invalid',
  code: 'NATIVE_TARGET_UNSUPPORTED',
});
assert.throws(
  () => createNativePackaging({ ...options, assetPath: '../owner.node' }),
  /relative path without traversal/,
);
assert.throws(
  () => createNativePackaging({ ...options, entryPath: '[dir]/proof.js' }),
  /fixed entry path/,
);
for (const assetPath of ['app/proof.js/owner.node', 'app']) {
  assert.throws(
    () => createNativePackaging({ ...options, assetPath }),
    /non-overlapping paths/,
  );
}
const selected = createNativePackaging(options);
if (selected.state === 'ready') {
  assert.equal(selected.assets.length, 1);
  assert.match(selected.assets[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(selected.assets[0].bytes.byteLength, selected.assets[0].size);
  assert.equal(selected.assets[0].outputPath, 'addons/owner.node');
} else assert.equal(selected.code, 'NATIVE_ASSET_MISSING');
console.log('packed build-only native packaging: ok');
