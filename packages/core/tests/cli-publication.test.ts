import { afterEach, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  link,
  mkdir,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { verifyCliManifest } from '../src/entrypoints/cli';
import { publicationFixture } from './cli-publication.fixture';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const value = await publicationFixture();
  roots.push(value.root);
  return value;
}

test('publication builds all targets with one stamp and promotes manifest last', async () => {
  const f = await fixture();
  const result = await f.publish({
    build(input) {
      expect(f.admissions.at(-1)).toBe('build');
      expect(Object.isFrozen(input.target)).toBe(true);
      expect(Object.isFrozen(input.stamp)).toBe(true);
      return f.options.build(input);
    },
  });
  expect(result.outcome).toBe('published');
  expect(f.builds).toEqual(['linux-x64', 'darwin-arm64']);
  for (const asset of result.manifest.assets) {
    const binary = JSON.parse(
      gunzipSync(
        await readFile(join(f.storageRoot, '1.0.0', `app-${asset.platform}-${asset.arch}.gz`)),
      ).toString(),
    );
    expect(binary.stamp).toEqual({
      version: '1.0.0',
      commit: f.options.commit,
      builtAt: result.manifest.builtAt,
    });
  }
  expect(JSON.parse(await f.manifest())).toEqual(result.manifest);
});

test('verified repeat preserves exact bytes and builtAt and never rebuilds', async () => {
  const f = await fixture();
  const first = await f.publish();
  const before = await f.manifest();
  const asset = await readFile(join(f.storageRoot, '1.0.0', 'app-linux-x64.gz'));
  f.builds.length = 0;
  expect(await f.publish()).toEqual({ outcome: 'existing', manifest: first.manifest });
  expect(f.builds).toEqual([]);
  expect(await f.manifest()).toBe(before);
  expect(await readFile(join(f.storageRoot, '1.0.0', 'app-linux-x64.gz'))).toEqual(asset);
});

test('same-version conflict, target mismatch and downgrade refuse before build', async () => {
  const f = await fixture();
  await f.publish();
  f.builds.length = 0;
  await expect(f.publish({ commit: 'b'.repeat(40) })).rejects.toThrow('bump the version');
  await expect(f.publish({ targets: [{ platform: 'linux', arch: 'x64' }] })).rejects.toThrow(
    'target set',
  );
  await expect(f.publish({ version: '0.9.0' })).rejects.toThrow('downgrade');
  await expect(f.publish({ baseUrl: 'https://other.invalid/cli/' })).rejects.toThrow(
    'asset URL',
  );
  await expect(f.publish({ name: 'other' })).rejects.toThrow('belongs to another');
  expect(f.builds).toEqual([]);
});

test('second target failure preserves previous assets and removes incomplete staging', async () => {
  const f = await fixture();
  await f.publish();
  const before = await f.manifest();
  await expect(
    f.publish({
      version: '1.1.0',
      build(input) {
        if (input.target.platform === 'darwin') throw new Error('compiler refused');
        return f.options.build(input);
      },
    }),
  ).rejects.toThrow('compiler refused');
  expect(await f.manifest()).toBe(before);
  expect((await readdir(f.storageRoot)).sort()).toEqual(['1.0.0', 'manifest.json']);
});

test('source drift refuses before immutable commit; postcommit fault recovers without build', async () => {
  const f = await fixture();
  await f.publish();
  const before = await f.manifest();
  await expect(
    f.publish({
      version: '1.1.0',
      admit({ phase }) {
        if (phase === 'commit') throw new Error('source changed');
      },
    }),
  ).rejects.toThrow('source changed');
  expect(await f.manifest()).toBe(before);
  await expect(
    f.publish({
      version: '1.1.0',
      admit({ phase }) {
        if (phase === 'promote') throw new Error('pointer fault');
      },
    }),
  ).rejects.toThrow('version committed');
  expect(await f.manifest()).toBe(before);
  const completed = await readFile(join(f.storageRoot, '1.1.0', 'manifest.json'), 'utf8');
  f.builds.length = 0;
  const recovered = await f.publish({ version: '1.1.0' });
  expect(recovered.outcome).toBe('published');
  expect(f.builds).toEqual([]);
  expect(await f.manifest()).toBe(completed);
});

test('corrupt public manifest and corrupt saved asset refuse without a replacement build', async () => {
  const f = await fixture();
  await f.publish();
  const original = await f.manifest();
  f.builds.length = 0;
  await writeFile(join(f.storageRoot, 'manifest.json'), '{broken');
  await expect(f.publish()).rejects.toThrow();
  expect(f.builds).toEqual([]);
  await writeFile(join(f.storageRoot, 'manifest.json'), original);
  await writeFile(join(f.storageRoot, '1.0.0', 'app-linux-x64.gz'), 'not gzip');
  await expect(f.publish()).rejects.toThrow();
  expect(f.builds).toEqual([]);
  expect(await f.manifest()).toBe(original);
});

test('retention removes only verified owned versions and keeps foreign/runtime directories', async () => {
  const f = await fixture();
  await f.publish();
  await mkdir(join(f.storageRoot, '0.0.1'));
  await mkdir(join(f.storageRoot, 'runtime'));
  await f.publish({ version: '1.1.0' });
  await f.publish({ version: '1.2.0' });
  expect((await readdir(f.storageRoot)).sort()).toEqual([
    '0.0.1',
    '1.1.0',
    '1.2.0',
    'manifest.json',
    'runtime',
  ]);
});

test('real exclusive lock serializes publishers and the waiter uses the completed version', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const first = f.publish({
    async build(input) {
      entered.resolve();
      await release.promise;
      return f.options.build(input);
    },
  });
  await entered.promise;
  let secondBuilds = 0;
  const second = f.publish({
    build() {
      secondBuilds += 1;
      throw new Error('unexpected rebuild');
    },
  });
  release.resolve();
  const [a, b] = await Promise.all([first, second]);
  expect(a.outcome).toBe('published');
  expect(b.outcome).toBe('existing');
  expect(secondBuilds).toBe(0);
});

test('replaced lock and changed public pointer refuse promotion', async () => {
  const f = await fixture();
  await f.publish();
  const before = await f.manifest();
  await expect(
    f.publish({
      version: '1.1.0',
      async build(input) {
        const path = join(f.storageRoot, '.publication.lock');
        await unlink(path);
        await writeFile(path, '{"pid":1,"token":"replacement"}');
        return f.options.build(input);
      },
    }),
  ).rejects.toThrow('held lock');
  expect(await f.manifest()).toBe(before);
  await unlink(join(f.storageRoot, '.publication.lock'));
  const newer = `${JSON.stringify({ ...JSON.parse(before), commit: 'newer' })}\n`;
  await expect(
    f.publish({
      version: '1.1.0',
      async admit({ phase }) {
        if (phase === 'commit') await writeFile(join(f.storageRoot, 'manifest.json'), newer);
      },
    }),
  ).rejects.toThrow('manifest changed');
  expect(await f.manifest()).toBe(newer);
});

test('signed publication preserves the existing signature contract and refuses wrong trust', async () => {
  const f = await fixture();
  const keys = generateKeyPairSync('ed25519');
  const trust = {
    keys: { release: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
  const signing = {
    keyId: 'release',
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  const published = await f.publish({ trust, signing });
  expect(verifyCliManifest(published.manifest, published.manifest.signature, trust)).toBe(
    'valid',
  );
  await expect(f.publish({ trust: { keys: { other: trust.keys.release } } })).rejects.toThrow(
    'unknown-key',
  );
});

test('symlink and hardlink assets are refused without reading or overwriting foreign bytes', async () => {
  for (const kind of ['symlink', 'hardlink']) {
    const f = await fixture();
    await f.publish();
    const asset = join(f.storageRoot, '1.0.0', 'app-linux-x64.gz');
    const other = join(f.root, 'foreign');
    await writeFile(other, 'foreign unchanged');
    await unlink(asset);
    if (kind === 'symlink') await symlink(other, asset);
    else await link(other, asset);
    await expect(f.publish()).rejects.toThrow();
    expect(await readFile(other, 'utf8')).toBe('foreign unchanged');
  }
});

test('publisher refuses a linked storage root and unsafe version/name/target values', async () => {
  const f = await fixture();
  await mkdir(f.storageRoot);
  const linked = join(f.root, 'linked');
  await symlink(f.storageRoot, linked);
  await expect(f.publish({ storageRoot: linked })).rejects.toThrow('directory');
  const credentialUrl = new URL('https://distribution.invalid/cli/');
  credentialUrl.username = 'fixture-user';
  credentialUrl.password = 'fixture-password';
  for (const patch of [
    { version: '../escape' },
    { name: '../escape' },
    { storageRoot: 'relative' },
    { baseUrl: 'file:///tmp/assets' },
    { baseUrl: credentialUrl.href },
    { baseUrl: 'https://distribution.invalid/cli/?query' },
    { targets: [{ platform: '../escape', arch: 'x64' }] },
    {
      targets: [
        { platform: 'linux', arch: 'x64' },
        { platform: 'linux', arch: 'x64' },
      ],
    },
  ])
    await expect(f.publish(patch)).rejects.toThrow();
});
