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

  constructor(connectionName: string, instanceId: string) {
    super(`Connection "${connectionName}" requires authorization`);
    this.name = 'ConnectionAuthorizationRequiredError';
    this.connectionName = connectionName;
    this.instanceId = instanceId;
  }
}

/** Any non-2xx response other than the reauthorization signal. */
export class ConnectionRequestError extends Error {
  readonly connectionName: string;
  readonly status: number;
  readonly body: string;

  constructor(connectionName: string, status: number, body: string) {
    super(`Connection "${connectionName}" request failed with status ${status}`);
    this.name = 'ConnectionRequestError';
    this.connectionName = connectionName;
    this.status = status;
    this.body = body;
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
 * A request exceeded the connection's declared deadline. This is not exported
 * from the public subexport; it is a typed boundary between the transport and
 * the caller, so an application can still tell a timeout from a network error.
 */
export class ConnectionTimeoutError extends Error {
  readonly connectionName: string;
  readonly timeoutMs: number;

  constructor(connectionName: string, timeoutMs: number) {
    super(`Connection "${connectionName}" timed out after ${timeoutMs} ms`);
    this.name = 'ConnectionTimeoutError';
    this.connectionName = connectionName;
    this.timeoutMs = timeoutMs;
  }
}

/** A response exceeded the connection's declared byte ceiling. Internal. */
export class ConnectionResponseTooLargeError extends Error {
  readonly connectionName: string;
  readonly maxBytes: number;

  constructor(connectionName: string, maxBytes: number) {
    super(`Connection "${connectionName}" response exceeded the ${maxBytes} byte limit`);
    this.name = 'ConnectionResponseTooLargeError';
    this.connectionName = connectionName;
    this.maxBytes = maxBytes;
  }
}
