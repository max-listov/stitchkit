import { isRecord } from '../internal/typed';
import { ApiError } from './api-error';
import type { ClientRequestExecutor } from './client-executors';

/**
 * Turn a server's "I could not route this" into `UNKNOWN_OPERATION` naming the
 * contract operation.
 *
 * The server knows only the method and path it could not route; the client
 * knows which operation it was calling. Both routing refusals mean the same
 * thing to a contract client, which always calls with the method its contract
 * declares: no route at all (`UNKNOWN_OPERATION`), and a path this server
 * routes under another method only (`METHOD_NOT_ALLOWED`). A caller reading
 * `details.operation` learns that this server does not have the operation —
 * a different fact from the operation answering `NOT_FOUND`.
 */
/**
 * Whether the server's router, not a handler, refused the call. The router's
 * `405` carries the methods the path does answer (`details.allow`); a handler
 * throwing its own `METHOD_NOT_ALLOWED` carries no such list and stays what it is.
 */
function isRoutingRefusal(error: ApiError): boolean {
  if (error.code === 'UNKNOWN_OPERATION') return true;
  return (
    error.code === 'METHOD_NOT_ALLOWED' &&
    isRecord(error.details) &&
    Array.isArray(error.details.allow)
  );
}

export function namedOperation(
  execute: ClientRequestExecutor,
  operation: string,
): ClientRequestExecutor {
  return (requestArgs, options) =>
    execute(requestArgs, options).catch((error: unknown) => {
      if (!(error instanceof ApiError) || !isRoutingRefusal(error)) throw error;
      throw new ApiError('UNKNOWN_OPERATION', {
        status: error.status,
        message: error.message,
        details: { ...(isRecord(error.details) ? error.details : {}), operation },
        hint: error.hint,
        traceId: error.traceId,
        retryable: error.retryable,
        cause: error,
      });
    });
}
