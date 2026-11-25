/**
 * Errors of the window-side bridge transport and the one answer to whether a call that failed
 * with one may be replayed.
 */
import type { BridgeFailureCode } from '../contract/bridge-envelope';

/** Transport-level error raised when the bridge host answers with a `failure` frame. */
export class BridgeFailureError extends TypeError {
  readonly code: BridgeFailureCode;

  constructor(code: BridgeFailureCode, message?: string) {
    super(message ?? `Bridge failure: ${code}`);
    this.name = 'BridgeFailureError';
    this.code = code;
  }
}

const RETRYABLE_BRIDGE_ERRORS = new WeakSet<object>();
const NON_RETRYABLE_BRIDGE_ERRORS = new WeakSet<object>();

/** The host announced a new instance: calls in flight were lost, and an idempotent one may repeat. */
export function createBridgeRestartError(): TypeError {
  const error = new TypeError('Bridge host restarted');
  RETRYABLE_BRIDGE_ERRORS.add(error);
  return error;
}

/** The window closed its bridge fetch: nothing it sends again would be answered. */
export function createBridgeClosedError(message: string): TypeError {
  const error = new TypeError(message);
  NON_RETRYABLE_BRIDGE_ERRORS.add(error);
  return error;
}

/** A reply this window cannot use: the same host would send it again, so it is never replayed. */
export function createUnusableReplyError(message: string, cause?: unknown): TypeError {
  const error = new TypeError(message, cause === undefined ? undefined : { cause });
  NON_RETRYABLE_BRIDGE_ERRORS.add(error);
  return error;
}

/**
 * Classify a bridge transport error for replay:
 * - `true`: transient transport loss (`Bridge host restarted`, `host-busy`) — safe to replay on idempotent calls.
 * - `false`: deterministic refusal or closed bridge (`refused`, `unsupported`, `frame-too-large`, `duplicate-id`, `host-error`, closed, a reply this window cannot use) — never replay.
 * - `undefined`: not a bridge transport error.
 */
export function classifyBridgeTransportRetry(error: unknown): boolean | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  if (NON_RETRYABLE_BRIDGE_ERRORS.has(error)) return false;
  if (RETRYABLE_BRIDGE_ERRORS.has(error)) return true;
  if (error instanceof BridgeFailureError) {
    return error.code === 'host-busy';
  }
  return undefined;
}
