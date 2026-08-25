import type { RealtimeRejectionIssue } from './rejected-frame';

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

/**
 * The peer refused the frame against its own copy of the contract, and said so.
 *
 * Distinct from `RealtimeRequestTimeoutError` on purpose, and that distinction
 * is the whole point: a refusal used to BE a timeout, so a version skew looked
 * exactly like a network fault — symmetrically, on every plane at once. It is
 * also distinct from `RealtimeRequestInvalidAcknowledgementError`, which means
 * the peer answered with something its own contract does not allow; this one
 * means the peer never got as far as answering.
 */
export class RealtimeRequestRejectedError extends Error {
  readonly code = 'REALTIME_REQUEST_REJECTED';
  readonly event: string;
  /**
   * Why the peer refused it. `invalid-arguments` is the version-skew shape and
   * what a peer on this release sends; a later release may name others, so
   * compare rather than exhaustively switch.
   */
  readonly reason: string;
  /** The fields the peer refused, when it named any — validated on arrival. */
  readonly issues: RealtimeRejectionIssue[] | undefined;

  constructor(
    event: string,
    reason: string,
    detail: string,
    issues?: RealtimeRejectionIssue[],
  ) {
    super(`Realtime request "${event}" was rejected by the peer (${reason}): ${detail}`);
    this.name = 'RealtimeRequestRejectedError';
    this.event = event;
    this.reason = reason;
    this.issues = issues;
  }
}
