import type { ClientFetch } from '../browser/transport';
import { abortError } from '../internal/abort-error';
import { abortReason } from '../internal/abort-race';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type {
  RelayBrokerPort,
  RelayBrokerStreamHandle,
  RelayBrokerStreamSink,
} from './broker';
import {
  DeviceRelayError,
  type DeviceRelayRpcRequest,
  type DeviceRelayRpcResponse,
  type DeviceRelayState,
  type DeviceRelayStreamEvent,
  type DeviceRelayStreamOpen,
} from './contract';
import {
  buildFetchResponseFromRelay,
  decodedBodyByteLength,
  encodeFetchRequestBody,
  normalizeRelativeRelayPath,
  normalizeRelayHeaders,
} from './encoding';
import type {
  DeviceRelayAccessRequest,
  DeviceRelayFetchOptions,
  DeviceRelayStreamOpenOptions,
} from './hub';
import { openSharedRelayStream } from './hub-shared-streams';
import {
  createRelayStreamConsumer,
  type DeviceRelayStream,
  type SharedUpstreamSubscription,
  type StreamConsumerController,
} from './hub-streams';

export interface HubDispatchContext {
  readonly broker: RelayBrokerPort;
  readonly sharedStreams: Map<string, SharedUpstreamSubscription>;
  readonly defaultRpcTimeoutMs: number;
  readonly defaultMaxRequestBytes: number;
  readonly defaultMaxResponseBytes: number;
  readonly defaultMaxStreamFrameBytes: number;
  readonly defaultMaxBufferedFrames: number;
  isClosed(): boolean;
  resolveAuthorizedDevice(
    access: Omit<DeviceRelayAccessRequest, 'deviceAccountId'>,
  ): Promise<DeviceRelayState>;
}

export function buildRelayFetch(
  ctx: HubDispatchContext,
  options: DeviceRelayFetchOptions,
): ClientFetch {
  const timeoutMs = options.timeoutMs ?? ctx.defaultRpcTimeoutMs;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? ctx.defaultMaxRequestBytes;
  const maxResponseBodyBytes = options.maxResponseBodyBytes ?? ctx.defaultMaxResponseBytes;
  assertTimerMs('DeviceRelayFetchOptions.timeoutMs', timeoutMs);
  assertPositiveSafeInteger(
    'DeviceRelayFetchOptions.maxRequestBodyBytes',
    maxRequestBodyBytes,
  );
  assertPositiveSafeInteger(
    'DeviceRelayFetchOptions.maxResponseBodyBytes',
    maxResponseBodyBytes,
  );

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (ctx.isClosed()) throw new DeviceRelayError('CLOSED', 'Device relay hub is closed');
    const isRequest = input instanceof Request;
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    const path = normalizeRelativeRelayPath(isRequest ? input.url : input);
    const device = await ctx.resolveAuthorizedDevice({
      callerAccountId: options.accountId,
      deviceId: options.deviceId,
      kind: 'rpc',
      method,
      path,
    });
    const callerSignal = init?.signal ?? (isRequest ? input.signal : undefined) ?? undefined;
    if (callerSignal?.aborted) throw abortReason(callerSignal);

    const headers = normalizeRelayHeaders(
      init?.headers ?? (isRequest ? input.headers : undefined),
      true,
    );
    const encoded = await encodeFetchRequestBody(input, init, method, maxRequestBodyBytes);
    const frame: DeviceRelayRpcRequest = {
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      method,
      path,
      headers,
      ...(encoded.body !== undefined && { body: encoded.body }),
      ...(encoded.bodyEncoding !== undefined && { bodyEncoding: encoded.bodyEncoding }),
      maxResponseBodyBytes,
    };

    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => {
      controller.abort(callerSignal ? abortReason(callerSignal) : abortError('Aborted'));
    };
    callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(
        new DeviceRelayError('TIMEOUT', `Relay RPC timed out after ${timeoutMs}ms`, {
          delivery: 'unknown',
          deviceId: options.deviceId,
        }),
      );
    }, timeoutMs);
    timer.unref?.();

    let reply: DeviceRelayRpcResponse;
    try {
      reply = await ctx.broker.forwardRpc(
        device.instanceId,
        device.deviceId,
        frame,
        controller.signal,
      );
    } catch (error) {
      if (timedOut) {
        throw new DeviceRelayError('TIMEOUT', `Relay RPC timed out after ${timeoutMs}ms`, {
          delivery: 'unknown',
          deviceId: options.deviceId,
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }

    if (reply.outcome === 'error') {
      throw new DeviceRelayError(reply.code, reply.message, {
        retryable: reply.retryable,
        delivery: 'delivered',
        deviceId: options.deviceId,
      });
    }
    if (decodedBodyByteLength(reply.body, reply.bodyEncoding) > maxResponseBodyBytes) {
      throw new DeviceRelayError(
        'PAYLOAD_TOO_LARGE',
        `Relay response body exceeds the ${maxResponseBodyBytes}-byte limit`,
        { delivery: 'delivered', deviceId: options.deviceId },
      );
    }
    return buildFetchResponseFromRelay(reply);
  };
}

async function openUpstreamWithTimeout(input: {
  readonly ctx: HubDispatchContext;
  readonly device: DeviceRelayState;
  readonly openFrame: DeviceRelayStreamOpen;
  readonly sink: RelayBrokerStreamSink;
  readonly openTimeoutMs: number;
  readonly openController: AbortController;
}): Promise<RelayBrokerStreamHandle> {
  const { ctx, device, openFrame, sink, openTimeoutMs, openController } = input;
  let timedOut = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutError = (): DeviceRelayError =>
    new DeviceRelayError('TIMEOUT', `Stream open timed out after ${openTimeoutMs}ms`, {
      deviceId: device.deviceId,
    });
  const openTimer = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const err = timeoutError();
      openController.abort(err);
      reject(err);
    }, openTimeoutMs);
    timer.unref?.();
  });

  const openCall = ctx.broker.forwardStreamOpen(
    device.instanceId,
    device.deviceId,
    openFrame,
    sink,
    openController.signal,
  );
  // If a custom broker ignores abort and resolves after timeout/cancel won, close the late handle.
  void openCall.then(
    (lateHandle) => {
      if (settled) lateHandle.close('open-abandoned');
    },
    () => undefined,
  );

  try {
    const handle = await Promise.race([openCall, openTimer]);
    settled = true;
    return handle;
  } catch (error) {
    settled = true;
    if (timedOut) {
      throw new DeviceRelayError('TIMEOUT', `Stream open timed out after ${openTimeoutMs}ms`, {
        deviceId: device.deviceId,
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function openDirectRelayStream(input: {
  readonly ctx: HubDispatchContext;
  readonly device: DeviceRelayState;
  readonly options: DeviceRelayStreamOpenOptions;
  readonly openTimeoutMs: number;
  readonly maxBufferedFrames: number;
  readonly maxFrameBytes: number;
}): Promise<DeviceRelayStream> {
  const { ctx, device, options, openTimeoutMs, maxBufferedFrames, maxFrameBytes } = input;
  const streamId = crypto.randomUUID();
  let directConsumer: StreamConsumerController | undefined;
  const pendingEvents: DeviceRelayStreamEvent[] = [];
  const maxPreAttach = maxBufferedFrames + 1;
  let preAttachOverflow = false;

  const sink: RelayBrokerStreamSink = {
    push(event) {
      if (directConsumer) {
        directConsumer.push(event);
        return;
      }
      if (pendingEvents.length < maxPreAttach) {
        pendingEvents.push(event);
      } else {
        preAttachOverflow = true;
      }
    },
  };

  const openFrame: DeviceRelayStreamOpen = {
    schemaVersion: 1,
    streamId,
    topic: options.topic,
    ...(options.cursor !== undefined && { cursor: options.cursor }),
    ...(options.params !== undefined && { params: options.params }),
    initialCredits: maxBufferedFrames,
    maxFrameBytes,
  };

  const openController = new AbortController();
  const callerSignal = options.signal;
  const onCallerAbort = (): void => {
    openController.abort(callerSignal ? abortReason(callerSignal) : abortError('Aborted'));
  };
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  let handle: RelayBrokerStreamHandle;
  try {
    handle = await openUpstreamWithTimeout({
      ctx,
      device,
      openFrame,
      sink,
      openTimeoutMs,
      openController,
    });
  } catch (error) {
    pendingEvents.length = 0;
    throw error;
  } finally {
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }

  directConsumer = createRelayStreamConsumer({
    streamId,
    topic: options.topic,
    deviceId: options.deviceId,
    ...(options.cursor !== undefined && { initialCursor: options.cursor }),
    maxBufferedFrames,
    maxFrameBytes,
    ...(options.signal !== undefined && { signal: options.signal }),
    onGrantCredits: (credits) => handle.grantCredits(credits),
    onClose: (reason) => handle.close(reason),
  });
  for (const event of pendingEvents.splice(0)) {
    directConsumer.push(event);
  }
  if (preAttachOverflow) {
    directConsumer.fail(
      new DeviceRelayError(
        'STREAM_OVERFLOW',
        `Relay stream exceeded its ${maxBufferedFrames}-frame buffer limit`,
        { retryable: false, deviceId: options.deviceId },
      ),
    );
    handle.close('overflow');
  }
  return directConsumer.stream;
}

export async function openRelayStreamOnHub(
  ctx: HubDispatchContext,
  options: DeviceRelayStreamOpenOptions,
): Promise<DeviceRelayStream> {
  if (ctx.isClosed()) throw new DeviceRelayError('CLOSED', 'Device relay hub is closed');
  const openTimeoutMs = options.openTimeoutMs ?? ctx.defaultRpcTimeoutMs;
  const maxBufferedFrames = options.maxBufferedFrames ?? ctx.defaultMaxBufferedFrames;
  const maxFrameBytes = options.maxFrameBytes ?? ctx.defaultMaxStreamFrameBytes;
  assertTimerMs('DeviceRelayStreamOpenOptions.openTimeoutMs', openTimeoutMs);
  assertPositiveSafeInteger(
    'DeviceRelayStreamOpenOptions.maxBufferedFrames',
    maxBufferedFrames,
  );
  assertPositiveSafeInteger('DeviceRelayStreamOpenOptions.maxFrameBytes', maxFrameBytes);
  if (options.signal?.aborted) throw abortReason(options.signal);

  const device = await ctx.resolveAuthorizedDevice({
    callerAccountId: options.accountId,
    deviceId: options.deviceId,
    kind: 'stream',
    topic: options.topic,
  });

  if (options.share === true && options.cursor === undefined) {
    const shareKey = `${options.accountId}:${options.deviceId}:${options.topic}:${serializeCanonicalJson(options.params ?? {})}`;
    return openSharedRelayStream({
      ctx,
      device,
      options,
      shareKey,
      openTimeoutMs,
      maxBufferedFrames,
      maxFrameBytes,
      openUpstream: openUpstreamWithTimeout,
    });
  }

  return openDirectRelayStream({
    ctx,
    device,
    options,
    openTimeoutMs,
    maxBufferedFrames,
    maxFrameBytes,
  });
}
