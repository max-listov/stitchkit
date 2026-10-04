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
 */

/** A `401`: the current credential was rejected and must be re-obtained. */
export class ConnectionAuthorizationRequiredError extends Error {
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
}

/** Any non-2xx response other than the reauthorization signal. */
export class ConnectionRequestError extends Error {
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
}

/** A URL the SSRF guard refused before any request left the process. */
export class ConnectionUrlError extends Error {
  readonly url: string;

  constructor(message: string, url: string) {
    super(message);
    this.name = 'ConnectionUrlError';
    this.url = url;
  }
}

/** The mount would expose more foreign tools than its declared budget. */
export class ConnectionBudgetExceededError extends Error {
  readonly limit: number;
  readonly actual: number;

  constructor(limit: number, actual: number, unit = 'tools') {
    super(`Connection surface exposes ${actual} ${unit}, above the budget of ${limit}`);
    this.name = 'ConnectionBudgetExceededError';
    this.limit = limit;
    this.actual = actual;
  }
}

/**
 * One logical operation exceeded its deadline. The original error remains
 * available to in-process observers while tools receive its safe projection.
 */
export class ConnectionTimeoutError extends Error {
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
}

/** A raw response body or legacy response frame exceeded its byte ceiling. */
export class ConnectionResponseTooLargeError extends Error {
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
}
