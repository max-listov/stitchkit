import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { type CliBuildAsset, compareCliVersions } from '../src/entrypoints/cli';
import { collectCliBytes, decodeCliAsset } from '../src/tools/cli/publication-assets';
import { publicationFixture } from './cli-publication.fixture';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const f = await publicationFixture();
  roots.push(f.root);
  return f;
}
const host = [{ platform: process.platform, arch: process.arch }];

test('maxTargets and invalid finite limits refuse before any build', async () => {
  const f = await fixture();
  await expect(f.publish({ limits: { maxTargets: 1 } })).rejects.toThrow('target cap');
  for (const maxAssetBytes of [0, -1, 1.5, Number.NaN, Infinity])
    await expect(f.publish({ limits: { maxAssetBytes } })).rejects.toThrow();
  await expect(f.publish({ limits: { timeoutMs: 2_147_483_648 } })).rejects.toThrow();
  await expect(f.publish({ retention: 3, limits: { maxStoredVersions: 3 } })).rejects.toThrow(
    'recovery slot',
  );
  expect(f.builds).toEqual([]);
  await expect(readFile(join(f.storageRoot, 'manifest.json'))).rejects.toThrow();
  expect(
    (await f.publish({ targets: host, limits: { maxTargets: 1 } })).manifest.assets,
  ).toHaveLength(1);
});

test('maxAssetBytes accepts exact N and refuses N+1 for bytes and streams', async () => {
  for (const streamed of [false, true]) {
    const f = await fixture();
    const build = () =>
      streamed
        ? new ReadableStream<Uint8Array>({
            start(c) {
              for (let i = 0; i < 64; i++) c.enqueue(new Uint8Array([i]));
              c.close();
            },
          })
        : new Uint8Array(64);
    expect(
      (await f.publish({ targets: host, build, limits: { maxAssetBytes: 64 } })).manifest
        .assets[0]?.size,
    ).toBe(64);
    const before = await f.manifest();
    await expect(
      f.publish({
        version: '1.1.0',
        targets: host,
        build: () => new Uint8Array(65),
        limits: { maxAssetBytes: 64 },
      }),
    ).rejects.toThrow('exceeds 64');
    expect(await f.manifest()).toBe(before);
  }
});

test('maxCompressedBytes and maxManifestBytes reject before immutable commit', async () => {
  const f = await fixture();
  await expect(f.publish({ limits: { maxCompressedBytes: 1 } })).rejects.toThrow('exceeds 1');
  await expect(f.publish({ limits: { maxManifestBytes: 1 } })).rejects.toThrow(
    'manifest byte cap',
  );
  expect(await readdir(f.storageRoot)).toEqual([]);
  const first = await f.publish();
  const n = (await readFile(join(f.storageRoot, 'manifest.json'))).byteLength;
  const compressed = (await readFile(join(f.storageRoot, '1.0.0', 'app-linux-x64.gz')))
    .byteLength;
  const otherCompressed = (await readFile(join(f.storageRoot, '1.0.0', 'app-darwin-arm64.gz')))
    .byteLength;
  const maximum = Math.max(compressed, otherCompressed);
  expect((await f.publish({ limits: { maxCompressedBytes: maximum } })).manifest).toEqual(
    first.manifest,
  );
  await expect(f.publish({ limits: { maxCompressedBytes: maximum - 1 } })).rejects.toThrow(
    'exceeds',
  );
  expect((await f.publish({ limits: { maxManifestBytes: n } })).manifest).toEqual(
    first.manifest,
  );
  await expect(f.publish({ limits: { maxManifestBytes: n - 1 } })).rejects.toThrow('exceeds');
});

test('retention override keeps the requested verified history count', async () => {
  const f = await fixture();
  for (const version of ['1.0.0', '1.1.0', '1.2.0', '1.3.0'])
    await f.publish({ version, retention: 3 });
  expect((await readdir(f.storageRoot)).sort()).toEqual([
    '1.1.0',
    '1.2.0',
    '1.3.0',
    'manifest.json',
  ]);
});

test('maxDirectoryEntries bounds both version layout and root commit space', async () => {
  const f = await fixture();
  await expect(f.publish({ limits: { maxDirectoryEntries: 2 } })).rejects.toThrow('layout');
  await f.publish({ limits: { maxDirectoryEntries: 3 } });
  const before = await f.manifest();
  await mkdir(join(f.storageRoot, 'runtime'));
  await expect(
    f.publish({ version: '1.1.0', limits: { maxDirectoryEntries: 4 } }),
  ).rejects.toThrow('commit space');
  expect(await f.manifest()).toBe(before);
  expect(await readdir(f.storageRoot)).toContain('runtime');
});

test('maxStoredVersions bounds repeated committed failures and retains current and previous', async () => {
  const f = await fixture();
  const limits = { maxStoredVersions: 3 };
  await f.publish({ limits });
  await f.publish({ version: '1.1.0', limits });
  const before = await f.manifest();
  for (const version of ['1.2.0', '1.3.0', '1.4.0']) {
    await expect(
      f.publish({
        version,
        limits,
        admit({ phase }) {
          if (phase === 'promote') throw new Error('interrupted');
        },
      }),
    ).rejects.toThrow('version committed');
    const owned = (await readdir(f.storageRoot)).filter((name) => /^1\./.test(name));
    expect(owned.length).toBe(3);
    expect(owned).toContain('1.0.0');
    expect(owned).toContain('1.1.0');
    expect(await f.manifest()).toBe(before);
  }
  f.builds.length = 0;
  await f.publish({ version: '1.4.0', limits });
  expect(f.builds).toEqual([]);
  expect((await readdir(f.storageRoot)).sort()).toEqual(['1.1.0', '1.4.0', 'manifest.json']);
});

test('lockTimeoutMs refuses a waiting publisher without cancelling its holder', async () => {
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
  await expect(f.publish({ limits: { lockTimeoutMs: 20 } })).rejects.toThrow('lock');
  release.resolve();
  expect((await first).outcome).toBe('published');
});

test('timeoutMs cancels an ignored build and prevents late promotion', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<Uint8Array>();
  const pending = f.publish({
    build() {
      entered.resolve();
      return late.promise;
    },
    limits: { timeoutMs: 200 },
  });
  await entered.promise;
  await expect(pending).rejects.toThrow('exceeded 200 ms');
  late.resolve(new Uint8Array([1]));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(await readdir(f.storageRoot)).toEqual([]);
});

test('caller cancellation preserves reason identity and cancels stalled stream', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const reason = new Error('caller chose stop');
  let cancelled: unknown;
  const pending = f.publish({
    signal: controller.signal,
    build() {
      return new ReadableStream<Uint8Array>({
        pull() {
          entered.resolve();
          return new Promise(() => undefined);
        },
        cancel(value) {
          cancelled = value;
        },
      });
    },
  });
  await entered.promise;
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancelled).toBe(reason);
  expect(await readdir(f.storageRoot)).toEqual([]);
});

test('pre-aborted publication dispatches no admission or build and creates no store', async () => {
  const f = await fixture();
  const controller = new AbortController();
  const reason = new Error('stop before dispatch');
  controller.abort(reason);
  await expect(f.publish({ signal: controller.signal })).rejects.toBe(reason);
  expect(f.builds).toEqual([]);
  expect(f.admissions).toEqual([]);
  await expect(readdir(f.storageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('an ignored late stream builder is cancelled and never admitted after its deadline', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const late = Promise.withResolvers<ReadableStream<Uint8Array>>();
  let cancelled = false;
  const pending = f.publish({
    build() {
      entered.resolve();
      return late.promise;
    },
    limits: { timeoutMs: 200 },
  });
  await entered.promise;
  await expect(pending).rejects.toThrow('exceeded');
  late.resolve(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(cancelled).toBe(true);
  expect(await readdir(f.storageRoot)).toEqual([]);
});

test('deadline also bounds an infinite stream of empty immediately available chunks', async () => {
  const f = await fixture();
  let cancelled = false;
  await expect(
    f.publish({
      limits: { timeoutMs: 200 },
      build() {
        return new ReadableStream<Uint8Array>({
          pull(c) {
            c.enqueue(new Uint8Array());
          },
          cancel() {
            cancelled = true;
          },
        });
      },
    }),
  ).rejects.toThrow('exceeded');
  expect(cancelled).toBe(true);
  expect(await readdir(f.storageRoot)).toEqual([]);
});

test('bounded shared codec refuses gzip expansion, wrong size and digest with exact control', async () => {
  const bytes = new Uint8Array(4096);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const archive = gzipSync(bytes);
  const asset: Pick<CliBuildAsset, 'compression' | 'size' | 'sha256'> = {
    compression: 'gzip',
    size: bytes.length,
    sha256,
  };
  expect((await decodeCliAsset(archive, asset, bytes.length)).bytes).toEqual(bytes);
  await expect(decodeCliAsset(archive, asset, bytes.length - 1)).rejects.toThrow(
    'declared size',
  );
  await expect(decodeCliAsset(archive, { ...asset, size: 1 }, bytes.length)).rejects.toThrow(
    'exceeds 1',
  );
  await expect(
    decodeCliAsset(archive, { ...asset, size: bytes.length + 1 }, bytes.length + 1),
  ).rejects.toThrow('manifest says');
  await expect(
    decodeCliAsset(archive, { ...asset, sha256: '0'.repeat(64) }, bytes.length),
  ).rejects.toThrow('checksum');
  await expect(
    collectCliBytes(
      new ReadableStream({
        start(c) {
          c.enqueue('wrong');
          c.close();
        },
      }),
      64,
    ),
  ).rejects.toThrow('Uint8Array');
});

test('FIFO and redirected version directory refuse promptly without altering previous pointer', async () => {
  const f = await fixture();
  await f.publish();
  const before = await f.manifest();
  const asset = join(f.storageRoot, '1.0.0', 'app-linux-x64.gz');
  await unlink(asset);
  execFileSync('mkfifo', [asset]);
  await expect(f.publish({ limits: { timeoutMs: 1000 } })).rejects.toThrow('regular');
  expect(await f.manifest()).toBe(before);
  const g = await fixture();
  await g.publish();
  const pointer = await g.manifest();
  await mkdir(join(g.root, 'foreign'));
  await symlink(join(g.root, 'foreign'), join(g.storageRoot, '1.1.0'));
  await expect(g.publish({ version: '1.1.0' })).rejects.toThrow('already exists');
  expect(await g.manifest()).toBe(pointer);
  expect(await readdir(join(g.root, 'foreign'))).toEqual([]);
});

test('SemVer numeric prerelease order accepts advancing build and rejects downgrade', async () => {
  expect(compareCliVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
  expect(compareCliVersions('1.0.0-rc', '1.0.0-rc.1')).toBe(-1);
  const f = await fixture();
  await f.publish({ version: '1.0.0-rc.2' });
  await f.publish({ version: '1.0.0-rc.10' });
  await expect(f.publish({ version: '1.0.0-rc.2' })).rejects.toThrow('downgrade');
});
