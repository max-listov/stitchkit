import { AppError, isRetryableStatus, STITCH_ERROR_STATUS } from '../../contract/errors';
import {
  TOOL_ERROR_PROJECTION,
  type ToolErrorProjection,
} from '../internal/tool-error-projection';
import type { ConnectionOperation, ConnectionPhase } from './types';

/** Fixed operation diagnostics accepted by typed connection failure constructors. */
export interface ConnectionFailureContext {
  operation?: ConnectionOperation;
  phase?: ConnectionPhase;
  observedReadBytes?: number;
}

/**
 * Typed failures of the external-connection surface.
 *
 * These are deliberately not `AppError`s: a connection failure is not a
 * contract error and must not be confused with one by an in-process caller.
 * The reauthorization signal is distinct because it is recoverable — the
 * application starts its existing flow — while every other status is terminal
 * for the call.
 *
 * Each class projects itself to the safe `AppError` a tool caller receives
 * (`TOOL_ERROR_PROJECTION`): only fixed diagnostic fields cross the tool
 * boundary, and the tool runner keeps the raw error as the cause.
 */

/** A `401`: the current credential was rejected and must be re-obtained. */
export class ConnectionAuthorizationRequiredError
  extends Error
  implements ToolErrorProjection
{
  readonly connectionName: string;
  readonly instanceId: string;
  readonly operation: ConnectionOperation;
  readonly phase: ConnectionPhase;

  constructor(
    connectionName: string,
    instanceId: string,
    context: ConnectionFailureContext = {},
  ) {
    super(`Connection "${connectionName}" requires authorization`);
    this.name = 'ConnectionAuthorizationRequiredError';
    this.connectionName = connectionName;
    this.instanceId = instanceId;
    this.operation = context.operation ?? 'request';
    this.phase = context.phase ?? 'call';
  }

  [TOOL_ERROR_PROJECTION](): AppError {
    const message = 'Authorization required';
    return new AppError('UNAUTHORIZED', {
      message,
      status: STITCH_ERROR_STATUS.UNAUTHORIZED,
      details: {
        message,
        reason: 'authorization-required',
        operation: this.operation,
        phase: this.phase,
      },
      hint: 'Obtain a new credential before retrying.',
      retryable: false,
    });
  }
}

/** Any non-2xx response other than the reauthorization signal. */
export class ConnectionRequestError extends Error implements ToolErrorProjection {
  readonly connectionName: string;
  readonly status: number;
  readonly body: string;
  readonly operation: ConnectionOperation;
  readonly phase: ConnectionPhase;

  constructor(
    connectionName: string,
    status: number,
    body: string,
    context: ConnectionFailureContext = {},
  ) {
    super(`Connection "${connectionName}" request failed with status ${status}`);
    this.name = 'ConnectionRequestError';
    this.connectionName = connectionName;
    this.status = status;
    this.body = body;
    this.operation = context.operation ?? 'request';
    this.phase = context.phase ?? 'call';
  }

  [TOOL_ERROR_PROJECTION](): AppError {
    const forbidden = this.status === 403;
    const code = forbidden ? 'FORBIDDEN' : 'CONNECTION_REQUEST_FAILED';
    const message = forbidden ? 'Connection access denied' : 'Connection request failed';
    return new AppError(code, {
      message,
      status: STITCH_ERROR_STATUS[code],
      details: {
        message,
        reason: forbidden ? 'permission-denied' : 'upstream-request-failed',
        operation: this.operation,
        phase: this.phase,
        upstreamStatus: this.status,
      },
      hint: forbidden
        ? 'Check the credential permissions.'
        : 'Check the upstream service and verify any write outcome before retrying.',
      retryable: !forbidden && isRetryableStatus(this.status),
    });
  }
}

/** A URL the SSRF guard refused before any request left the process. */
export class ConnectionUrlError extends Error implements ToolErrorProjection {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = 'ConnectionUrlError';
    this.url = url;
  }

  [TOOL_ERROR_PROJECTION](): AppError {
    return new AppError('BAD_REQUEST', {
      message: 'Connection URL refused',
      status: STITCH_ERROR_STATUS.BAD_REQUEST,
      details: { message: 'Connection URL refused', reason: 'url-rejected' },
      hint: 'Check the connection URL and its allowed hosts.',
      retryable: false,
    });
  }
}

/** The mount would expose more foreign tools than its declared budget. */
export class ConnectionBudgetExceededError extends Error implements ToolErrorProjection {
  readonly limit: number;
  readonly actual: number;

  constructor(limit: number, actual: number, unit = 'tools') {
    super(`Connection surface exposes ${actual} ${unit}, above the budget of ${limit}`);
    this.name = 'ConnectionBudgetExceededError';
    this.limit = limit;
    this.actual = actual;
  }

  [TOOL_ERROR_PROJECTION](): AppError {
    return new AppError('BAD_REQUEST', {
      message: 'Connection mount budget exceeded',
      status: STITCH_ERROR_STATUS.BAD_REQUEST,
      details: {
        message: 'Connection mount budget exceeded',
        reason: 'mount-budget-exceeded',
        limit: this.limit,
        actual: this.actual,
      },
      hint: 'Narrow the mounted tool surface or increase its mount budget.',
      retryable: false,
    });
  }
}

/**
 * One logical operation exceeded its deadline. The original error remains
 * available to in-process observers while tools receive its safe projection.
 */
export class ConnectionTimeoutError extends Error implements ToolErrorProjection {
  readonly connectionName: string;
  readonly timeoutMs: number;
  readonly operation: ConnectionOperation;
  readonly phase: ConnectionPhase;
  readonly observedReadBytes: number;

  constructor(
    connectionName: string,
    timeoutMs: number,
    context: ConnectionFailureContext = {},
  ) {
    super(`Connection "${connectionName}" timed out after ${timeoutMs} ms`);
    this.name = 'ConnectionTimeoutError';
    this.connectionName = connectionName;
    this.timeoutMs = timeoutMs;
    this.operation = context.operation ?? 'request';
    this.phase = context.phase ?? 'call';
    this.observedReadBytes = context.observedReadBytes ?? 0;
  }

  [TOOL_ERROR_PROJECTION](): AppError {
    const message = 'Connection deadline exceeded';
    return new AppError('CONNECTION_TIMEOUT', {
      message,
      status: STITCH_ERROR_STATUS.CONNECTION_TIMEOUT,
      details: {
        message,
        reason: 'deadline-exceeded',
        operation: this.operation,
        phase: this.phase,
        timeoutMs: this.timeoutMs,
        observedReadBytes: this.observedReadBytes,
      },
      hint: 'Check the connection deadline and verify any write outcome before retrying.',
      retryable: false,
    });
  }
}

/** A raw response body or legacy response frame exceeded its byte ceiling. */
export class ConnectionResponseTooLargeError extends Error implements ToolErrorProjection {
  readonly connectionName: string;
  readonly maxBytes: number;
  readonly operation: ConnectionOperation;
  readonly phase: ConnectionPhase;
  readonly observedReadBytes: number;

  constructor(
    connectionName: string,
    maxBytes: number,
    context: ConnectionFailureContext = {},
  ) {
    super(`Connection "${connectionName}" response exceeded the ${maxBytes} byte limit`);
    this.name = 'ConnectionResponseTooLargeError';
    this.connectionName = connectionName;
    this.maxBytes = maxBytes;
    this.operation = context.operation ?? 'request';
    this.phase = context.phase ?? 'call';
    this.observedReadBytes = context.observedReadBytes ?? 0;
  }

  [TOOL_ERROR_PROJECTION](): AppError {
    const message = 'Connection response exceeds the byte limit';
    return new AppError('CONNECTION_RESPONSE_TOO_LARGE', {
      message,
      status: STITCH_ERROR_STATUS.CONNECTION_RESPONSE_TOO_LARGE,
      details: {
        message,
        reason: 'response-too-large',
        operation: this.operation,
        phase: this.phase,
        maxResponseBytes: this.maxBytes,
        observedReadBytes: this.observedReadBytes,
      },
      hint: 'Narrow the response or increase the limit for this operation phase.',
      retryable: false,
    });
  }
}
