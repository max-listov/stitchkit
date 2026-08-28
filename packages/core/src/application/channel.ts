import { z } from 'zod';

const PositiveSafeIntegerSchema = z.number().int().positive().safe();

export const BoundedChannelPolicySchema = z.enum(['ordered', 'latest']);
export type BoundedChannelPolicy = z.infer<typeof BoundedChannelPolicySchema>;

export const BoundedChannelStateSchema = z.enum(['open', 'draining', 'closed', 'failed']);
export type BoundedChannelState = z.infer<typeof BoundedChannelStateSchema>;

export const BoundedChannelSnapshotSchema = z
  .object({
    state: BoundedChannelStateSchema,
    policy: BoundedChannelPolicySchema,
    queuedItems: z.number().int().nonnegative(),
    queuedBytes: z.number().int().nonnegative(),
    waitingReader: z.boolean(),
    offered: z.number().int().nonnegative(),
    delivered: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    coalesced: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    discarded: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type BoundedChannelSnapshot = z.infer<typeof BoundedChannelSnapshotSchema>;

export interface BoundedChannelConfig<T> {
  readonly policy: BoundedChannelPolicy;
  readonly maxItems: number;
  readonly maxBytes: number;
  /** Exact retained-byte accounting chosen by the caller. */
  readonly sizeOf: (value: T) => number;
  /** Abort closes with discard semantics. */
  readonly signal?: AbortSignal;
}

export type BoundedChannelOfferResult =
  | { readonly outcome: 'delivered' }
  | { readonly outcome: 'queued' }
  | { readonly outcome: 'coalesced'; readonly replaced: 1 }
  | {
      readonly outcome: 'refused';
      readonly reason: 'not-open' | 'item-too-large' | 'item-capacity' | 'byte-capacity';
    };

export interface BoundedChannelCloseOptions {
  /** Default `drain`. */
  readonly mode?: 'drain' | 'discard';
}

export interface BoundedChannel<T> extends AsyncIterableIterator<T> {
  /** Non-blocking offer. There is deliberately no hidden writer queue. */
  offer(value: T): BoundedChannelOfferResult;
  close(options?: BoundedChannelCloseOptions): BoundedChannelSnapshot;
  fail(error: unknown): BoundedChannelSnapshot;
  getSnapshot(): BoundedChannelSnapshot;
}

export class BoundedChannelReaderError extends Error {
  constructor() {
    super('A bounded channel permits only one pending next() call');
    this.name = 'BoundedChannelReaderError';
  }
}

interface QueuedValue<T> {
  readonly value: T;
  readonly bytes: number;
}

/** Finite process-local async delivery with explicit ordered/latest overflow policy. */
export function createBoundedChannel<T>(config: BoundedChannelConfig<T>): BoundedChannel<T> {
  const policy = BoundedChannelPolicySchema.parse(config.policy);
  const maxItems = PositiveSafeIntegerSchema.parse(config.maxItems);
  const maxBytes = PositiveSafeIntegerSchema.parse(config.maxBytes);
  const queue: QueuedValue<T>[] = [];
  let state: BoundedChannelState = 'open';
  let queuedBytes = 0;
  let waiting:
    | {
        resolve(result: IteratorResult<T>): void;
        reject(error: unknown): void;
      }
    | undefined;
  let failure: unknown;
  let hasFailure = false;
  let offered = 0;
  let delivered = 0;
  let queued = 0;
  let coalesced = 0;
  let refused = 0;
  let discarded = 0;

  const removeAbortListener = (): void => {
    config.signal?.removeEventListener('abort', abortChannel);
  };

  const snapshot = (): BoundedChannelSnapshot =>
    BoundedChannelSnapshotSchema.parse({
      state,
      policy,
      queuedItems: queue.length,
      queuedBytes,
      waitingReader: waiting !== undefined,
      offered,
      delivered,
      queued,
      coalesced,
      refused,
      discarded,
    });

  const clearQueue = (): void => {
    discarded += queue.length;
    queue.length = 0;
    queuedBytes = 0;
  };

  const settleClosed = (): void => {
    if (state !== 'draining' || queue.length > 0) return;
    state = 'closed';
    removeAbortListener();
    const reader = waiting;
    waiting = undefined;
    reader?.resolve({ done: true, value: undefined });
  };

  const close = (options: BoundedChannelCloseOptions = {}): BoundedChannelSnapshot => {
    if (state === 'closed' || state === 'failed') return snapshot();
    const mode = options.mode ?? 'drain';
    if (mode !== 'drain' && mode !== 'discard') {
      throw new TypeError('Bounded channel close mode must be drain or discard');
    }
    if (mode === 'discard') {
      clearQueue();
      state = 'closed';
      removeAbortListener();
      const reader = waiting;
      waiting = undefined;
      reader?.resolve({ done: true, value: undefined });
      return snapshot();
    }
    state = 'draining';
    settleClosed();
    return snapshot();
  };

  function abortChannel(): void {
    close({ mode: 'discard' });
  }

  const channel: BoundedChannel<T> = {
    [Symbol.asyncIterator]() {
      return channel;
    },
    offer(value) {
      offered += 1;
      if (state !== 'open') {
        refused += 1;
        return { outcome: 'refused', reason: 'not-open' };
      }
      const bytes = config.sizeOf(value);
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        throw new TypeError(
          'Bounded channel sizeOf() must return a non-negative safe integer',
        );
      }
      if (bytes > maxBytes) {
        refused += 1;
        return { outcome: 'refused', reason: 'item-too-large' };
      }

      const reader = waiting;
      if (reader) {
        waiting = undefined;
        delivered += 1;
        reader.resolve({ done: false, value });
        return { outcome: 'delivered' };
      }

      if (policy === 'latest' && queue.length > 0) {
        const previous = queue[0];
        if (!previous) throw new Error('Bounded latest channel lost its pending value');
        queue[0] = { value, bytes };
        queuedBytes += bytes - previous.bytes;
        coalesced += 1;
        return { outcome: 'coalesced', replaced: 1 };
      }
      if (queue.length >= maxItems) {
        refused += 1;
        return { outcome: 'refused', reason: 'item-capacity' };
      }
      if (queuedBytes + bytes > maxBytes) {
        refused += 1;
        return { outcome: 'refused', reason: 'byte-capacity' };
      }
      queue.push({ value, bytes });
      queuedBytes += bytes;
      queued += 1;
      return { outcome: 'queued' };
    },
    next() {
      if (hasFailure) return Promise.reject(failure);
      const next = queue.shift();
      if (next) {
        queuedBytes -= next.bytes;
        delivered += 1;
        settleClosed();
        return Promise.resolve({ done: false, value: next.value });
      }
      if (state === 'closed' || state === 'draining') {
        settleClosed();
        return Promise.resolve({ done: true, value: undefined });
      }
      if (waiting) return Promise.reject(new BoundedChannelReaderError());
      return new Promise<IteratorResult<T>>((resolve, reject) => {
        waiting = { resolve, reject };
      });
    },
    return() {
      close({ mode: 'discard' });
      return Promise.resolve({ done: true, value: undefined });
    },
    throw(error?: unknown) {
      channel.fail(error);
      return Promise.reject(error);
    },
    close,
    fail(error) {
      if (state === 'closed' || state === 'failed') return snapshot();
      failure = error;
      hasFailure = true;
      state = 'failed';
      clearQueue();
      removeAbortListener();
      const reader = waiting;
      waiting = undefined;
      reader?.reject(error);
      return snapshot();
    },
    getSnapshot: snapshot,
  };

  if (config.signal?.aborted) abortChannel();
  else config.signal?.addEventListener('abort', abortChannel, { once: true });
  return channel;
}

export const CreditWindowSnapshotSchema = z
  .object({
    state: z.enum(['open', 'closed']),
    capacityBytes: PositiveSafeIntegerSchema,
    availableBytes: z.number().int().nonnegative(),
    leasedBytes: z.number().int().nonnegative(),
    acquired: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    replenishedBytes: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();
export type CreditWindowSnapshot = z.infer<typeof CreditWindowSnapshotSchema>;

export interface CreditLease {
  readonly bytes: number;
  readonly released: boolean;
  release(): void;
}

export type CreditAcquireResult =
  | { readonly outcome: 'leased'; readonly lease: CreditLease }
  | {
      readonly outcome: 'refused';
      readonly reason: 'closed' | 'larger-than-window' | 'insufficient-credit';
    };

export interface CreditWindow {
  acquire(bytes: number): CreditAcquireResult;
  close(): CreditWindowSnapshot;
  getSnapshot(): CreditWindowSnapshot;
}

/** Finite byte permission; release is local accounting, not delivery acknowledgement. */
export function createCreditWindow(config: { readonly capacityBytes: number }): CreditWindow {
  const capacityBytes = PositiveSafeIntegerSchema.parse(config.capacityBytes);
  let availableBytes = capacityBytes;
  let state: 'open' | 'closed' = 'open';
  let acquired = 0;
  let refused = 0;
  let replenishedBytes = 0;

  const snapshot = (): CreditWindowSnapshot =>
    CreditWindowSnapshotSchema.parse({
      state,
      capacityBytes,
      availableBytes,
      leasedBytes: capacityBytes - availableBytes,
      acquired,
      refused,
      replenishedBytes,
    });

  return {
    acquire(bytes) {
      const requested = PositiveSafeIntegerSchema.parse(bytes);
      if (state === 'closed') {
        refused += 1;
        return { outcome: 'refused', reason: 'closed' };
      }
      if (requested > capacityBytes) {
        refused += 1;
        return { outcome: 'refused', reason: 'larger-than-window' };
      }
      if (requested > availableBytes) {
        refused += 1;
        return { outcome: 'refused', reason: 'insufficient-credit' };
      }
      availableBytes -= requested;
      acquired += 1;
      let leaseReleased = false;
      const lease: CreditLease = {
        bytes: requested,
        get released() {
          return leaseReleased;
        },
        release() {
          if (leaseReleased) return;
          leaseReleased = true;
          availableBytes += requested;
          replenishedBytes += requested;
          if (availableBytes > capacityBytes) {
            throw new Error('Credit window accounting exceeded its capacity');
          }
        },
      };
      return { outcome: 'leased', lease };
    },
    close() {
      state = 'closed';
      return snapshot();
    },
    getSnapshot: snapshot,
  };
}
