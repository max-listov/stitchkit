import { ApiError } from '../browser/http';

export type TrackingDeliveryOutcome = 'delivered' | 'failed' | 'auth-invalidated';

export interface TrackingDeliveryOptions {
  request: () => Promise<unknown>;
  onFailure: (error: unknown) => void;
  /**
   * A `401` or `403` means the session the batch was sent under is gone or
   * may no longer write. When given,
   * this is asked to recover it (re-authenticate, refresh); `true` retries the
   * batch once, `false` reports `auth-invalidated` and the batch stays queued
   * for a flush under the next session.
   */
  onUnauthorized?: () => Promise<boolean>;
  wait?: (delayMs: number) => Promise<void>;
  retryDelayMs?: number;
}

function isRetryable(error: unknown): boolean {
  return ApiError.is(error) && (error.status === 0 || error.status >= 500);
}

function isUnauthorized(error: unknown): boolean {
  return ApiError.is(error) && (error.status === 401 || error.status === 403);
}

/**
 * One batch, one bounded retry. A network failure or a `5xx` earns a single
 * second attempt after `retryDelayMs`; anything else is reported once. Nothing
 * is lost on `failed`: the batch is still in the outbox, the next flush sends
 * the same events with the same ids, and the server answers `duplicate` for
 * whatever it had already accepted.
 */
export async function deliverTrackingBatch({
  request,
  onFailure,
  onUnauthorized,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  retryDelayMs = 250,
}: TrackingDeliveryOptions): Promise<TrackingDeliveryOutcome> {
  let recovered = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await request();
      return 'delivered';
    } catch (error) {
      if (attempt === 0 && isRetryable(error)) {
        await wait(retryDelayMs);
        continue;
      }
      if (isUnauthorized(error) && onUnauthorized && !recovered) {
        recovered = true;
        if (await onUnauthorized()) continue;
        return 'auth-invalidated';
      }
      onFailure(error);
      return 'failed';
    }
  }
  return 'failed';
}
