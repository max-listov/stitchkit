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
 * wraps: a throw out of `doStream` is the provider failing to answer, and so
 * is a rejected read of the stream it returned — a connection cut mid-answer.
 * Bun 1.3 delivered that cut as an `error` part; Bun 1.4 rejects the read, and
 * the unmarked error was blamed on the runtime. Errors the provider reports
 * *inside* the stream arrive as `error` parts and are classified at that
 * branch instead; they never reach the catch-all.
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

/**
 * The provider's stream, with every failed read marked as the provider's.
 *
 * Only reads of this stream pass through here: the runtime's own work on the
 * parts happens downstream, so its failures stay unmarked.
 */
export function markProviderStream<T>(stream: ReadableStream<T>): ReadableStream<T> {
  const reader = stream.getReader();
  return new ReadableStream<T>({
    async pull(controller) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        controller.error(isOwnInputRefusal(error) ? error : markProviderOrigin(error));
        return;
      }
      if (read.done) controller.close();
      else controller.enqueue(read.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
