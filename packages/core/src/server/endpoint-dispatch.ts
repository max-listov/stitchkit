/**
 * A matched contract endpoint, from its base context to its response: params,
 * the auth gates, the payload, `beforeHandle`, the handler itself. Every
 * failure on the way — a consumer hook's included — takes the endpoint's error
 * path with the context bound so far.
 */

import { AppError, badRequest } from '../contract/errors';
import { abortError } from '../internal/abort-error';
import { linkAbortSignals } from '../internal/abort-race';
import {
  createRemainingTimeoutReader,
  DEADLINE_BUDGET_HEADER,
  resolveServerDeadlineBudget,
} from '../internal/deadline-budget';
import { MalformedQueryError } from '../internal/request';
import { getRequestContext } from '../observability/context';
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
  const { hooks, config } = state;
  const { req, url, traceId, clientIp } = request;
  const { method, pathParams, groupHooks } = match;
  // The base context is everything knowable from the URL alone — bound before
  // any schema parsing, so a validation failure still gives `onError` the path
  // params and the request instead of an empty context.
  const ctx = buildBaseContext(req, url, pathParams, traceId, clientIp);
  // Surface the matched operation's stable identity into the request context
  // before validation — a no-op without an active observability context, so an
  // audit event is attributed to its `(service, action)` even on a 400. → ADR 0022 / 0029.
  const activeContext = request.context ?? getRequestContext();
  if (activeContext) {
    activeContext.serviceName = method.serviceName;
    activeContext.action = method.key;
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineLink: { readonly signal: AbortSignal; release(): void } | undefined;
  let deadlineOwnedByStream = false;
  const releaseDeadline = (): void => {
    if (deadlineTimer !== undefined) {
      clearTimeout(deadlineTimer);
      deadlineTimer = undefined;
    }
    deadlineLink?.release();
    deadlineLink = undefined;
  };

  let multipartLifecycle: Awaited<ReturnType<typeof parseRequestPayloadInto>>;
  try {
    const budget = resolveServerDeadlineBudget({
      headerValue: req.headers.get(DEADLINE_BUDGET_HEADER),
      endpointTimeoutMs: method.timeout,
    });
    if (budget.kind === 'bounded') {
      const deadlineAt = performance.now() + budget.budgetMs;
      const deadlineController = new AbortController();
      deadlineTimer = setTimeout(() => {
        deadlineController.abort(abortError('Request deadline exceeded', 'TimeoutError'));
      }, budget.budgetMs);
      deadlineTimer.unref?.();
      deadlineLink = linkAbortSignals(req.signal, deadlineController.signal);
      ctx.signal = deadlineLink.signal;
      ctx.remainingTimeoutMs = createRemainingTimeoutReader(deadlineAt);
    } else if (budget.kind === 'expired') {
      ctx.remainingTimeoutMs = () => 0;
    } else {
      ctx.remainingTimeoutMs = () => undefined;
    }

    parsePathParamsInto(ctx, method);

    if (hooks?.authorize) {
      await hooks.authorize(ctx, method);
    }
    if (groupHooks?.authorize) {
      await groupHooks.authorize(ctx, method);
    }

    if (budget.kind === 'expired') {
      throw new AppError('REQUEST_TIMEOUT', {
        status: 408,
        message: 'Request deadline budget exhausted',
      });
    }

    try {
      multipartLifecycle = await parseRequestPayloadInto(
        ctx,
        req,
        url,
        method,
        config.maxJsonBodyBytes,
        request.cors,
      );
    } catch (payloadError) {
      if (payloadError instanceof MalformedQueryError) {
        badRequest(payloadError.message);
      }
      throw payloadError;
    }

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
      const signal = ctx.signal ?? req.signal;
      if (signal.aborted) streamAbort.abort(signal.reason);
      else {
        signal.addEventListener('abort', () => streamAbort.abort(signal.reason), {
          once: true,
        });
      }
      streamAbort.signal.addEventListener('abort', releaseDeadline, { once: true });
      ctx.signal = streamAbort.signal;
    }

    const result = await method.handler(ctx);
    // Awaited here, not returned: a throw while shaping the response belongs
    // to this endpoint's error path, with its context, group and rollback.
    const response = await endpointResponse(state, request, {
      ctx,
      match,
      result,
      responseMetadata,
      streamAbort,
    });
    if (streamAbort && !streamAbort.signal.aborted) {
      deadlineOwnedByStream = true;
    }
    return response;
  } catch (err) {
    await multipartLifecycle?.rollback();
    return request.respondError(err, ctx, method, groupHooks);
  } finally {
    if (!deadlineOwnedByStream) releaseDeadline();
  }
}
