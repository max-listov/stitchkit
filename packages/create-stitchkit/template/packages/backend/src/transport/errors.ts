import { createErrorHook } from 'stitchkit/server';

// Deliberately not annotated as an exhaustive `Record<StitchErrorCode, …>`:
// this template compiles against both its pinned Stitchkit target and HEAD, and
// the code union differs between them. Unlisted codes travel as themselves.
const codeMap = {
  BAD_REQUEST: 'bad_request',
  VALIDATION_ERROR: 'validation_error',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  CONFLICT: 'conflict',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_SERVER_ERROR: 'internal_error',
  REALTIME_CONTRACT_VIOLATION: 'internal_error',
};

export const onError = createErrorHook({
  codeMap,
  render: (error, ctx) => ({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    },
    traceId: ctx.traceId,
  }),
});
