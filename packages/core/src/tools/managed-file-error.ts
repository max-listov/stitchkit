import { AppError, STITCH_ERROR_STATUS } from '../contract';
import { ManagedFileError, type ManagedFileErrorCode } from '../files/boundary';
import { normalizeError } from '../internal/errors';

type SafeManagedFileErrorCode = Exclude<ManagedFileErrorCode, 'FILE_IO_ERROR'>;

const SAFE_MANAGED_FILE_MESSAGES = {
  FILE_INVALID_PATH: 'Invalid managed-file path',
  FILE_OUTSIDE_ROOT: 'Managed-file path escapes its boundary',
  FILE_NOT_FOUND: 'Managed file not found',
  FILE_NOT_REGULAR: 'Managed path is not a regular file',
  FILE_INSPECTION_REJECTED: 'Managed file rejected by inspection',
  FILE_TOO_LARGE: 'Managed file exceeds the configured size limit',
  FILE_EXISTS: 'Managed file already exists',
} satisfies Record<SafeManagedFileErrorCode, string>;

/** Convert only caller-safe managed failures; unexpected IO retains its raw identity. */
export function managedFileAppError(error: unknown): AppError | null {
  if (!(error instanceof ManagedFileError)) return null;
  switch (error.code) {
    case 'FILE_INVALID_PATH':
    case 'FILE_OUTSIDE_ROOT':
    case 'FILE_NOT_FOUND':
    case 'FILE_NOT_REGULAR':
    case 'FILE_INSPECTION_REJECTED':
    case 'FILE_TOO_LARGE':
    case 'FILE_EXISTS':
      return new AppError(
        error.code,
        SAFE_MANAGED_FILE_MESSAGES[error.code],
        STITCH_ERROR_STATUS[error.code],
      );
    case 'FILE_IO_ERROR':
      return null;
  }
}

/** Partial/raw tool paths have no throwing runner, so normalize and log unknown failures here. */
export function normalizeFileToolError(error: unknown): AppError {
  return managedFileAppError(error) ?? normalizeError(error);
}
