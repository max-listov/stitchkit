import { AppError, STITCH_ERROR_STATUS } from '../../contract/errors';
import { normalizeError } from '../../contract/normalize';
import { ManagedFileError, type ManagedFileErrorCode } from '../../files/boundary';

type SafeManagedFileErrorCode = Exclude<ManagedFileErrorCode, 'FILE_IO_ERROR'>;

const SAFE_MANAGED_FILE_MESSAGES = {
  FILE_INVALID_PATH: 'Invalid managed-file path',
  FILE_OUTSIDE_ROOT: 'Managed-file path escapes its boundary',
  FILE_NOT_FOUND: 'Managed file not found',
  FILE_NOT_REGULAR: 'Managed path is not a regular file',
  FILE_INSPECTION_REJECTED: 'Managed file rejected by inspection',
  FILE_TOO_LARGE: 'Managed file exceeds the configured size limit',
  FILE_EXISTS: 'Managed file already exists',
  FILE_UNSAFE_LINK: 'Managed file link policy rejected',
  FILE_CHANGED: 'Managed file changed during read',
  FILE_UNSUPPORTED: 'Managed file capability unavailable',
} satisfies Record<SafeManagedFileErrorCode, string>;

/** Convert only caller-safe managed failures; unexpected IO retains its raw identity. */
export function managedFileAppError(error: unknown): AppError | null {
  if (!(error instanceof ManagedFileError)) return null;
  switch (error.code) {
    case 'FILE_UNSAFE_LINK':
      return new AppError('FORBIDDEN', {
        message: SAFE_MANAGED_FILE_MESSAGES[error.code],
        status: 403,
      });
    case 'FILE_CHANGED':
      return new AppError('CONFLICT', {
        message: SAFE_MANAGED_FILE_MESSAGES[error.code],
        status: 409,
      });
    case 'FILE_UNSUPPORTED':
      return new AppError('NOT_IMPLEMENTED', {
        message: SAFE_MANAGED_FILE_MESSAGES[error.code],
        status: 501,
      });

    case 'FILE_INVALID_PATH':
    case 'FILE_OUTSIDE_ROOT':
    case 'FILE_NOT_FOUND':
    case 'FILE_NOT_REGULAR':
    case 'FILE_INSPECTION_REJECTED':
    case 'FILE_TOO_LARGE':
    case 'FILE_EXISTS':
      return new AppError(error.code, {
        message: SAFE_MANAGED_FILE_MESSAGES[error.code],
        status: STITCH_ERROR_STATUS[error.code],
      });
    case 'FILE_IO_ERROR':
      return null;
  }
}

/** Partial/raw tool paths have no throwing runner, so normalize and log unknown failures here. */
export function normalizeFileToolError(error: unknown): AppError {
  return managedFileAppError(error) ?? normalizeError(error);
}
