import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyCliUpdate,
  checkCliUpdate,
  publishCli,
  renderCliInstaller,
  rollbackCliUpdate,
  verifyCliManifest,
} from 'stitchkit/cli';
import { assertBinary, distributionServer, execute } from './cli-publication-support.mjs';

const require = createRequire(import.meta.url);
for (const peer of ['ai', '@modelcontextprotocol/server']) {
  assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' });
}

assert.ok(
  ['linux', 'darwin'].includes(process.platform),
  'compiled publisher proof needs a POSIX directory durability host',
);
const root = await mkdtemp(join(tmpdir(), 'stitchkit-packed-publication-'));
const storageRoot = join(root, 'distribution');
const server = await distributionServer(storageRoot);
const keys = generateKeyPairSync('ed25519');
const trust = {
  keys: { release: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString() },
};
const signing = {
  keyId: 'release',
  privateKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
};
const source = fileURLToPath(new URL('./cli-publication-binary.ts', import.meta.url));
const installDir = join(root, 'installed');
const binary = join(installDir, 'publisher-proof');
let builds = 0;
let admittedIdentity;
const publish = (version, commit, overrides = {}) =>
  publishCli({
    name: 'publisher-proof',
    version,
    commit,
    storageRoot,
    baseUrl: server.baseUrl,
    targets: [{ platform: process.platform, arch: process.arch }],
    signing,
    trust,
    admit({ identity }) {
      // The application selects and admits the CLI identity, independently of its backend's release commit.
      assert.deepEqual(identity, admittedIdentity);
    },
    async build({ stamp, signal }) {
      builds++;
      const output = join(root, `compiled-${version}`);
      await execute(
        'bun',
        [
          'build',
          source,
          '--compile',
          '--outfile',
          output,
          '--define',
          `PUBLICATION_STAMP=${JSON.stringify(stamp)}`,
        ],
        { signal },
      );
      await assertBinary(output, stamp);
      return new Uint8Array(await readFile(output));
    },
    ...overrides,
  });

try {
  const commit = 'a'.repeat(40);
  admittedIdentity = { name: 'publisher-proof', version: '1.0.0', commit };
  const first = await publish('1.0.0', commit);
  assert.equal(first.outcome, 'published');
  assert.equal(builds, 1);
  assert.equal(verifyCliManifest(first.manifest, first.manifest.signature, trust), 'valid');
  const prior = await readFile(join(storageRoot, 'manifest.json'));
  const installer = join(root, 'install.sh');
  await writeFile(installer, renderCliInstaller({ manifest: first.manifest }));
  await execute('sh', [installer], { env: { ...process.env, INSTALL_DIR: installDir } });
  const firstStamp = {
    version: first.manifest.version,
    commit: first.manifest.commit,
    builtAt: first.manifest.builtAt,
  };
  await assertBinary(binary, firstStamp);
  const installedFirst = await readFile(binary);
  await publish('1.0.0', commit);
  assert.equal(builds, 1);
  assert.deepEqual(await readFile(join(storageRoot, 'manifest.json')), prior);
  await assert.rejects(
    publish('1.0.0', 'b'.repeat(40), { admit: () => undefined }),
    /bump the version/,
  );

  // The shell installer proves decompressed digest and size. Authorship is checked by the updater below.
  server.corrupt(true);
  await assert.rejects(
    execute('sh', [installer], { env: { ...process.env, INSTALL_DIR: installDir } }),
    (error) => /checksum mismatch/.test(error.stderr),
  );
  assert.deepEqual(await readFile(binary), installedFirst);
  server.corrupt(false);
  const wrongSize = {
    ...first.manifest,
    assets: first.manifest.assets.map((asset) => ({ ...asset, size: asset.size + 1 })),
  };
  await writeFile(installer, renderCliInstaller({ manifest: wrongSize }));
  await assert.rejects(
    execute('sh', [installer], { env: { ...process.env, INSTALL_DIR: installDir } }),
    (error) => /size mismatch/.test(error.stderr),
  );
  assert.deepEqual(await readFile(binary), installedFirst);

  const nextCommit = 'b'.repeat(40);
  admittedIdentity = { name: 'publisher-proof', version: '1.1.0', commit: nextCommit };
  await assert.rejects(
    publish('1.1.0', nextCommit, {
      admit({ phase, identity }) {
        assert.deepEqual(identity, admittedIdentity);
        if (phase === 'promote') throw new Error('bounded interruption');
      },
    }),
    /version committed/,
  );
  assert.deepEqual(await readFile(join(storageRoot, 'manifest.json')), prior);
  const completed = await readFile(join(storageRoot, '1.1.0', 'manifest.json'));
  const second = await publish('1.1.0', nextCommit);
  assert.equal(builds, 2);
  assert.deepEqual(await readFile(join(storageRoot, 'manifest.json')), completed);
  const current = await checkCliUpdate({
    manifestUrl: `${server.baseUrl}manifest.json`,
    currentVersion: '1.0.0',
    trust,
    allowPrivateHosts: true,
  });
  assert.equal(current.status, 'outdated');
  assert.equal(current.signature, 'valid');
  server.manifest({ ...second.manifest, commit: 'tampered' });
  const altered = await checkCliUpdate({
    manifestUrl: `${server.baseUrl}manifest.json`,
    currentVersion: '1.0.0',
    trust,
    allowPrivateHosts: true,
  });
  assert.equal(altered.status, 'unknown');
  assert.match(altered.reason, /signature: invalid/);
  server.manifest(undefined);
  const asset = second.manifest.assets[0];
  assert.ok(asset);
  const requests = server.assetRequests;
  await assert.rejects(
    applyCliUpdate({
      asset,
      manifest: second.manifest,
      trust: { keys: { unknown: trust.keys.release } },
      targetPath: binary,
      allowPrivateHosts: true,
    }),
    /unknown-key/,
  );
  assert.equal(server.assetRequests, requests);
  assert.deepEqual(await readFile(binary), installedFirst);
  server.corrupt(true);
  await assert.rejects(
    applyCliUpdate({
      asset,
      manifest: second.manifest,
      trust,
      targetPath: binary,
      allowPrivateHosts: true,
    }),
    /manifest says|checksum/,
  );
  assert.deepEqual(await readFile(binary), installedFirst);
  server.corrupt(false);
  const secondStamp = {
    version: second.manifest.version,
    commit: second.manifest.commit,
    builtAt: second.manifest.builtAt,
  };
  const backupPath = join(root, 'previous');
  const applied = await applyCliUpdate({
    asset,
    manifest: second.manifest,
    trust,
    targetPath: binary,
    backupPath,
    allowPrivateHosts: true,
    verify: (candidate) => assertBinary(candidate, secondStamp),
  });
  await assertBinary(binary, secondStamp);
  assert.ok(applied.backupSha256);
  await assert.rejects(
    Promise.resolve().then(() =>
      rollbackCliUpdate({ targetPath: binary, backupPath, expectedSha256: '0'.repeat(64) }),
    ),
    /does not match/,
  );
  await assertBinary(binary, secondStamp);
  rollbackCliUpdate({ targetPath: binary, backupPath, expectedSha256: applied.backupSha256 });
  await assertBinary(binary, firstStamp);
  assert.deepEqual((await readdir(storageRoot)).sort(), ['1.0.0', '1.1.0', 'manifest.json']);
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}
console.log('packed CLI publication: ok');
