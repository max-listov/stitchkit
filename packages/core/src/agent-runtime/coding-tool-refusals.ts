/**
 * The refusals a coding tool is allowed to hand a model.
 *
 * Every ordinary outcome of these tools used to be a plain `Error`, and
 * `toolResultFromError` scrubs anything that is not an `AppError` down to a bare
 * `INTERNAL_SERVER_ERROR`. That scrub is right — an internal cause must not
 * leave the process — and it left the model blind: a missing file, a snippet
 * that matched three times and a file that already exists all arrived as the
 * same empty server fault. Observed consequence: after two of them a model
 * concluded the tool was unavailable and stopped using it.
 *
 * The boundary is the layer, not the errno. A model is an operator INSIDE the
 * workspace: a refusal phrased from a relative path and the facts of its own
 * request tells it nothing it could not read with `read_file`. So typed
 * refusals are constructed here, in the tool layer, from context this layer
 * knows; `contained-files.ts` stays `AppError`-free, and everything it throws
 * keeps being scrubbed. Default-deny: a cause with no case here is internal.
 */

import { AppError } from '../contract/errors';

/** Codes a coding tool may hand a model, with the status each one carries. */
const REFUSAL_STATUS = {
  BAD_REQUEST: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
} as const;

export type CodingRefusalCode = keyof typeof REFUSAL_STATUS;

/**
 * Refuse with a reason the model actually receives.
 *
 * `message` is copied INTO `details` on purpose. `toolResultFromError` renders
 * `details: appErr.details ?? { message }` — structured details displace the
 * message entirely, so the natural way to write an informative refusal (a
 * count plus a sentence) would have arrived as `{"occurrences":3}` with no
 * sentence at all. Putting the sentence inside the details it travels with
 * makes that unrepresentable rather than merely discouraged.
 *
 * `hint` is where the *instruction* goes — what to do next — and reaches the
 * model as `_hint` through the Agent tool envelope.
 */
export function codingRefusal(
  code: CodingRefusalCode,
  message: string,
  options: { details?: Record<string, unknown>; hint?: string } = {},
): never {
  throw new AppError(
    code,
    message,
    REFUSAL_STATUS[code],
    { message, ...options.details },
    options.hint,
  );
}

/** The workspace path a refusal may name — never a host path. */
export function codingPathRefusal(
  code: CodingRefusalCode,
  message: string,
  path: string,
  options: { details?: Record<string, unknown>; hint?: string } = {},
): never {
  codingRefusal(code, message, {
    details: { path, ...options.details },
    ...(options.hint && { hint: options.hint }),
  });
}

/**
 * Translate the two errno families a caller can act on; re-throw the rest.
 *
 * Only these two are ordinary: the path the model named is not there, or a
 * segment of it is not a directory. Everything else — EACCES, ENOSPC, a broken
 * native binding, a root that vanished — is a host-level cause with nothing the
 * model can do about it, and keeps being scrubbed. Default-deny by omission.
 */
export function refuseMissingCodingPath(error: unknown, relative: string): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // The containment layer states this one in words rather than an errno, and it
  // is the commonest way a model asks for a directory as if it were a file.
  if (error instanceof Error && error.message.includes('is not a regular file')) {
    codingPathRefusal('BAD_REQUEST', 'This path is not a regular file', relative, {
      hint: 'Use list_directory to see what is here.',
    });
  }
  if (code === 'ENOENT') {
    codingPathRefusal('NOT_FOUND', 'This path does not exist', relative, {
      hint: 'Use list_directory or glob to find the right path.',
    });
  }
  if (code === 'ENOTDIR') {
    codingPathRefusal('BAD_REQUEST', 'A segment of this path is not a directory', relative, {
      hint: 'Check the path with list_directory.',
    });
  }
  if (code === 'ELOOP') {
    // `O_NOFOLLOW` reports a symlink this way. Coding tools never follow one —
    // that is how the root stays a boundary — and a model that asked for one
    // needs to be told, not handed an empty fault.
    codingPathRefusal('FORBIDDEN', 'This path is a symlink, which is not followed', relative, {
      hint: 'Read or write the target directly, by its own workspace-relative path.',
    });
  }
  if (code === 'EISDIR') {
    codingPathRefusal('BAD_REQUEST', 'This path is not a regular file', relative, {
      hint: 'Use list_directory to see what is here.',
    });
  }
  throw error;
}
