/**
 * A request's timing window: the incoming breadcrumb when it opens, and the
 * one completion line plus observability row when it closes.
 */

import { getRequestContext } from '../observability/context';
import type { CompleteRequest, HandlerState } from './handler-state';
import {
  buildLogFields,
  type LogFormat,
  levelForStatus,
  logIncoming,
  logOutgoing,
  type RequestLog,
  resolveLogFormat,
  shouldLog,
} from './logger';
import { collectExtraLogFields, shouldSkipLog } from './logging';
import type { LoggingConfig } from './types';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** What the window needs to know about the request it times. */
export interface RequestWindow {
  req: Request;
  url: URL;
  traceId: string;
  startedAt: bigint;
  ipAddress: string | undefined;
}

/** Open the window — writes the incoming breadcrumb — and return its closer. */
export function openRequestCompletion<TServer>(
  state: HandlerState<TServer>,
  window: RequestWindow,
): CompleteRequest {
  const { logConfig, customLogger, useDefaultLog, observability } = state;
  const { req, url, traceId, startedAt, ipAddress } = window;
  const shouldLogRequest =
    logConfig !== null &&
    shouldLog(url.pathname, req.method) &&
    !shouldSkipLog(logConfig, req, url);
  const payload =
    observability?.includePayload && BODY_METHODS.has(req.method)
      ? req
          .clone()
          .json()
          .catch(() => undefined)
      : undefined;

  // Resolved once per request, not at import and not at this package's build:
  // the environment that decides the format is the consumer's, at run time.
  const logFormat = resolveLogFormat(logConfig?.format);

  let reqLog: RequestLog | undefined;
  if (shouldLogRequest && useDefaultLog) {
    reqLog = logIncoming(req, url.pathname, traceId, logFormat, ipAddress);
  }
  if (shouldLogRequest && customLogger) {
    // The timing window opens regardless: a breadcrumb that fails must cost
    // the breadcrumb, not the completion line — and never the request.
    reqLog = { traceId };
    try {
      customLogger.debug(`${req.method} ${url.pathname}`, {
        traceId,
        method: req.method,
        path: url.pathname,
        ip: ipAddress,
      });
    } catch {
      // A logger must never break the request it observes.
    }
  }

  // At most one completion line per request, and a sink that throws can never
  // take the request with it. Both matter on the error path: `respondError`
  // calls this once for a hook-supplied response and once for the framework
  // default, and a throw in the first call would be swallowed by the
  // `onError` catch only to be re-thrown — uncaught — by the second.
  let completed = false;
  return (status, errorCode, outcome) => {
    if (completed) return;
    completed = true;
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);

    if (reqLog && logConfig) {
      try {
        writeCompletionLine(state, logConfig, window, {
          reqLog,
          status,
          durationMs,
          errorCode,
          logFormat,
        });
      } catch {
        // A logger must never break the request it observes.
      }
    }

    const context = getRequestContext();
    if (observability && context) {
      try {
        observability.complete({
          context,
          statusCode: status,
          durationMs,
          payload,
          ...(outcome !== undefined && { outcome }),
        });
      } catch {
        // An observability projection must never break the request it observes.
      }
    }
  };
}

interface CompletionLine {
  reqLog: RequestLog;
  status: number;
  durationMs: number;
  errorCode: string | undefined;
  logFormat: LogFormat;
}

/** The completion line on every active sink. Throws are the caller's to contain. */
function writeCompletionLine<TServer>(
  state: HandlerState<TServer>,
  logConfig: LoggingConfig,
  window: RequestWindow,
  line: CompletionLine,
): void {
  const { customLogger, useDefaultLog, warnedEnrichKeys, warn } = state;
  const { req, url, ipAddress } = window;
  const { reqLog, status, durationMs, errorCode, logFormat } = line;
  const collected = collectExtraLogFields(logConfig, req, url, {
    status,
    durationMs,
    errorCode,
  });
  const frameworkFields = buildLogFields(
    req.method,
    url.pathname,
    status,
    durationMs,
    reqLog.traceId,
    errorCode,
  );
  const ownedFields = { ...frameworkFields, ip: ipAddress };
  for (const key of collected.enrichKeys) {
    const ownedByActiveSink =
      Object.hasOwn(ownedFields, key) ||
      (useDefaultLog && (key === 'ts' || key === 'level' || key === 'msg'));
    if (ownedByActiveSink && !warnedEnrichKeys.has(key)) {
      warnedEnrichKeys.add(key);
      warn(
        `[stitchkit] logging.enrich field "${key}" was discarded because the framework owns it`,
      );
    }
  }
  const extra = collected.fields;
  if (useDefaultLog) {
    logOutgoing({
      req,
      pathname: url.pathname,
      status,
      log: reqLog,
      ipAddress,
      errorCode,
      durationMs,
      format: logFormat,
      extra,
    });
  }
  if (customLogger) {
    const level = levelForStatus(status);
    customLogger[level](
      `${req.method} ${url.pathname} ${status}${errorCode ? ` ${errorCode}` : ''} ${durationMs}ms`,
      {
        ...extra,
        ...frameworkFields,
        // Written last for the same reason as the rest, and present here
        // as well as on the built-in line so both sinks carry one shape.
        ip: ipAddress,
      },
    );
  }
}
