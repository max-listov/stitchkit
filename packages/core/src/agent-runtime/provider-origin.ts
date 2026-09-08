import {
  InvalidToolApprovalError,
  InvalidToolApprovalSignatureError,
  ToolCallNotFoundForApprovalError,
} from 'ai';

/**
 * Which errors actually came from the provider.
 *
 * The terminal reason used to be decided by elimination: anything thrown that
 * was not a context refusal became `provider_failure`. That blamed an upstream
 * for a store conflict, for an application callback and for this runtime's own
 * refusals — including ones raised after a provider call had already succeeded,
 * where "was the provider called" cannot tell the two apart either.
 *
 * So the origin is marked where it is known, at the one boundary the runtime
 * wraps: a throw out of `doStream` is the provider failing to answer. Errors
 * the provider reports *inside* the stream arrive as `error` parts and are
 * classified at that branch instead; they never reach the catch-all.
 */
const providerOrigin = new WeakSet<object>();

/**
 * Whether the SDK refused something this runtime handed it.
 *
 * The stack is the SDK's and the timing is the provider call's, but the subject
 * is an approval this runtime issued — so the failure is this runtime's.
 */
export function isOwnInputRefusal(error: unknown): boolean {
  return (
    InvalidToolApprovalSignatureError.isInstance(error) ||
    InvalidToolApprovalError.isInstance(error) ||
    ToolCallNotFoundForApprovalError.isInstance(error)
  );
}

/** Records that this error came out of the provider call itself. */
export function markProviderOrigin<T>(error: T): T {
  if (typeof error === 'object' && error !== null) providerOrigin.add(error);
  return error;
}

/** Whether this error came out of the provider call itself. */
export function hasProviderOrigin(error: unknown): boolean {
  return typeof error === 'object' && error !== null && providerOrigin.has(error);
}
