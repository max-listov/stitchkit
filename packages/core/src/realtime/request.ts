export interface RealtimeRequestOptions {
  /** Maximum acknowledgement wait in milliseconds. Must be finite and > 0. */
  timeoutMs: number;
}

export class RealtimeRequestTimeoutError extends Error {
  readonly code = 'REALTIME_REQUEST_TIMEOUT';
  readonly event: string;
  readonly timeoutMs: number;

  constructor(event: string, timeoutMs: number) {
    super(`Realtime request "${event}" timed out after ${timeoutMs}ms`);
    this.name = 'RealtimeRequestTimeoutError';
    this.event = event;
    this.timeoutMs = timeoutMs;
  }
}

export class RealtimeRequestDisconnectedError extends Error {
  readonly code = 'REALTIME_REQUEST_DISCONNECTED';
  readonly event: string;

  constructor(event: string) {
    super(`Realtime request "${event}" was interrupted by disconnect`);
    this.name = 'RealtimeRequestDisconnectedError';
    this.event = event;
  }
}

export class RealtimeRequestInvalidAcknowledgementError extends Error {
  readonly code = 'REALTIME_REQUEST_INVALID_ACKNOWLEDGEMENT';
  readonly event: string;

  constructor(event: string, cause: unknown) {
    super(`Realtime request "${event}" received an invalid acknowledgement`, { cause });
    this.name = 'RealtimeRequestInvalidAcknowledgementError';
    this.event = event;
  }
}
