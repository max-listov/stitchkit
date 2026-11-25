/**
 * A request's timing window: the incoming breadcrumb when it opens, and the
 * one completion line plus observability row when it closes.
 */

import { readBoundedText } from '../internal/bounded-body';
import { getRequestContext, type RequestContext } from '../observability/context';
import type { CompleteRequest, HandlerState } from './handler-state';
import {
  buildLogFields,
  type LogFormat,
  levelForStatus,
  logIncoming,
  logOutgoing,
  type RequestLog,
  type RequestLogLevel,
  resolveLogFormat,
  shouldLog,
} from './logger';
import { collectExtraLogFields, shouldSkipLog } from './logging';
import { isProtocolOutcome } from './protocol-outcome';
import type { LoggingConfig } from './types';

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Audit body limit when neither the sink nor the handler names one. */
const DEFAULT_PAYLOAD_LOG_BYTES = 1024 * 1024;

/** What an audit row learned of the request body. */
interface PayloadRead {
  value: unknown;
  truncated: boolean;
}

/**
 * The JSON of a request clone for the audit row. The clone is one branch of a tee: a branch read
 * without a limit drains the whole body into memory even when the handler's own branch was cut at
 * `maxJsonBodyBytes`. A body past `maxBytes` is cancelled and reported as truncated.
 */
async function readPayload(clone: Request, maxBytes: number): Promise<PayloadRead> {
  try {
    const result = await readBoundedText(clone, { maxBytes, signal: clone.signal });
    if (result.kind === 'over-limit') return { value: undefined, truncated: true };
    return { value: JSON.parse(result.text), truncated: false };
  } catch {
    return { value: undefined, truncated: false };
  }
}

/** What the window needs to know about the request it times. */
export interface RequestWindow {
  req: Request;
  url: URL;
  traceId: string;
  startedAt: number;
  ipAddress: string | undefined;
  context?: RequestContext;
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
  const payloadRead =
    observability?.includePayload && BODY_METHODS.has(req.method)
      ? readPayload(
          req.clone(),
          observability.payloadMaxBytes ??
            state.config.maxJsonBodyBytes ??
            DEFAULT_PAYLOAD_LOG_BYTES,
        )
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
  return (answer, errorCode, outcome) => {
    if (completed) return;
    completed = true;
    const status = typeof answer === 'number' ? answer : answer.status;
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));

    if (reqLog && logConfig) {
      try {
        writeCompletionLine(state, logConfig, window, {
          reqLog,
          status,
          level: answerLevel(answer, status),
          durationMs,
          errorCode,
          logFormat,
        });
      } catch {
        // A logger must never break the request it observes.
      }
    }

    const context = window.context ?? getRequestContext();
    if (observability && context) {
      try {
        observability.complete({
          context,
          statusCode: status,
          durationMs,
          ...(payloadRead && {
            payload: payloadRead.then((read) => read.value),
            payloadTruncated: payloadRead.then((read) => read.truncated),
          }),
          ...(outcome !== undefined && { outcome }),
        });
      } catch {
        // An observability projection must never break the request it observes.
      }
    }
  };
}

/** One level per request: from the status, lowered for a `4xx` its builder marked a protocol outcome. */
function answerLevel(answer: number | Response, status: number): RequestLogLevel {
  const marked = typeof answer !== 'number' && isProtocolOutcome(answer);
  return levelForStatus(status, marked ? 'protocol' : undefined);
}

interface CompletionLine {
  reqLog: RequestLog;
  status: number;
  level: RequestLogLevel;
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
  const { reqLog, status, level, durationMs, errorCode, logFormat } = line;
  const collected = collectExtraLogFields(
    logConfig,
    req,
    url,
    {
      status,
      durationMs,
      errorCode,
    },
    window.context,
  );
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
      level,
      log: reqLog,
      ipAddress,
      errorCode,
      durationMs,
      format: logFormat,
      extra,
    });
  }
  if (customLogger) {
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
