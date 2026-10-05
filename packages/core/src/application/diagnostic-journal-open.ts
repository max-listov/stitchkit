import { z } from 'zod';
import { BoundedFileReadError, openRegularFile } from '../internal/bounded-file-read';

/**
 * The shared descriptor open of the journal readers, with their refusal type for a link or a
 * non-file. It lives apart from the public reader so its file-handle type stays out of the
 * declarations a consumer imports.
 */
export async function openJournalFile(path: string) {
  try {
    const { handle, before } = await openRegularFile(path, { rejectSymlinks: true });
    return { handle, size: z.number().int().nonnegative().parse(before.size) };
  } catch (error) {
    if (
      error instanceof BoundedFileReadError &&
      (error.code === 'FILE_UNSAFE_LINK' || error.code === 'FILE_NOT_REGULAR')
    )
      throw new TypeError(
        'Diagnostic journal reader requires a regular file, never a symlink',
        {
          cause: error,
        },
      );
    throw error;
  }
}
