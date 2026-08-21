import { describe, expect, spyOn, test } from 'bun:test';
import { STITCH_ERROR_STATUS } from '../src/contract';
import { ManagedFileError, type ManagedFileErrorCode } from '../src/files/boundary';
import { managedFileAppError, normalizeFileToolError } from '../src/tools/managed-file-error';

type SafeManagedFileErrorCode = Exclude<ManagedFileErrorCode, 'FILE_IO_ERROR'>;

const safeCases: Array<{ code: SafeManagedFileErrorCode; status: number }> = [
  { code: 'FILE_INVALID_PATH', status: 400 },
  { code: 'FILE_OUTSIDE_ROOT', status: 400 },
  { code: 'FILE_NOT_FOUND', status: 404 },
  { code: 'FILE_NOT_REGULAR', status: 422 },
  { code: 'FILE_INSPECTION_REJECTED', status: 422 },
  { code: 'FILE_TOO_LARGE', status: 413 },
  { code: 'FILE_EXISTS', status: 409 },
];

describe('managed file tool errors', () => {
  test('maps every registered safe code without exposing the boundary message', () => {
    for (const fixture of safeCases) {
      expect(STITCH_ERROR_STATUS[fixture.code]).toBe(fixture.status);
      const error = managedFileAppError(
        new ManagedFileError(fixture.code, 'sensitive derived path: /srv/private/root'),
      );
      expect(error).toMatchObject({ code: fixture.code, status: fixture.status });
      expect(error?.message).not.toContain('/srv/private/root');
    }
    expect('FILE_IO_ERROR' in STITCH_ERROR_STATUS).toBe(false);
  });

  test('logs and scrubs FILE_IO_ERROR and unknown failures through the canonical normalizer', () => {
    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const io = normalizeFileToolError(
        new ManagedFileError('FILE_IO_ERROR', 'read /srv/private/root/token failed'),
      );
      const unknown = normalizeFileToolError(new Error('socket /srv/private/root failed'));
      expect(io).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        status: 500,
      });
      expect(unknown).toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Internal server error',
        status: 500,
      });
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });
});
