import { abortError } from '../internal/abort-error';
import { raceAbort } from '../internal/abort-race';
import { withSignalDeadline } from '../internal/deadline';
import type { RelayBrokerStreamHandle, RelayBrokerStreamSink } from './broker';
import {
  DeviceRelayError,
  type DeviceRelayState,
  type DeviceRelayStreamEvent,
  type DeviceRelayStreamOpen,
} from './contract';
import type { DeviceRelayStreamOpenOptions } from './hub';
import type { HubDispatchContext } from './hub-dispatch';
import {
  createRelayStreamConsumer,
  type DeviceRelayStream,
  type SharedStreamSubscriber,
  type SharedUpstreamSubscription,
} from './hub-streams';

export type UpstreamStreamOpener = (input: {
  readonly ctx: HubDispatchContext;
  readonly device: DeviceRelayState;
  readonly openFrame: DeviceRelayStreamOpen;
  readonly sink: RelayBrokerStreamSink;
  readonly openTimeoutMs: number;
  readonly openController: AbortController;
}) => Promise<RelayBrokerStreamHandle>;

function maybeGrantSharedCredits(entry: SharedUpstreamSubscription): void {
  if (entry.closed || !entry.handle || entry.subscribers.size === 0) return;
  let minSafeCeiling = Number.POSITIVE_INFINITY;
  let minWindow = Number.POSITIVE_INFINITY;
  for (const sub of entry.subscribers) {
    const ceiling = sub.joinedAt + sub.consumed + sub.maxBufferedFrames;
    if (ceiling < minSafeCeiling) minSafeCeiling = ceiling;
    if (sub.maxBufferedFrames < minWindow) minWindow = sub.maxBufferedFrames;
  }
  const threshold = Math.max(1, Math.floor(minWindow / 2));
  const delta = minSafeCeiling - entry.grantedTotal;
  if (delta >= threshold) {
    entry.grantedTotal += delta;
    entry.handle.grantCredits(delta);
  }
}

function deliverSharedEvent(
  sharedStreams: Map<string, SharedUpstreamSubscription>,
  entry: SharedUpstreamSubscription,
  event: DeviceRelayStreamEvent,
): void {
  if (entry.closed) return;
  if (event.kind === 'data') entry.deliveredCount += 1;
  for (const sub of [...entry.subscribers]) {
    sub.controller.push(event);
  }
  if (event.kind === 'end' || event.kind === 'error') {
    entry.closed = true;
    if (sharedStreams.get(entry.key) === entry) {
      sharedStreams.delete(entry.key);
    }
  }
}

function createSharedSubscriberRecord(
  sharedStreams: Map<string, SharedUpstreamSubscription>,
  entry: SharedUpstreamSubscription,
  options: DeviceRelayStreamOpenOptions,
  maxBufferedFrames: number,
  maxFrameBytes: number,
  joinedAt: number,
): SharedStreamSubscriber {
  let recordRef: SharedStreamSubscriber | undefined;
  const controller = createRelayStreamConsumer({
    streamId: entry.streamId,
    topic: options.topic,
    deviceId: options.deviceId,
    maxBufferedFrames,
    maxFrameBytes,
    ...(options.signal !== undefined && { signal: options.signal }),
    onFrameConsumed: () => {
      if (!recordRef) return;
      recordRef.consumed += 1;
      maybeGrantSharedCredits(entry);
    },
    onClose: (reason) => {
      if (recordRef) entry.subscribers.delete(recordRef);
      if (entry.subscribers.size === 0 && !entry.closed) {
        entry.closed = true;
        if (sharedStreams.get(entry.key) === entry) sharedStreams.delete(entry.key);
        entry.openController.abort(abortError(reason ?? 'last-subscriber-gone'));
        entry.handle?.close(reason ?? 'last-subscriber-gone');
        return;
      }
      maybeGrantSharedCredits(entry);
    },
  });
  const record: SharedStreamSubscriber = {
    controller,
    joinedAt,
    maxBufferedFrames,
    consumed: 0,
  };
  recordRef = record;
  entry.subscribers.add(record);
  return record;
}

async function awaitSharedSubscriberOpen(
  sharedStreams: Map<string, SharedUpstreamSubscription>,
  entry: SharedUpstreamSubscription,
  subscriber: SharedStreamSubscriber,
  options: DeviceRelayStreamOpenOptions,
  openTimeoutMs: number,
): Promise<DeviceRelayStream> {
  try {
    await withSignalDeadline(
      openTimeoutMs,
      options.signal,
      () =>
        new DeviceRelayError('TIMEOUT', `Stream open timed out after ${openTimeoutMs}ms`, {
          deviceId: options.deviceId,
        }),
      (waitSignal) => raceAbort(entry.openPromise, waitSignal),
    );
  } catch (error) {
    subscriber.controller.stream.close('open-cancelled');
    entry.subscribers.delete(subscriber);
    if (entry.subscribers.size === 0 && !entry.closed) {
      entry.closed = true;
      if (sharedStreams.get(entry.key) === entry) sharedStreams.delete(entry.key);
      entry.openController.abort(abortError('open-cancelled'));
      entry.handle?.close('open-cancelled');
    }
    throw error;
  }
  return subscriber.controller.stream;
}

export async function openSharedRelayStream(input: {
  readonly ctx: HubDispatchContext;
  readonly device: DeviceRelayState;
  readonly options: DeviceRelayStreamOpenOptions;
  readonly shareKey: string;
  readonly openTimeoutMs: number;
  readonly maxBufferedFrames: number;
  readonly maxFrameBytes: number;
  readonly openUpstream: UpstreamStreamOpener;
}): Promise<DeviceRelayStream> {
  const {
    ctx,
    device,
    options,
    shareKey,
    openTimeoutMs,
    maxBufferedFrames,
    maxFrameBytes,
    openUpstream,
  } = input;
  const existing = ctx.sharedStreams.get(shareKey);
  if (existing && !existing.closed) {
    const joinedAt = existing.handle ? existing.deliveredCount : 0;
    const subscriber = createSharedSubscriberRecord(
      ctx.sharedStreams,
      existing,
      options,
      maxBufferedFrames,
      maxFrameBytes,
      joinedAt,
    );
    if (existing.handle) return subscriber.controller.stream;
    return awaitSharedSubscriberOpen(
      ctx.sharedStreams,
      existing,
      subscriber,
      options,
      openTimeoutMs,
    );
  }

  const streamId = crypto.randomUUID();
  const openController = new AbortController();
  const maxPreAttach = maxBufferedFrames + 1;
  const openReady = Promise.withResolvers<void>();
  // Prevent unhandled rejection when all waiting callers already cancelled/timed out before reject.
  void openReady.promise.catch(() => undefined);

  const entry: SharedUpstreamSubscription = {
    key: shareKey,
    streamId,
    openController,
    openPromise: openReady.promise,
    pendingEvents: [],
    subscribers: new Set(),
    handle: undefined,
    deliveredCount: 0,
    grantedTotal: maxBufferedFrames,
    preAttachOverflow: false,
    closed: false,
  };
  ctx.sharedStreams.set(shareKey, entry);

  const opener = createSharedSubscriberRecord(
    ctx.sharedStreams,
    entry,
    options,
    maxBufferedFrames,
    maxFrameBytes,
    0,
  );

  const sink: RelayBrokerStreamSink = {
    push(event) {
      if (entry.closed) return;
      if (!entry.handle) {
        if (entry.pendingEvents.length < maxPreAttach) {
          entry.pendingEvents.push(event);
        } else {
          entry.preAttachOverflow = true;
        }
        return;
      }
      deliverSharedEvent(ctx.sharedStreams, entry, event);
    },
  };

  const openFrame: DeviceRelayStreamOpen = {
    schemaVersion: 1,
    streamId,
    topic: options.topic,
    ...(options.params !== undefined && { params: options.params }),
    initialCredits: maxBufferedFrames,
    maxFrameBytes,
  };

  void openUpstream({
    ctx,
    device,
    openFrame,
    sink,
    openTimeoutMs,
    openController,
  }).then(
    (handle) => {
      if (entry.closed || entry.subscribers.size === 0) {
        entry.closed = true;
        if (ctx.sharedStreams.get(shareKey) === entry) ctx.sharedStreams.delete(shareKey);
        entry.pendingEvents.length = 0;
        handle.close('no-subscribers');
        openReady.resolve();
        return;
      }
      entry.handle = handle;
      for (const event of entry.pendingEvents.splice(0)) {
        deliverSharedEvent(ctx.sharedStreams, entry, event);
      }
      if (entry.preAttachOverflow && !entry.closed) {
        deliverSharedEvent(ctx.sharedStreams, entry, {
          schemaVersion: 1,
          streamId,
          kind: 'error',
          code: 'STREAM_OVERFLOW',
          message: `Relay stream exceeded its ${maxBufferedFrames}-frame buffer limit`,
          retryable: false,
        });
        handle.close('overflow');
      }
      maybeGrantSharedCredits(entry);
      openReady.resolve();
    },
    (error) => {
      entry.closed = true;
      if (ctx.sharedStreams.get(shareKey) === entry) ctx.sharedStreams.delete(shareKey);
      entry.pendingEvents.length = 0;
      for (const sub of [...entry.subscribers]) {
        sub.controller.stream.close('open-failed');
      }
      entry.subscribers.clear();
      openReady.reject(error);
    },
  );

  return awaitSharedSubscriberOpen(ctx.sharedStreams, entry, opener, options, openTimeoutMs);
}
