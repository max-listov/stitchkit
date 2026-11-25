import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compareCodeUnits, serializeCanonicalJson } from '../internal/canonical-json';

/** Default manifest filename inside a verified artifact directory. */
export const ARTIFACT_MANIFEST_FILENAME = 'manifest.json';

/** Default maximum allowed byte size for any single artifact payload file (256 MiB). */
export const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 256 * 1024 * 1024;

/** Default maximum number of payload files allowed in one artifact directory. */
export const DEFAULT_ARTIFACT_MAX_FILES = 10_000;

/**
 * Failure classifications thrown by {@link ArtifactVerificationError}.
 */
export type ArtifactErrorCode =
  | 'INVALID_ROOT'
  | 'INVALID_MANIFEST'
  | 'PATH_TRAVERSAL'
  | 'UNSUPPORTED_ENTRY'
  | 'MISSING_FILE'
  | 'EXTRA_FILE'
  | 'DIGEST_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'EXECUTABLE_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'REQUIREMENT_FAILED'
  | 'ACTIVATION_FAILED'
  | 'ROLLBACK_FAILED';

/**
 * Structured error thrown when artifact directory verification, versioned
 * activation, or rollback fails an invariant check.
 */
export class ArtifactVerificationError extends Error {
  readonly code: ArtifactErrorCode;
  readonly path: string | undefined;

  constructor(
    code: ArtifactErrorCode,
    message: string,
    options?: ErrorOptions & { path?: string },
  ) {
    super(message, options);
    this.name = 'ArtifactVerificationError';
    this.code = code;
    this.path = options?.path;
  }
}

/**
 * Validate a relative POSIX path inside an artifact manifest, rejecting
 * traversal segments, absolute paths, backslashes, NUL bytes, and (when
 * supplied) the manifest filename itself.
 */
export function artifactRelativePathIssue(
  relPath: string,
  manifestFileName?: string,
): string | null {
  if (relPath.length === 0) return 'Artifact file path must not be empty';
  if (relPath.includes('\0')) return `Artifact file path contains NUL byte: ${relPath}`;
  if (relPath.includes('\\')) return `Artifact file path contains backslash: ${relPath}`;
  if (relPath.startsWith('/')) return `Artifact file path must be relative: ${relPath}`;
  if (relPath.endsWith('/')) return `Artifact file path must not end with '/': ${relPath}`;
  if (manifestFileName !== undefined && relPath === manifestFileName) {
    return `Artifact manifest cannot declare itself (${manifestFileName})`;
  }
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      return `Artifact file path contains invalid segment '${segment}': ${relPath}`;
    }
  }
  return null;
}

/**
 * Validate a single directory entry name (such as a release key, releases
 * folder name, or current symlink name).
 */
export function assertSafeSingleSegment(
  label: string,
  value: string,
  errorCode: ArtifactErrorCode = 'ACTIVATION_FAILED',
): void {
  if (
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    value.includes('\0') ||
    !/^[A-Za-z0-9._-]+$/.test(value)
  ) {
    throw new ArtifactVerificationError(
      errorCode,
      `${label} must be a safe single path segment: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Zod schema for one declared payload file inside an artifact manifest.
 */
export const ArtifactFileEntrySchema = z
  .strictObject({
    path: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().nonnegative().optional(),
    executable: z.boolean().optional(),
  })
  .check((ctx) => {
    const issue = artifactRelativePathIssue(ctx.value.path);
    if (issue !== null) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value.path,
        path: ['path'],
        message: issue,
      });
    }
  });

/** Declared payload file entry parsed by {@link ArtifactFileEntrySchema}. */
export type ArtifactFileEntry = z.infer<typeof ArtifactFileEntrySchema>;

/**
 * Zod schema for an artifact manifest declaring a version and exact file
 * inventory with SHA-256 checksums.
 */
export const ArtifactManifestSchema = z
  .strictObject({
    version: z.string().min(1),
    files: z.array(ArtifactFileEntrySchema).min(1),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .check((ctx) => {
    const seen = new Set<string>();
    for (let index = 0; index < ctx.value.files.length; index += 1) {
      const entry = ctx.value.files[index];
      if (!entry) continue;
      if (seen.has(entry.path)) {
        ctx.issues.push({
          code: 'custom',
          input: entry.path,
          path: ['files', index, 'path'],
          message: `Duplicate artifact file entry: ${entry.path}`,
        });
      }
      seen.add(entry.path);
    }
  });

/** Parsed artifact manifest produced by {@link ArtifactManifestSchema}. */
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

/** Compute a lowercase 64-character SHA-256 hex digest. */
export function computeSha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Compute a deterministic SHA-256 digest over a verified manifest's canonical
 * representation (files sorted in UTF-16 code-unit order by `path`).
 */
export function computeArtifactManifestDigest(manifest: ArtifactManifest): string {
  const sortedFiles = [...manifest.files].sort((left, right) =>
    compareCodeUnits(left.path, right.path),
  );
  const canonical = {
    version: manifest.version,
    files: sortedFiles,
    ...(manifest.metadata !== undefined ? { metadata: manifest.metadata } : {}),
  };
  return computeSha256Hex(serializeCanonicalJson(canonical));
}
