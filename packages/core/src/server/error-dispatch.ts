import { AppError } from '../contract/errors';
import { errorCode, normalizeError, recordedErrorMessage } from '../contract/normalize';
import type { RuntimeContext } from '../contract/runtime-context';
import type { ClientIpOptions } from '../internal/request';
import { isRecord } from '../internal/typed';
import { getRequestContext, setRequestError } from '../observability/context';
import { buildErrorContext } from './context';
import type { CompleteRequest, HandlerState, RespondError } from './handler-state';
import { applyCors, requestCorsHeaders } from './middleware/cors';
import type { LifecycleHooks, MethodDef, StitchLogger } from './types';

const MAX_REQUEST_ABORT_CAUSE_DEPTH = 8;

function containsRequestAbortReason(error: unknown, reason: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();
  for (let depth = 0; depth <= MAX_REQUEST_ABORT_CAUSE_DEPTH; depth += 1) {
    if (current === reason) return true;
    if (depth === MAX_REQUEST_ABORT_CAUSE_DEPTH || !isRecord(current)) return false;
    if (visited.has(current)) return false;
    visited.add(current);
    current = current.cause;
  }
  return false;
}

/** A client disconnect is trustworthy only when the request and error agree. */
function isClientClosedRequest(req: Request, error: unknown): boolean {
  if (!req.signal.aborted) return false;
  if (isRecord(error) && error.name === 'AbortError') return true;
  return (
    req.signal.reason !== undefined && containsRequestAbortReason(error, req.signal.reason)
  );
}

/** What the error path needs to know about the request it answers. */
export interface ErrorRequest {
  req: Request;
  url: URL;
  traceId: string;
  clientIp: ClientIpOptions;
  complete: CompleteRequest;
}

/**
 * The request's error responder. Matched group policy, global policy, then the
 * framework envelope. Routes with no contract match have no group; transport
 * cancellation bypasses both.
 */
export function createErrorResponder<TServer>(
  state: HandlerState<TServer>,
  request: ErrorRequest,
): RespondError {
  const { cors, hooks, customLogger } = state;
  const { req, url, traceId, clientIp, complete } = request;
  return async (err, errCtx, endpoint, group) => {
    if (isClientClosedRequest(req, err)) {
      const response = applyCors(
        new Response(null, { status: 499, statusText: 'Client Closed Request' }),
        cors,
        req,
      );
      complete(response.status, undefined, 'cancelled');
      return response;
    }

    // Record the failure on the request context so an audit row can name it
    // without the project hand-wiring `setRequestError` — the same thing the
    // tool row does for itself. Written after `onError` has had its turn and
    // only when nothing is there: a project that curates its own value wins,
    // a project that wires nothing still gets a row. → ADR 0042.
    //
    // `AppError.is` and `errorCode` are side-effect-free; `normalizeError` is
    // not — it logs the raw cause — so the custom-`onError` branch passes
    // nothing and must never reach for it, or customising the envelope would
    // start writing a stderr line that was not there before.
    const recordFailure = (normalized?: AppError): void => {
      if (getRequestContext()?.error !== undefined) return;
      const known = AppError.is(err) ? err : normalized;
      const code = known?.code ?? errorCode(err) ?? 'INTERNAL_SERVER_ERROR';
      setRequestError({
        code,
        message: recordedErrorMessage(code, known?.message, err),
        details: known?.details,
      });
    };

    const customResponse = await dispatchErrorHooks({
      context: errCtx ?? buildErrorContext(req, url, traceId, clientIp),
      error: err,
      endpoint,
      group,
      global: hooks,
      logger: customLogger,
      respond: (response) => {
        recordFailure();
        const withCors = applyCors(response, cors, req);
        // Hook responses keep the original error code without normalizing/logging it again.
        complete(withCors.status, errorCode(err));
        return withCors;
      },
    });
    if (customResponse) return customResponse;
    const appErr = normalizeError(err);
    recordFailure(appErr);
    complete(appErr.status, appErr.code);
    return Response.json(appErr.toJSON(), {
      status: appErr.status,
      headers: requestCorsHeaders(cors, req),
    });
  };
}

/** Route-local policy gets the first response; fallback always sees the original error. */
export async function dispatchErrorHooks(config: {
  context: RuntimeContext;
  error: unknown;
  endpoint?: MethodDef;
  group?: LifecycleHooks;
  global?: LifecycleHooks;
  logger: StitchLogger | null;
  respond: (response: Response) => Response;
}): Promise<Response | undefined> {
  for (const [scope, hooks] of [
    ['group', config.group],
    ['global', config.global],
  ] satisfies Array<[string, LifecycleHooks | undefined]>) {
    if (!hooks?.onError) continue;
    try {
      const response = await hooks.onError(config.context, config.error, config.endpoint);
      if (response instanceof Response) return config.respond(response);
    } catch (error) {
      const message = `[stitchkit] ${scope} onError failed`;
      try {
        if (config.logger) {
          config.logger.error(message, { error, traceId: config.context.traceId });
        } else console.error(message, error);
      } catch {
        // A diagnostic sink cannot replace the original request failure.
      }
    }
  }
  return undefined;
}
