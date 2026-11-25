import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  DEFAULT_JSON_FILE_BYTES,
  fileIdentity,
  parseJsonBytes,
  RegularFileError,
  readRegularFileSync,
} from '../files/regular-file';
import { closeAfterSync } from '../internal/close-after';
import { errnoOf } from '../internal/errno';
import { messageOf } from '../internal/error-message';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { isWithinDir } from '../internal/within-dir';
import {
  ARTIFACT_MANIFEST_FILENAME,
  type ArtifactManifest,
  ArtifactManifestSchema,
  ArtifactVerificationError,
  artifactRelativePathIssue,
  assertSafeSingleSegment,
  computeArtifactManifestDigest,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  DEFAULT_ARTIFACT_MAX_FILES,
} from './artifact-manifest';

const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_DIRECTORY_DEPTH = 64;

function openNoFollowFlags(): number {
  return constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
}

/** Verified on-disk metadata and digest of a single payload file. */
export interface VerifiedArtifactFile {
  path: string;
  sha256: string;
  size: number;
  executable: boolean;
  mode: number;
}

/** Result of verifying an artifact directory against its `manifest.json`. */
export interface VerifiedArtifact {
  directory: string;
  version: string;
  manifestDigest: string;
  manifest: ArtifactManifest;
  files: VerifiedArtifactFile[];
}

/** Options controlling {@link verifyArtifactDirectory}. */
export interface VerifyArtifactOptions {
  /** Manifest filename at the artifact root (default: `manifest.json`). */
  manifestFileName?: string;
  /** Maximum byte size for any single payload file (default: 256 MiB). */
  maxFileBytes?: number;
  /** Maximum byte size for `manifest.json` (default: 1 MiB). */
  maxManifestBytes?: number;
  /** Maximum number of payload files allowed in the directory (default: 10,000). */
  maxFiles?: number;
  /**
   * Optional domain hook to validate required entrypoints or executable bits
   * after inventory and SHA-256 verification succeed.
   */
  checkRequirements?: (artifact: VerifiedArtifact) => void | Promise<void>;
}

function assertRealDirectorySync(directory: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(directory);
  } catch (cause) {
    throw new ArtifactVerificationError(
      'INVALID_ROOT',
      `Artifact directory is missing or unreadable: ${directory}`,
      { cause, path: directory },
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ArtifactVerificationError(
      'INVALID_ROOT',
      `Artifact root must be a real directory (not a symlink): ${directory}`,
      { path: directory },
    );
  }
}

function hashRegularFileNoFollowSync(
  absPath: string,
  relPath: string,
  maxFileBytes: number,
): { sha256: string; size: number; mode: number; executable: boolean } {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let linkInfo: ReturnType<typeof lstatSync>;
    try {
      linkInfo = lstatSync(absPath);
    } catch (cause) {
      if (errnoOf(cause) === 'ENOENT') {
        throw new ArtifactVerificationError(
          'MISSING_FILE',
          `Declared artifact file is missing: ${relPath}`,
          { cause, path: relPath },
        );
      }
      throw cause;
    }
    if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
      throw new ArtifactVerificationError(
        'UNSUPPORTED_ENTRY',
        `Artifact payload entry must be a regular file: ${relPath}`,
        { path: relPath },
      );
    }

    let fd: number;
    try {
      fd = openSync(absPath, openNoFollowFlags());
    } catch (cause) {
      const code = errnoOf(cause);
      if (code === 'ENOENT') {
        throw new ArtifactVerificationError(
          'MISSING_FILE',
          `Declared artifact file vanished before open: ${relPath}`,
          { cause, path: relPath },
        );
      }
      if (code === 'ELOOP' || code === 'EISDIR' || code === 'ENXIO' || code === 'EOPNOTSUPP') {
        throw new ArtifactVerificationError(
          'UNSUPPORTED_ENTRY',
          `Refused non-regular or symlinked artifact file: ${relPath}`,
          { cause, path: relPath },
        );
      }
      throw cause;
    }

    const result = closeAfterSync(
      () => closeSync(fd),
      () => {
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile()) {
          throw new ArtifactVerificationError(
            'UNSUPPORTED_ENTRY',
            `Artifact payload entry is not a regular file: ${relPath}`,
            { path: relPath },
          );
        }
        if (before.size > BigInt(maxFileBytes)) {
          throw new ArtifactVerificationError(
            'LIMIT_EXCEEDED',
            `Artifact file exceeds ${maxFileBytes}-byte limit: ${relPath}`,
            { path: relPath },
          );
        }
        const beforeId = fileIdentity(before);
        const hash = createHash('sha256');
        const buffer = new Uint8Array(HASH_CHUNK_BYTES);
        let total = 0;
        for (;;) {
          const read = readSync(fd, buffer, 0, buffer.byteLength, null);
          if (read === 0) break;
          total += read;
          if (total > maxFileBytes) {
            throw new ArtifactVerificationError(
              'LIMIT_EXCEEDED',
              `Artifact file exceeds ${maxFileBytes}-byte limit: ${relPath}`,
              { path: relPath },
            );
          }
          hash.update(buffer.subarray(0, read));
        }
        const after = fstatSync(fd, { bigint: true });
        const stable =
          fileIdentity(after) === beforeId &&
          after.nlink === before.nlink &&
          BigInt(total) === after.size;
        if (!stable) return null;
        const mode = Number(after.mode & 0o7777n);
        return {
          sha256: hash.digest('hex'),
          size: total,
          mode,
          executable: (mode & 0o111) !== 0,
        };
      },
    );
    if (result !== null) return result;
  }

  throw new ArtifactVerificationError(
    'DIGEST_MISMATCH',
    `Artifact file changed concurrently while hashing: ${relPath}`,
    { path: relPath },
  );
}

function collectArtifactFilesSync(
  rootDir: string,
  manifestFileName: string,
  maxFiles: number,
): { files: Set<string>; emptyDirs: string[] } {
  const discovered = new Set<string>();
  const emptyDirs: string[] = [];
  const maxEntries = Math.max(maxFiles * 4, maxFiles + 1024);
  let visitedEntries = 0;

  const walk = (relDir: string, depth: number): number => {
    if (depth > MAX_DIRECTORY_DEPTH) {
      throw new ArtifactVerificationError(
        'LIMIT_EXCEEDED',
        `Artifact directory exceeds maximum nesting depth (${MAX_DIRECTORY_DEPTH}): ${relDir}`,
        { path: relDir },
      );
    }
    const absDir = relDir === '' ? rootDir : join(rootDir, relDir);
    const entries = readdirSync(absDir, { withFileTypes: true });
    let filesInSubtree = 0;
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > maxEntries) {
        throw new ArtifactVerificationError(
          'LIMIT_EXCEEDED',
          `Artifact directory exceeds ${maxEntries}-entry walk limit`,
        );
      }
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const absPath = join(absDir, entry.name);
      const info = lstatSync(absPath);
      if (entry.isSymbolicLink() || info.isSymbolicLink()) {
        throw new ArtifactVerificationError(
          'UNSUPPORTED_ENTRY',
          `Symlink is forbidden inside artifact directory: ${relPath}`,
          { path: relPath },
        );
      }
      if (info.isDirectory()) {
        const subFiles = walk(relPath, depth + 1);
        if (subFiles === 0) emptyDirs.push(relPath);
        filesInSubtree += subFiles;
        continue;
      }
      if (!info.isFile()) {
        throw new ArtifactVerificationError(
          'UNSUPPORTED_ENTRY',
          `Non-regular file is forbidden inside artifact directory: ${relPath}`,
          { path: relPath },
        );
      }
      if (relPath === manifestFileName) continue;
      discovered.add(relPath);
      filesInSubtree += 1;
      if (discovered.size > maxFiles) {
        throw new ArtifactVerificationError(
          'LIMIT_EXCEEDED',
          `Artifact directory exceeds ${maxFiles}-file limit`,
        );
      }
    }
    return filesInSubtree;
  };
  walk('', 0);
  return { files: discovered, emptyDirs };
}

function readVerifiedManifestSync(
  rootDir: string,
  manifestFileName: string,
  maxManifestBytes: number,
): ArtifactManifest {
  const manifestPath = join(rootDir, manifestFileName);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(manifestPath);
  } catch (cause) {
    throw new ArtifactVerificationError(
      'INVALID_MANIFEST',
      `Artifact manifest is missing: ${manifestFileName}`,
      { cause, path: manifestFileName },
    );
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ArtifactVerificationError(
      'UNSUPPORTED_ENTRY',
      `Artifact manifest must be a regular file: ${manifestFileName}`,
      { path: manifestFileName },
    );
  }
  let raw: unknown;
  try {
    const bytes = readRegularFileSync(manifestPath, {
      limit: maxManifestBytes,
      noFollow: true,
    });
    raw = parseJsonBytes(bytes);
  } catch (cause) {
    const detail = cause instanceof RegularFileError ? cause.message : messageOf(cause);
    throw new ArtifactVerificationError(
      'INVALID_MANIFEST',
      `Failed to read artifact manifest (${manifestFileName}): ${detail}`,
      { cause, path: manifestFileName },
    );
  }
  const parsed = ArtifactManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ArtifactVerificationError(
      'INVALID_MANIFEST',
      `Invalid artifact manifest (${manifestFileName}): ${parsed.error.message}`,
      { cause: parsed.error, path: manifestFileName },
    );
  }
  for (const entry of parsed.data.files) {
    const issue = artifactRelativePathIssue(entry.path, manifestFileName);
    if (issue !== null) {
      throw new ArtifactVerificationError('INVALID_MANIFEST', issue, { path: entry.path });
    }
  }
  return parsed.data;
}

/**
 * Verify an artifact directory strictly against its `manifest.json`:
 * refuses a symlinked root, refuses any symlink/FIFO/socket/device entry,
 * enforces an exact inventory (no missing files, extra files, or empty
 * subdirectories), checks SHA-256, optional size and executable bit per file,
 * computes the canonical manifest digest, and runs any optional domain
 * requirements hook.
 */
export async function verifyArtifactDirectory(
  directory: string,
  options: VerifyArtifactOptions = {},
): Promise<VerifiedArtifact> {
  const manifestFileName = options.manifestFileName ?? ARTIFACT_MANIFEST_FILENAME;
  assertSafeSingleSegment('manifestFileName', manifestFileName, 'INVALID_MANIFEST');
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_ARTIFACT_MAX_FILE_BYTES;
  const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_JSON_FILE_BYTES;
  const maxFiles = options.maxFiles ?? DEFAULT_ARTIFACT_MAX_FILES;
  assertPositiveSafeInteger('maxFileBytes', maxFileBytes);
  assertPositiveSafeInteger('maxManifestBytes', maxManifestBytes);
  assertPositiveSafeInteger('maxFiles', maxFiles);

  const absRoot = resolve(directory);
  assertRealDirectorySync(absRoot);
  const manifest = readVerifiedManifestSync(absRoot, manifestFileName, maxManifestBytes);
  if (manifest.files.length > maxFiles) {
    throw new ArtifactVerificationError(
      'LIMIT_EXCEEDED',
      `Artifact manifest declares ${manifest.files.length} files, exceeding ${maxFiles}-file limit`,
    );
  }
  const discovered = collectArtifactFilesSync(absRoot, manifestFileName, maxFiles);

  const declaredPaths = new Set(manifest.files.map((entry) => entry.path));
  for (const relPath of declaredPaths) {
    if (!discovered.files.has(relPath)) {
      throw new ArtifactVerificationError(
        'MISSING_FILE',
        `Declared artifact file is missing from directory: ${relPath}`,
        { path: relPath },
      );
    }
  }
  for (const relPath of discovered.files) {
    if (!declaredPaths.has(relPath)) {
      throw new ArtifactVerificationError(
        'EXTRA_FILE',
        `Undeclared extra file found in artifact directory: ${relPath}`,
        { path: relPath },
      );
    }
  }
  const firstEmptyDir = discovered.emptyDirs[0];
  if (firstEmptyDir !== undefined) {
    throw new ArtifactVerificationError(
      'EXTRA_FILE',
      `Empty undeclared subdirectory found in artifact directory: ${firstEmptyDir}`,
      { path: firstEmptyDir },
    );
  }

  const verifiedFiles: VerifiedArtifactFile[] = [];
  for (const entry of manifest.files) {
    const absPath = resolve(absRoot, entry.path);
    if (!isWithinDir(absRoot, absPath)) {
      throw new ArtifactVerificationError(
        'PATH_TRAVERSAL',
        `Artifact file escapes root directory: ${entry.path}`,
        { path: entry.path },
      );
    }
    const measured = hashRegularFileNoFollowSync(absPath, entry.path, maxFileBytes);
    if (entry.size !== undefined && measured.size !== entry.size) {
      throw new ArtifactVerificationError(
        'SIZE_MISMATCH',
        `Size mismatch for ${entry.path}: expected ${entry.size}, got ${measured.size}`,
        { path: entry.path },
      );
    }
    if (entry.executable !== undefined && measured.executable !== entry.executable) {
      throw new ArtifactVerificationError(
        'EXECUTABLE_MISMATCH',
        `Executable bit mismatch for ${entry.path}: expected ${entry.executable}, got ${measured.executable}`,
        { path: entry.path },
      );
    }
    if (measured.sha256 !== entry.sha256) {
      throw new ArtifactVerificationError(
        'DIGEST_MISMATCH',
        `SHA-256 mismatch for ${entry.path}: expected ${entry.sha256}, got ${measured.sha256}`,
        { path: entry.path },
      );
    }
    verifiedFiles.push({
      path: entry.path,
      sha256: measured.sha256,
      size: measured.size,
      executable: measured.executable,
      mode: measured.mode,
    });
  }

  const verified: VerifiedArtifact = {
    directory: absRoot,
    version: manifest.version,
    manifestDigest: computeArtifactManifestDigest(manifest),
    manifest,
    files: verifiedFiles,
  };

  if (options.checkRequirements !== undefined) {
    try {
      await options.checkRequirements(verified);
    } catch (cause) {
      if (cause instanceof ArtifactVerificationError) throw cause;
      throw new ArtifactVerificationError(
        'REQUIREMENT_FAILED',
        `Artifact requirements check failed: ${messageOf(cause)}`,
        { cause },
      );
    }
  }

  return verified;
}
