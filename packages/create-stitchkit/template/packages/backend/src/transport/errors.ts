import type { StitchErrorCode } from 'stitchkit';
import { createErrorHook } from 'stitchkit/server';

// The union keeps this map exhaustive on BOTH the released framework and the
// upcoming one, which adds `REALTIME_CONTRACT_VIOLATION` to `StitchErrorCode`.
// Collapse it back to `Record<StitchErrorCode, string>` after upgrading.
const codeMap: Record<StitchErrorCode | 'REALTIME_CONTRACT_VIOLATION', string> = {
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
