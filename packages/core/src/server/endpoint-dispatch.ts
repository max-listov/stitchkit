/**
 * A matched contract endpoint, from its base context to its response: params,
 * the auth gates, the payload, `beforeHandle`, the handler itself. Every
 * failure on the way — a consumer hook's included — takes the endpoint's error
 * path with the context bound so far.
 */

import { setRequestEndpoint } from '../observability/context';
import { buildBaseContext, parsePathParamsInto, parseRequestPayloadInto } from './context';
import { endpointResponse } from './endpoint-response';
import type { HandlerState, RequestState } from './handler-state';
import { createResponseMetadata } from './response-metadata';
import type { RouteMatch } from './router';

export async function dispatchEndpoint<TServer>(
  state: HandlerState<TServer>,
  request: RequestState<TServer>,
  match: RouteMatch,
): Promise<Response> {
  const { hooks, config, cors } = state;
  const { req, url, traceId, clientIp } = request;
  const { method, pathParams, groupHooks } = match;
  // The base context is everything knowable from the URL alone — bound before
  // any schema parsing, so a validation failure still gives `onError` the path
  // params and the request instead of an empty context.
  const ctx = buildBaseContext(req, url, pathParams, traceId, clientIp);
  // Surface the matched operation's stable identity into the request context
  // before validation — a no-op without an active observability context, so an
  // audit event is attributed to its `(service, action)` even on a 400. → ADR 0022 / 0029.
  setRequestEndpoint(method.serviceName, method.key);

  let multipartLifecycle: Awaited<ReturnType<typeof parseRequestPayloadInto>>;
  try {
    parsePathParamsInto(ctx, method);

    if (hooks?.authorize) {
      await hooks.authorize(ctx, method);
    }
    if (groupHooks?.authorize) {
      await groupHooks.authorize(ctx, method);
    }

    multipartLifecycle = await parseRequestPayloadInto(
      ctx,
      req,
      url,
      method,
      config.maxJsonBodyBytes,
      cors,
    );

    if (hooks?.beforeHandle) {
      await hooks.beforeHandle(ctx, method);
    }
    if (groupHooks?.beforeHandle) {
      await groupHooks.beforeHandle(ctx, method);
    }

    const responseMetadata = method.responseMeta ? createResponseMetadata() : undefined;
    if (responseMetadata) ctx.response = responseMetadata;

    const streamAbort = method.stream ? new AbortController() : undefined;
    if (streamAbort) {
      if (req.signal.aborted) streamAbort.abort(req.signal.reason);
      else {
        req.signal.addEventListener('abort', () => streamAbort.abort(req.signal.reason), {
          once: true,
        });
      }
      ctx.signal = streamAbort.signal;
    }

    const result = await method.handler(ctx);
    // Awaited here, not returned: a throw while shaping the response belongs
    // to this endpoint's error path, with its context, group and rollback.
    return await endpointResponse(state, request, {
      ctx,
      match,
      result,
      responseMetadata,
      streamAbort,
    });
  } catch (err) {
    await multipartLifecycle?.rollback();
    return request.respondError(err, ctx, method, groupHooks);
  }
}
