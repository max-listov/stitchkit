import { lstat, mkdir, open, opendir, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  createManagedFileBoundary,
  type ManagedFileBoundary,
  ManagedFileError,
} from '../../files/boundary';
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
  if (process.platform === 'win32')
    throw new Error('CLI publication needs directory durability, unsupported on Windows');
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

export async function verifyPublicationVersion(
  storage: PublicationStorage,
  record: PublicationManifest,
  data: PublicationData,
  signal: AbortSignal,
  exactTargets: boolean,
): Promise<void> {
  const { manifest } = record;
  PublicationVersionSchema.parse(manifest.version);
  if (
    manifest.name !== data.name ||
    manifest.assets.length === 0 ||
    manifest.assets.length > data.limits.maxTargets
  )
    throw new Error('CLI version identity or target count is invalid');
  const directory = join(storage.root, manifest.version);
  const generation = await directoryGeneration(directory);
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
  const names = await directoryNames(directory, data.limits.maxDirectoryEntries, signal);
  if (JSON.stringify(names) !== JSON.stringify([...expected, 'manifest.json'].sort()))
    throw new Error('CLI version has unknown or missing files');
  const saved = await readPublicationManifest(
    storage,
    `${manifest.version}/manifest.json`,
    data,
    signal,
  );
  if (!saved || !Buffer.from(saved.bytes).equals(Buffer.from(record.bytes)))
    throw new Error('CLI version manifest differs from publication');
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

export async function syncPublicationDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Only a fully verified, unchanged publisher-owned directory is removable. */
export async function removePublicationVersion(
  storage: PublicationStorage,
  version: OwnedVersion,
  data: PublicationData,
  signal: AbortSignal,
): Promise<void> {
  await storage.assertRoot();
  await verifyPublicationVersion(storage, version, data, signal, false);
  await rm(version.directory, { recursive: true });
  await syncPublicationDirectory(storage.root);
}
