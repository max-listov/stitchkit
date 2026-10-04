import { createHash } from 'node:crypto';
import { lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createManagedFileBoundary } from '../../files/boundary';
import { writeFileAtomic } from '../../internal/atomic-file';
import { AtomicFilePublicationError } from '../../internal/atomic-publication';
import { type ExclusiveLock, withExclusiveLock } from '../../internal/with-exclusive-lock';
import {
  assertCliPublishable,
  type CliBuildManifest,
  CliBuildManifestSchema,
  type CliBuildStamp,
} from './manifest';
import { collectCliBytes, gzipCliAsset } from './publication-assets';
import {
  assetFilename,
  assetUrl,
  type CliPublicationOptions,
  type CliPublicationPhase,
  type PublicationData,
  publicationData,
} from './publication-contract';
import { waitForPublication, withPublicationDeadline } from './publication-control';
import {
  assertDirectory,
  bindPublicationStorage,
  directoryGeneration,
  directoryNames,
  type OwnedVersion,
  type PublicationManifest,
  type PublicationStorage,
  publicationHistory,
  readPublicationManifest,
  removePublicationVersion,
  syncPublicationDirectory,
  verifyPublicationVersion,
} from './publication-storage';
import { cliSignatureAccepted, signCliManifest, verifyCliManifest } from './signature';
import { compareCliVersions } from './update';

export type { CliPublicationOptions, CliPublicationPhase } from './publication-contract';

const resultSchema = z.object({
  outcome: z.enum(['published', 'existing']),
  manifest: CliBuildManifestSchema,
});
export type CliPublicationResult = z.infer<typeof resultSchema>;

function trustPublication(manifest: CliBuildManifest, options: CliPublicationOptions): void {
  const verdict = verifyCliManifest(manifest, manifest.signature, options.trust);
  if (!cliSignatureAccepted(verdict))
    throw new Error(`CLI publication manifest signature ${verdict}`);
  if (options.signing && !manifest.signature)
    throw new Error('CLI publication requires a signed manifest');
}

function sameManifest(
  left: PublicationManifest | undefined,
  right: PublicationManifest | undefined,
): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined && Buffer.from(left.bytes).equals(Buffer.from(right.bytes));
}

async function admission(
  options: CliPublicationOptions,
  data: PublicationData,
  phase: CliPublicationPhase,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await waitForPublication(
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return options.admit({
        phase,
        identity: Object.freeze({
          name: data.name,
          version: data.version,
          commit: data.commit,
        }),
        signal,
      });
    }),
    signal,
  );
}

async function unchanged(
  storage: PublicationStorage,
  prior: PublicationManifest | undefined,
  data: PublicationData,
  lock: ExclusiveLock,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await lock.assertHeld();
  await storage.assertRoot();
  if (
    !sameManifest(prior, await readPublicationManifest(storage, 'manifest.json', data, signal))
  )
    throw new Error('CLI public manifest changed during publication');
}

function newest(versions: OwnedVersion[]): OwnedVersion[] {
  return [...versions].sort(
    (a, b) => compareCliVersions(b.manifest.version, a.manifest.version) ?? 0,
  );
}

async function retainVersions(
  storage: PublicationStorage,
  history: OwnedVersion[],
  keep: Set<string>,
  count: number,
  data: PublicationData,
  lock: ExclusiveLock,
  signal: AbortSignal,
): Promise<void> {
  const retained = newest(history).filter((item) => !keep.has(item.manifest.version));
  const spare = Math.max(0, count - keep.size);
  for (const version of retained.slice(spare)) {
    await lock.assertHeld();
    await removePublicationVersion(storage, version, data, signal);
  }
}

async function promote(
  storage: PublicationStorage,
  record: PublicationManifest,
  prior: PublicationManifest | undefined,
  data: PublicationData,
  options: CliPublicationOptions,
  lock: ExclusiveLock,
  signal: AbortSignal,
): Promise<void> {
  await admission(options, data, 'promote', signal);
  await verifyPublicationVersion(storage, record, data, signal, true);
  trustPublication(record.manifest, options);
  await unchanged(storage, prior, data, lock, signal);
  const names = await directoryNames(storage.root, data.limits.maxDirectoryEntries, signal);
  if (names.length + 1 > data.limits.maxDirectoryEntries)
    throw new RangeError('CLI publication directory entry cap leaves no pointer space');
  signal.throwIfAborted();
  await writeFileAtomic(join(storage.root, 'manifest.json'), record.bytes, {
    mode: 0o644,
    durability: 'directory',
  });
  const current = await readPublicationManifest(storage, 'manifest.json', data, signal);
  if (!sameManifest(record, current))
    throw new Error('CLI public manifest readback differs after promotion');
}

async function buildVersion(
  storage: PublicationStorage,
  data: PublicationData,
  options: CliPublicationOptions,
  lock: ExclusiveLock,
  prior: PublicationManifest | undefined,
  signal: AbortSignal,
): Promise<PublicationManifest> {
  // Staging becomes the version directory; pointer publication needs one additional temporary entry.
  const names = await directoryNames(storage.root, data.limits.maxDirectoryEntries, signal);
  if (names.length + 2 > data.limits.maxDirectoryEntries)
    throw new RangeError('CLI publication directory entry cap leaves no commit space');
  const staged = await mkdtemp(join(storage.root, '.publish-'));
  const generation = await directoryGeneration(staged);
  let committed = false;
  try {
    const files = await createManagedFileBoundary({
      root: staged,
      maxWriteBytes: Math.max(data.limits.maxCompressedBytes, data.limits.maxManifestBytes),
    });
    const stamp: Readonly<CliBuildStamp> = Object.freeze({
      version: data.version,
      commit: data.commit,
      builtAt: new Date().toISOString(),
    });
    const assets: CliBuildManifest['assets'] = [];
    for (const target of data.targets) {
      await admission(options, data, 'build', signal);
      signal.throwIfAborted();
      const source = await waitForPublication(
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return options.build({ target: Object.freeze({ ...target }), stamp, signal });
        }),
        signal,
      );
      if (!(source instanceof Uint8Array) && !(source instanceof ReadableStream))
        throw new TypeError('CLI builder must return bytes or a stream');
      const bytes = await collectCliBytes(source, data.limits.maxAssetBytes, signal);
      if (bytes.byteLength === 0) throw new Error('CLI asset must not be empty');
      const archived = await gzipCliAsset(bytes, data.limits.maxCompressedBytes, signal);
      await lock.assertHeld();
      await storage.assertRoot();
      await assertDirectory(staged, generation);
      const file = assetFilename(data.name, target);
      await files.write(file, archived, { durable: true, signal });
      assets.push({
        ...target,
        compression: 'gzip',
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        url: assetUrl(data.baseUrl, data.version, file),
      });
    }
    const manifest = CliBuildManifestSchema.parse({ name: data.name, ...stamp, assets });
    if (options.signing) manifest.signature = signCliManifest(manifest, options.signing);
    trustPublication(manifest, options);
    const bytes = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    if (bytes.byteLength > data.limits.maxManifestBytes)
      throw new RangeError('CLI publication manifest byte cap exceeded');
    await assertDirectory(staged, generation);
    await files.write('manifest.json', bytes, {
      durable: true,
      maxBytes: data.limits.maxManifestBytes,
      signal,
    });
    await admission(options, data, 'commit', signal);
    await unchanged(storage, prior, data, lock, signal);
    await assertDirectory(staged, generation);
    try {
      await lstat(join(storage.root, data.version));
      throw new Error('CLI version directory already exists');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    signal.throwIfAborted();
    await rename(staged, join(storage.root, data.version));
    committed = true;
    await syncPublicationDirectory(storage.root);
    return { manifest, bytes };
  } catch (error) {
    if (!committed) {
      try {
        await storage.assertRoot();
        await assertDirectory(staged, generation);
        await rm(staged, { recursive: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'CLI publication failed and safe staging cleanup was refused',
        );
      }
    }
    if (committed && !(error instanceof AtomicFilePublicationError))
      throw new Error('CLI version committed; publication outcome must be checked', {
        cause: error,
      });
    throw error;
  }
}

async function publishLocked(
  storage: PublicationStorage,
  data: PublicationData,
  options: CliPublicationOptions,
  lock: ExclusiveLock,
  signal: AbortSignal,
): Promise<CliPublicationResult> {
  await lock.assertHeld();
  await admission(options, data, 'prepare', signal);
  const prior = await readPublicationManifest(storage, 'manifest.json', data, signal);
  if (prior && prior.manifest.name !== data.name)
    throw new Error('CLI public manifest belongs to another CLI');
  const history = await publicationHistory(storage, data, signal);
  const candidate = {
    name: data.name,
    version: data.version,
    commit: data.commit,
    builtAt: new Date().toISOString(),
    assets: [],
  };
  assertCliPublishable(
    [...(prior ? [prior.manifest] : []), ...history.map((item) => item.manifest)],
    candidate,
  );
  if (prior) {
    await verifyPublicationVersion(
      storage,
      prior,
      data,
      signal,
      prior.manifest.version === data.version,
    );
    trustPublication(prior.manifest, options);
    const order = compareCliVersions(data.version, prior.manifest.version) ?? -1;
    if (order < 0 || (order === 0 && data.version !== prior.manifest.version))
      throw new Error('CLI publication downgrade or non-advancing version refused');
    if (prior.manifest.version === data.version) {
      await admission(options, data, 'promote', signal);
      await verifyPublicationVersion(storage, prior, data, signal, true);
      await unchanged(storage, prior, data, lock, signal);
      return { outcome: 'existing', manifest: prior.manifest };
    }
  }
  let record = history.find((item) => item.manifest.version === data.version);
  if (record) {
    await verifyPublicationVersion(storage, record, data, signal, true);
    trustPublication(record.manifest, options);
  } else {
    // Make room using only verified owned history. Keep the current pointer and its preceding version.
    const protect = new Set(prior ? [prior.manifest.version] : []);
    const previous = newest(history).find(
      (item) =>
        prior && (compareCliVersions(item.manifest.version, prior.manifest.version) ?? 0) < 0,
    );
    if (previous) protect.add(previous.manifest.version);
    await retainVersions(
      storage,
      history,
      protect,
      data.limits.maxStoredVersions - 1,
      data,
      lock,
      signal,
    );
    record = {
      ...(await buildVersion(storage, data, options, lock, prior, signal)),
      directory: join(storage.root, data.version),
    };
  }
  try {
    await promote(storage, record, prior, data, options, lock, signal);
    const updated = await publicationHistory(storage, data, signal);
    await retainVersions(
      storage,
      updated,
      new Set([data.version, ...(prior ? [prior.manifest.version] : [])]),
      data.retention,
      data,
      lock,
      signal,
    );
  } catch (error) {
    if (error instanceof AtomicFilePublicationError) throw error;
    throw new Error('CLI version committed; publication outcome must be checked', {
      cause: error,
    });
  }
  return { outcome: 'published', manifest: record.manifest };
}

/** Publish in trusted application-owned storage; a complete version is immutable and the public pointer moves last. */
export async function publishCli(
  options: CliPublicationOptions,
): Promise<CliPublicationResult> {
  const data = publicationData(options);
  return withPublicationDeadline(data.limits.timeoutMs, options.signal, async (signal) => {
    const storage = await bindPublicationStorage(data, signal);
    return withExclusiveLock(
      join(storage.root, '.publication.lock'),
      (lock) => publishLocked(storage, data, options, lock, signal),
      { timeoutMs: data.limits.lockTimeoutMs, signal, label: 'CLI publication' },
    );
  });
}
