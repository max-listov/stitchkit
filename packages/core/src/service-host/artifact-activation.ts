import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { syncDirectory } from '../internal/atomic-publication';
import { stagingName } from '../internal/atomic-staging';
import { errnoOf } from '../internal/errno';
import { messageOf } from '../internal/error-message';
import { realPathWithinDir } from '../internal/within-dir';
import {
  type VerifiedArtifact,
  type VerifyArtifactOptions,
  verifyArtifactDirectory,
} from './artifact';
import {
  ARTIFACT_MANIFEST_FILENAME,
  type ArtifactErrorCode,
  ArtifactVerificationError,
  assertSafeSingleSegment,
} from './artifact-manifest';

const MAX_DEFAULT_VERSION_PREFIX = 64;

/** Options for {@link activateVersionedArtifact}. */
export interface ActivateVersionedArtifactOptions {
  /** Installation root holding `releases/` and the `current` symlink. */
  rootDir: string;
  /** Candidate artifact directory to verify and install. */
  sourceDir: string;
  /** Optional single-segment release directory name under `releases/`. */
  releaseKey?: string;
  /** Subdirectory holding immutable versioned releases (default: `releases`). */
  releasesDirName?: string;
  /** Symlink name at `rootDir` pointing to the active release (default: `current`). */
  currentLinkName?: string;
  /** Verification options passed to {@link verifyArtifactDirectory}. */
  verifyOptions?: VerifyArtifactOptions;
}

/** Result returned by {@link activateVersionedArtifact}. */
export interface ActivatedArtifactResult {
  releaseKey: string;
  releaseDir: string;
  currentLinkPath: string;
  previousTarget: string | null;
  previousReleaseDir: string | null;
  artifact: VerifiedArtifact;
}

/** Options for {@link rollbackVersionedArtifact}. */
export interface RollbackVersionedArtifactOptions {
  /** Installation root holding `releases/` and `current`. */
  rootDir: string;
  /** Prior symlink target (`<releasesDirName>/<releaseKey>`) from {@link activateVersionedArtifact}. */
  previousTarget: string;
  /** Subdirectory holding immutable versioned releases (default: `releases`). */
  releasesDirName?: string;
  /** Symlink name at `rootDir` (default: `current`). */
  currentLinkName?: string;
  /** Verification options passed to {@link verifyArtifactDirectory} before switching back. */
  verifyOptions?: VerifyArtifactOptions;
}

/** Result returned by {@link rollbackVersionedArtifact}. */
export interface RollbackArtifactResult {
  currentLinkPath: string;
  restoredTarget: string;
  restoredDir: string;
  artifact: VerifiedArtifact;
}

async function atomicSwitchSymlink(
  linkPath: string,
  target: string,
  errorCode: ArtifactErrorCode,
): Promise<void> {
  const tempLink = join(dirname(linkPath), stagingName());
  try {
    await symlink(target, tempLink);
    try {
      await rename(tempLink, linkPath);
    } catch (cause) {
      await unlink(tempLink).catch(() => undefined);
      throw cause;
    }
    // The switch survives a power loss only once its directory entry is on the device.
    await syncDirectory(dirname(linkPath));
  } catch (cause) {
    throw new ArtifactVerificationError(
      errorCode,
      `Failed to atomically switch symlink ${linkPath} → ${target}: ${messageOf(cause)}`,
      { cause, path: linkPath },
    );
  }
}

const RELEASE_DIRECTORY_MODE = 0o755;
/** Owner bits and read/execute for the rest: no group or world write survives activation. */
const RELEASE_FILE_MODE_MASK = 0o755;

/** Put a copied file's bytes on the device: a rename of its directory does not. */
async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Copy a verified release into `destDir` and put it on the device — every file, then every
 * directory deepest first — so the release `current` is switched to is never one a power
 * loss leaves with empty files.
 */
async function copyVerifiedRelease(
  sourceDir: string,
  destDir: string,
  artifact: VerifiedArtifact,
  manifestFileName: string,
): Promise<void> {
  // A release is run by whoever supervises it and must stay what was verified: only its
  // owner may write it, whatever the payload's modes and the caller's umask say.
  await mkdir(destDir, { recursive: true, mode: RELEASE_DIRECTORY_MODE });
  const manifestPath = join(destDir, manifestFileName);
  await copyFile(join(sourceDir, manifestFileName), manifestPath);
  await chmod(manifestPath, 0o644);
  const copied = [manifestPath];
  const directories = new Set([destDir]);
  for (const file of artifact.files) {
    const targetPath = join(destDir, file.path);
    await mkdir(dirname(targetPath), { recursive: true, mode: RELEASE_DIRECTORY_MODE });
    await copyFile(join(sourceDir, file.path), targetPath);
    await chmod(targetPath, file.mode & RELEASE_FILE_MODE_MASK);
    copied.push(targetPath);
    for (let dir = dirname(targetPath); dir.length > destDir.length; dir = dirname(dir))
      directories.add(dir);
  }
  for (const path of copied) await syncFile(path);
  const deepestFirst = [...directories].sort((a, b) => b.length - a.length);
  for (const dir of deepestFirst) await syncDirectory(dir);
}

function defaultReleaseKey(artifact: VerifiedArtifact): string {
  const stripped = artifact.version
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, MAX_DEFAULT_VERSION_PREFIX);
  const prefix = stripped.length > 0 ? stripped : 'release';
  return `${prefix}-${artifact.manifestDigest.slice(0, 12)}`;
}

async function assertExistingReleaseMatches(
  releaseDir: string,
  releaseKey: string,
  expectedDigest: string,
  verifyOptions: VerifyArtifactOptions | undefined,
): Promise<VerifiedArtifact> {
  const existingVerified = await verifyArtifactDirectory(releaseDir, verifyOptions).catch(
    (cause: unknown) => {
      throw new ArtifactVerificationError(
        'ACTIVATION_FAILED',
        `Existing release directory ${releaseKey} is corrupted or invalid`,
        { cause, path: releaseDir },
      );
    },
  );
  if (existingVerified.manifestDigest !== expectedDigest) {
    throw new ArtifactVerificationError(
      'ACTIVATION_FAILED',
      `Release directory ${releaseKey} already exists with a different manifest digest`,
      { path: releaseDir },
    );
  }
  return existingVerified;
}

function parseRollbackTarget(
  previousTarget: string,
  releasesDirName: string,
): { releaseKey: string } {
  if (
    previousTarget.length === 0 ||
    previousTarget.includes('\0') ||
    previousTarget.includes('\\') ||
    previousTarget.startsWith('/') ||
    previousTarget.endsWith('/')
  ) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Rollback target must be '<${releasesDirName}>/<releaseKey>': ${JSON.stringify(previousTarget)}`,
      { path: previousTarget },
    );
  }
  const parts = previousTarget.split('/');
  if (parts.length !== 2 || parts[0] !== releasesDirName) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Rollback target must be '<${releasesDirName}>/<releaseKey>': ${JSON.stringify(previousTarget)}`,
      { path: previousTarget },
    );
  }
  const releaseKey = parts[1] ?? '';
  assertSafeSingleSegment('releaseKey', releaseKey, 'ROLLBACK_FAILED');
  return { releaseKey };
}

/**
 * Verify a candidate artifact directory, install it immutably under
 * `<rootDir>/<releasesDirName>/<releaseKey>/`, and atomically flip
 * `<rootDir>/<currentLinkName>` via a staged symlink rename while returning
 * the prior target for {@link rollbackVersionedArtifact}.
 */
export async function activateVersionedArtifact(
  options: ActivateVersionedArtifactOptions,
): Promise<ActivatedArtifactResult> {
  const releasesDirName = options.releasesDirName ?? 'releases';
  const currentLinkName = options.currentLinkName ?? 'current';
  const manifestFileName =
    options.verifyOptions?.manifestFileName ?? ARTIFACT_MANIFEST_FILENAME;
  assertSafeSingleSegment('releasesDirName', releasesDirName, 'ACTIVATION_FAILED');
  assertSafeSingleSegment('currentLinkName', currentLinkName, 'ACTIVATION_FAILED');
  if (releasesDirName === currentLinkName) {
    throw new ArtifactVerificationError(
      'ACTIVATION_FAILED',
      `releasesDirName and currentLinkName must differ (${releasesDirName})`,
    );
  }

  // Decide trust before mutating anything under rootDir.
  const verifiedSource = await verifyArtifactDirectory(
    options.sourceDir,
    options.verifyOptions,
  );
  const releaseKey = options.releaseKey ?? defaultReleaseKey(verifiedSource);
  assertSafeSingleSegment('releaseKey', releaseKey, 'ACTIVATION_FAILED');

  const absRoot = resolve(options.rootDir);
  const releasesDir = join(absRoot, releasesDirName);
  const releaseDir = join(releasesDir, releaseKey);
  const currentLinkPath = join(absRoot, currentLinkName);

  // Pre-check existing currentLinkPath and releasesDir BEFORE mkdir or staging copy.
  const currentInfo = await lstat(currentLinkPath).catch((cause: unknown) => {
    if (errnoOf(cause) === 'ENOENT') return null;
    throw cause;
  });
  if (currentInfo !== null && !currentInfo.isSymbolicLink()) {
    throw new ArtifactVerificationError(
      'ACTIVATION_FAILED',
      `Current pointer path exists and is not a symlink: ${currentLinkPath}`,
      { path: currentLinkPath },
    );
  }
  const releasesInfo = await lstat(releasesDir).catch((cause: unknown) => {
    if (errnoOf(cause) === 'ENOENT') return null;
    throw cause;
  });
  if (
    releasesInfo !== null &&
    (releasesInfo.isSymbolicLink() || !releasesInfo.isDirectory())
  ) {
    throw new ArtifactVerificationError(
      'ACTIVATION_FAILED',
      `Releases path exists and is not a real directory: ${releasesDir}`,
      { path: releasesDir },
    );
  }

  await mkdir(releasesDir, { recursive: true });
  await syncDirectory(absRoot);

  const existingRelease = await lstat(releaseDir).catch((cause: unknown) => {
    if (errnoOf(cause) === 'ENOENT') return null;
    throw cause;
  });

  let activatedArtifact: VerifiedArtifact;
  if (existingRelease !== null) {
    activatedArtifact = await assertExistingReleaseMatches(
      releaseDir,
      releaseKey,
      verifiedSource.manifestDigest,
      options.verifyOptions,
    );
  } else {
    const stagedDir = join(releasesDir, stagingName());
    try {
      await copyVerifiedRelease(
        verifiedSource.directory,
        stagedDir,
        verifiedSource,
        manifestFileName,
      );
      const stagedVerified = await verifyArtifactDirectory(stagedDir, options.verifyOptions);
      if (stagedVerified.manifestDigest !== verifiedSource.manifestDigest) {
        throw new ArtifactVerificationError(
          'ACTIVATION_FAILED',
          `Staged release digest drifted for ${releaseKey}`,
          { path: stagedDir },
        );
      }
      try {
        await rename(stagedDir, releaseDir);
        await syncDirectory(releasesDir);
        activatedArtifact = stagedVerified;
      } catch (renameCause) {
        const code = errnoOf(renameCause);
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          await rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
          activatedArtifact = await assertExistingReleaseMatches(
            releaseDir,
            releaseKey,
            verifiedSource.manifestDigest,
            options.verifyOptions,
          );
        } else {
          throw renameCause;
        }
      }
    } catch (cause) {
      await rm(stagedDir, { recursive: true, force: true }).catch(() => undefined);
      if (cause instanceof ArtifactVerificationError) throw cause;
      throw new ArtifactVerificationError(
        'ACTIVATION_FAILED',
        `Failed to stage release ${releaseKey}: ${messageOf(cause)}`,
        { cause, path: releaseDir },
      );
    }
  }

  let previousTarget: string | null = null;
  let previousReleaseDir: string | null = null;
  if (currentInfo !== null) {
    previousTarget = await readlink(currentLinkPath);
    previousReleaseDir = resolve(absRoot, previousTarget);
  }

  const relativeTarget = `${releasesDirName}/${releaseKey}`;
  await atomicSwitchSymlink(currentLinkPath, relativeTarget, 'ACTIVATION_FAILED');

  return {
    releaseKey,
    releaseDir,
    currentLinkPath,
    previousTarget,
    previousReleaseDir,
    artifact: { ...activatedArtifact, directory: releaseDir },
  };
}

/**
 * Verify a previous release directory under `<rootDir>/<releasesDirName>/` and
 * atomically restore `<rootDir>/<currentLinkName>` back to `previousTarget`.
 */
export async function rollbackVersionedArtifact(
  options: RollbackVersionedArtifactOptions,
): Promise<RollbackArtifactResult> {
  const releasesDirName = options.releasesDirName ?? 'releases';
  const currentLinkName = options.currentLinkName ?? 'current';
  assertSafeSingleSegment('releasesDirName', releasesDirName, 'ROLLBACK_FAILED');
  assertSafeSingleSegment('currentLinkName', currentLinkName, 'ROLLBACK_FAILED');
  if (releasesDirName === currentLinkName) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `releasesDirName and currentLinkName must differ (${releasesDirName})`,
    );
  }

  const { releaseKey } = parseRollbackTarget(options.previousTarget, releasesDirName);
  const absRoot = resolve(options.rootDir);
  const releasesDir = join(absRoot, releasesDirName);
  const currentLinkPath = join(absRoot, currentLinkName);

  const releasesInfo = await lstat(releasesDir).catch((cause: unknown) => {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Releases directory is missing: ${releasesDir}`,
      { cause, path: releasesDir },
    );
  });
  if (releasesInfo.isSymbolicLink() || !releasesInfo.isDirectory()) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Releases path must be a real directory: ${releasesDir}`,
      { path: releasesDir },
    );
  }

  const currentInfo = await lstat(currentLinkPath).catch((cause: unknown) => {
    if (errnoOf(cause) === 'ENOENT') return null;
    throw cause;
  });
  if (currentInfo !== null && !currentInfo.isSymbolicLink()) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Current pointer path exists and is not a symlink: ${currentLinkPath}`,
      { path: currentLinkPath },
    );
  }

  const restoredDir = resolve(releasesDir, releaseKey);
  const targetInfo = await lstat(restoredDir).catch((cause: unknown) => {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Rollback target directory is missing: ${options.previousTarget}`,
      { cause, path: options.previousTarget },
    );
  });
  if (targetInfo.isSymbolicLink() || !targetInfo.isDirectory()) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Rollback target must be a real directory: ${options.previousTarget}`,
      { path: options.previousTarget },
    );
  }

  const [realReleases, realRestored] = await Promise.all([
    realpath(releasesDir).catch(() => null),
    realPathWithinDir(releasesDir, restoredDir),
  ]);
  if (realReleases === null || realRestored === null || realRestored === realReleases) {
    throw new ArtifactVerificationError(
      'ROLLBACK_FAILED',
      `Rollback target escapes releases directory: ${options.previousTarget}`,
      { path: options.previousTarget },
    );
  }

  const artifact = await verifyArtifactDirectory(restoredDir, options.verifyOptions);
  await atomicSwitchSymlink(currentLinkPath, options.previousTarget, 'ROLLBACK_FAILED');

  return {
    currentLinkPath,
    restoredTarget: options.previousTarget,
    restoredDir,
    artifact,
  };
}
