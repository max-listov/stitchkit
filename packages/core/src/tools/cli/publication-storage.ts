import { lstat, mkdir, opendir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  createManagedFileBoundary,
  type ManagedFileBoundary,
  ManagedFileError,
} from '../../files/boundary';
import { assertDirectoryDurability, syncDirectory } from '../../internal/atomic-publication';
import { type CliBuildManifest, CliBuildManifestSchema } from './manifest';
import { decodeCliAsset } from './publication-assets';
import {
  assetFilename,
  assetUrl,
  type PublicationData,
  PublicationTargetSchema,
  PublicationVersionSchema,
} from './publication-contract';

export interface PublicationManifest {
  manifest: CliBuildManifest;
  bytes: Uint8Array;
}
export interface OwnedVersion extends PublicationManifest {
  directory: string;
}
export interface PublicationStorage {
  root: string;
  files: ManagedFileBoundary;
  assertRoot(): Promise<void>;
}

export async function directoryGeneration(
  path: string,
): Promise<{ dev: number; ino: number }> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('CLI storage directory must not be a link or non-directory');
  return { dev: info.dev, ino: info.ino };
}

export async function assertDirectory(
  path: string,
  generation: { dev: number; ino: number },
): Promise<void> {
  const current = await directoryGeneration(path);
  if (current.dev !== generation.dev || current.ino !== generation.ino)
    throw new Error('CLI storage directory generation changed');
}

export async function bindPublicationStorage(
  data: PublicationData,
  signal: AbortSignal,
): Promise<PublicationStorage> {
  signal.throwIfAborted();
  assertDirectoryDurability();
  const requested = resolve(data.storageRoot);
  try {
    await mkdir(requested, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  await directoryGeneration(requested);
  const root = await realpath(requested);
  const generation = await directoryGeneration(root);
  const files = await createManagedFileBoundary({
    root,
    maxReadBytes: Math.max(data.limits.maxManifestBytes, data.limits.maxCompressedBytes),
    maxWriteBytes: Math.max(data.limits.maxManifestBytes, data.limits.maxCompressedBytes),
  });
  return {
    root,
    files,
    async assertRoot() {
      await assertDirectory(requested, generation);
      await assertDirectory(root, generation);
    },
  };
}

export async function directoryNames(
  path: string,
  maxEntries: number,
  signal: AbortSignal,
): Promise<string[]> {
  const names: string[] = [];
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      signal.throwIfAborted();
      names.push(entry.name);
      if (names.length > maxEntries)
        throw new RangeError('CLI publication directory entry cap exceeded');
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return names.sort();
}

export async function readPublicationManifest(
  storage: PublicationStorage,
  path: string,
  data: PublicationData,
  signal: AbortSignal,
): Promise<PublicationManifest | undefined> {
  try {
    const read = await storage.files.read(path, {
      rejectSymlinks: true,
      singleLink: true,
      stable: true,
      maxBytes: data.limits.maxManifestBytes,
      signal,
    });
    return {
      manifest: CliBuildManifestSchema.parse(JSON.parse(new TextDecoder().decode(read.bytes))),
      bytes: read.bytes,
    };
  } catch (error) {
    if (error instanceof ManagedFileError && error.code === 'FILE_NOT_FOUND') return undefined;
    throw error;
  }
}

/**
 * Everything a version's manifest must satisfy on its own: identity, the layout
 * the publisher writes, and asset URLs. Returns the file names the version
 * directory must hold. Reads nothing.
 */
export function assertPublicationManifest(
  record: PublicationManifest,
  data: PublicationData,
  exactTargets: boolean,
): string[] {
  const { manifest } = record;
  PublicationVersionSchema.parse(manifest.version);
  if (
    manifest.name !== data.name ||
    manifest.assets.length === 0 ||
    manifest.assets.length > data.limits.maxTargets
  )
    throw new Error('CLI version identity or target count is invalid');
  const expected = manifest.assets.map((asset) => assetFilename(data.name, asset));
  if (
    new Set(expected).size !== expected.length ||
    manifest.assets.some(
      (asset) =>
        !PublicationTargetSchema.safeParse(asset).success || asset.compression !== 'gzip',
    )
  )
    throw new Error('CLI version targets or compression do not match publisher layout');
  if (exactTargets) {
    const requested = data.targets.map((target) => assetFilename(data.name, target)).sort();
    if (JSON.stringify(requested) !== JSON.stringify([...expected].sort()))
      throw new Error('CLI publication target set differs from existing version');
  }
  for (const asset of manifest.assets) {
    const file = assetFilename(data.name, asset);
    const url = new URL(asset.url);
    const suffix = `/${encodeURIComponent(manifest.version)}/${encodeURIComponent(file)}`;
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.pathname.endsWith(suffix) ||
      url.search ||
      url.hash ||
      (exactTargets && asset.url !== assetUrl(data.baseUrl, manifest.version, file))
    )
      throw new Error('CLI asset URL differs from owned version layout');
  }
  return expected;
}

/** The version directory holds exactly the manifest's files and the manifest it was published with. */
async function assertStoredLayout(
  storage: PublicationStorage,
  record: PublicationManifest,
  expected: readonly string[],
  data: PublicationData,
  signal: AbortSignal,
): Promise<void> {
  const version = record.manifest.version;
  const names = await directoryNames(
    join(storage.root, version),
    data.limits.maxDirectoryEntries,
    signal,
  );
  if (JSON.stringify(names) !== JSON.stringify([...expected, 'manifest.json'].sort()))
    throw new Error('CLI version has unknown or missing files');
  const saved = await readPublicationManifest(
    storage,
    `${version}/manifest.json`,
    data,
    signal,
  );
  if (!saved || !Buffer.from(saved.bytes).equals(Buffer.from(record.bytes)))
    throw new Error('CLI version manifest differs from publication');
}

/**
 * Prove a stored version whole: its layout, then every asset decompressed to its
 * declared size and digest. Decompression is the expensive part, so one
 * publication proves each stored version once and passes the result on.
 */
export async function verifyPublicationVersion(
  storage: PublicationStorage,
  record: PublicationManifest,
  data: PublicationData,
  signal: AbortSignal,
  exactTargets: boolean,
): Promise<void> {
  const { manifest } = record;
  const expected = assertPublicationManifest(record, data, exactTargets);
  const directory = join(storage.root, manifest.version);
  const generation = await directoryGeneration(directory);
  await assertStoredLayout(storage, record, expected, data, signal);
  for (const asset of manifest.assets) {
    const file = assetFilename(data.name, asset);
    const archived = await storage.files.read(`${manifest.version}/${file}`, {
      rejectSymlinks: true,
      singleLink: true,
      stable: true,
      maxBytes: data.limits.maxCompressedBytes,
      signal,
    });
    await decodeCliAsset(archived.bytes, asset, data.limits.maxAssetBytes, signal);
  }
  await assertDirectory(directory, generation);
}

export async function publicationHistory(
  storage: PublicationStorage,
  data: PublicationData,
  signal: AbortSignal,
): Promise<OwnedVersion[]> {
  const history: OwnedVersion[] = [];
  for (const name of await directoryNames(
    storage.root,
    data.limits.maxDirectoryEntries,
    signal,
  )) {
    if (!PublicationVersionSchema.safeParse(name).success) continue;
    const path = join(storage.root, name);
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    let record: PublicationManifest | undefined;
    try {
      record = await readPublicationManifest(storage, `${name}/manifest.json`, data, signal);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) continue;
      throw error;
    }
    if (!record || record.manifest.name !== data.name || record.manifest.version !== name)
      continue;
    await verifyPublicationVersion(storage, record, data, signal, false);
    history.push({ ...record, directory: path });
    if (history.length > data.limits.maxStoredVersions)
      throw new RangeError('CLI publication stored version cap exceeded');
  }
  return history;
}

/**
 * Remove a stored version that `publicationHistory` already proved whole in this
 * transaction. Only the cheap facts are checked again — the directory is still
 * the same one and still holds exactly the proven files — before it is removed.
 */
export async function removePublicationVersion(
  storage: PublicationStorage,
  version: OwnedVersion,
  data: PublicationData,
  signal: AbortSignal,
): Promise<void> {
  await storage.assertRoot();
  const generation = await directoryGeneration(version.directory);
  await assertStoredLayout(
    storage,
    version,
    assertPublicationManifest(version, data, false),
    data,
    signal,
  );
  await assertDirectory(version.directory, generation);
  await rm(version.directory, { recursive: true });
  await syncDirectory(storage.root);
}

/** A staging directory made by `publishCli`: `mkdtemp` appends six random characters. */
const STAGING_NAME = /^\.publish-[A-Za-z0-9]{6}$/;

/**
 * Remove staging directories left by a publisher that died mid-build. Call it
 * only while holding the publication lock: the lock admits one publisher, so
 * every staging directory present then belongs to a publisher that is gone.
 * Returns how many were removed.
 */
export async function reclaimPublicationStaging(
  storage: PublicationStorage,
  signal: AbortSignal,
): Promise<number> {
  await storage.assertRoot();
  const stale: string[] = [];
  const directory = await opendir(storage.root);
  try {
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (STAGING_NAME.test(entry.name) && entry.isDirectory()) stale.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  for (const name of stale) {
    signal.throwIfAborted();
    await rm(join(storage.root, name), { recursive: true });
  }
  if (stale.length > 0) await syncDirectory(storage.root);
  return stale.length;
}
