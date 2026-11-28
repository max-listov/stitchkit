import { utf8ByteLength } from '../internal/bounded-body';
import type { RelayBrokerStreamHandle } from './broker';
import {
  DeviceRelayError,
  type DeviceRelayJsonValue,
  type DeviceRelayStreamEvent,
} from './contract';

/** One data frame yielded by `DeviceRelayStream`. */
export interface DeviceRelayStreamFrame {
  readonly cursor?: string;
  readonly payload: DeviceRelayJsonValue;
}

/** Async-iterable cursor stream returned by `DeviceRelayHub.openRelayStream`. */
export interface DeviceRelayStream extends AsyncIterable<DeviceRelayStreamFrame> {
  readonly streamId: string;
  readonly topic: string;
  readonly cursor: string | undefined;
  close(reason?: string): void;
}

export interface StreamConsumerController {
  readonly stream: DeviceRelayStream;
  push(event: DeviceRelayStreamEvent): void;
  fail(error: DeviceRelayError): void;
}

/**
 * Bounded async-iterable stream consumer enforcing `maxBufferedFrames` and `maxFrameBytes`,
 * issuing credit replenishments as frames are consumed, and closing the upstream when cancelled.
 */
export function createRelayStreamConsumer(input: {
  streamId: string;
  topic: string;
  deviceId: string;
  initialCursor?: string;
  maxBufferedFrames: number;
  maxFrameBytes: number;
  signal?: AbortSignal;
  onClose(reason?: string): void;
  onGrantCredits?(credits: number): void;
  onFrameConsumed?(): void;
}): StreamConsumerController {
  const queue: DeviceRelayStreamFrame[] = [];
  const waiters: Array<{
    resolve(result: IteratorResult<DeviceRelayStreamFrame>): void;
    reject(error: unknown): void;
  }> = [];
  let cursor = input.initialCursor;
  let ended = false;
  let failure: DeviceRelayError | undefined;
  let closedByConsumer = false;
  let consumedSinceCredit = 0;
  const replenishThreshold = Math.max(1, Math.floor(input.maxBufferedFrames / 2));

  const detachAbort = (): void => {
    input.signal?.removeEventListener('abort', onAbort);
  };

  const resolveAllWaitersDone = (): void => {
    for (const pending of waiters.splice(0)) {
      pending.resolve({ value: undefined, done: true });
    }
  };

  const finishClose = (reason?: string): void => {
    if (closedByConsumer) return;
    closedByConsumer = true;
    ended = true;
    detachAbort();
    resolveAllWaitersDone();
    input.onClose(reason);
  };

  const onAbort = (): void => {
    finishClose('aborted');
  };
  if (input.signal) {
    if (input.signal.aborted) {
      finishClose('aborted');
    } else {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const fail = (error: DeviceRelayError): void => {
    if (ended) return;
    ended = true;
    detachAbort();
    const first = waiters.shift();
    if (first) {
      first.reject(error);
      resolveAllWaitersDone();
      return;
    }
    failure = error;
  };

  const onConsumed = (): void => {
    if (ended || closedByConsumer) return;
    if (input.onFrameConsumed) {
      input.onFrameConsumed();
      return;
    }
    if (!input.onGrantCredits) return;
    consumedSinceCredit += 1;
    if (consumedSinceCredit >= replenishThreshold) {
      const grant = consumedSinceCredit;
      consumedSinceCredit = 0;
      input.onGrantCredits(grant);
    }
  };

  const push = (event: DeviceRelayStreamEvent): void => {
    if (ended || closedByConsumer) return;
    if (event.kind === 'end') {
      if (event.cursor !== undefined) cursor = event.cursor;
      ended = true;
      detachAbort();
      resolveAllWaitersDone();
      return;
    }
    if (event.kind === 'error') {
      fail(
        new DeviceRelayError(event.code, event.message, {
          retryable: event.retryable,
          deviceId: input.deviceId,
        }),
      );
      return;
    }
    const frameBytes = utf8ByteLength(JSON.stringify(event.payload));
    if (frameBytes > input.maxFrameBytes) {
      const overflow = new DeviceRelayError(
        'FRAME_UNREPRESENTABLE',
        `Relay stream frame exceeded ${input.maxFrameBytes} bytes`,
        { retryable: false, deviceId: input.deviceId },
      );
      fail(overflow);
      input.onClose('frame-too-large');
      return;
    }
    if (event.cursor !== undefined) cursor = event.cursor;
    const frame: DeviceRelayStreamFrame = {
      ...(event.cursor !== undefined && { cursor: event.cursor }),
      payload: event.payload,
    };
    const pending = waiters.shift();
    if (pending) {
      pending.resolve({ value: frame, done: false });
      onConsumed();
      return;
    }
    if (queue.length >= input.maxBufferedFrames) {
      const overflow = new DeviceRelayError(
        'STREAM_OVERFLOW',
        `Relay stream exceeded its ${input.maxBufferedFrames}-frame buffer limit`,
        { retryable: false, deviceId: input.deviceId },
      );
      fail(overflow);
      input.onClose('overflow');
      return;
    }
    queue.push(frame);
  };

  const stream: DeviceRelayStream = {
    streamId: input.streamId,
    topic: input.topic,
    get cursor() {
      return cursor;
    },
    close(reason) {
      finishClose(reason ?? 'closed');
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<DeviceRelayStreamFrame>> {
          const buffered = queue.shift();
          if (buffered !== undefined) {
            onConsumed();
            return Promise.resolve({ value: buffered, done: false });
          }
          if (failure) {
            const error = failure;
            failure = undefined;
            return Promise.reject(error);
          }
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise<IteratorResult<DeviceRelayStreamFrame>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<DeviceRelayStreamFrame>> {
          finishClose('iterator-return');
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return { stream, push, fail };
}

/** One attached subscriber on a fan-out upstream subscription (`share: true`). */
export interface SharedStreamSubscriber {
  readonly controller: StreamConsumerController;
  readonly joinedAt: number;
  readonly maxBufferedFrames: number;
  consumed: number;
}

/** Shared upstream subscription refcount and centralized credit state for fan-out streams (`share: true`). */
export interface SharedUpstreamSubscription {
  readonly key: string;
  readonly streamId: string;
  readonly openController: AbortController;
  readonly openPromise: Promise<void>;
  readonly pendingEvents: DeviceRelayStreamEvent[];
  readonly subscribers: Set<SharedStreamSubscriber>;
  handle: RelayBrokerStreamHandle | undefined;
  deliveredCount: number;
  grantedTotal: number;
  preAttachOverflow: boolean;
  closed: boolean;
}
