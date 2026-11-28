import type { BoundRealtimeClient } from '../browser/realtime-client';
import { utf8ByteLength } from '../internal/bounded-body';
import type { DeviceRelayAgentConfig, DeviceRelayUpstreamFrame } from './agent';
import {
  DeviceRelayError,
  type DeviceRelayRpcRequest,
  type DeviceRelayStreamOpen,
  type deviceRelayRealtimeContract,
} from './contract';
import {
  buildFetchRequestFromRelay,
  canonicalizeRelayPath,
  decodedBodyByteLength,
  encodeFetchResponse,
} from './encoding';

export type RelayAgentClient = BoundRealtimeClient<
  typeof deviceRelayRealtimeContract.serverToClient,
  typeof deviceRelayRealtimeContract.clientToServer
>;

export interface ActiveAgentStream {
  readonly controller: AbortController;
  credits: number;
  wakeCredit?: () => void;
  closed: boolean;
}

export interface AgentWorkLimits {
  readonly maxRequestBodyBytes: number;
  readonly maxResponseBodyBytes: number;
  readonly maxInFlightRequests: number;
  readonly maxConcurrentStreams: number;
  readonly maxStreamFrameBytes: number;
}

function matchesPathPrefix(pathname: string, pathPrefix: string): boolean {
  if (!pathPrefix.startsWith('/')) return false;
  if (pathPrefix === '/') return pathname.startsWith('/');
  if (pathPrefix.endsWith('/')) return pathname.startsWith(pathPrefix);
  return pathname === pathPrefix || pathname.startsWith(`${pathPrefix}/`);
}

export function matchesRpcAllowlist(
  allowRpc: DeviceRelayAgentConfig['allowRpc'],
  method: string,
  path: string,
): boolean {
  if (!allowRpc) return false;
  let canonical: { readonly pathname: string; readonly path: string };
  try {
    canonical = canonicalizeRelayPath(path, { allowOrigin: false });
  } catch {
    return false;
  }
  if (typeof allowRpc === 'function') return allowRpc({ method, path: canonical.path });
  const pathname = canonical.pathname;
  for (const rule of allowRpc) {
    if (
      rule.methods !== undefined &&
      !rule.methods.some((allowed) => allowed.toUpperCase() === method.toUpperCase())
    ) {
      continue;
    }
    if (rule.exactPath !== undefined && pathname !== rule.exactPath) continue;
    if (rule.pathPrefix !== undefined && !matchesPathPrefix(pathname, rule.pathPrefix))
      continue;
    if (
      rule.exactPath === undefined &&
      rule.pathPrefix === undefined &&
      rule.methods === undefined
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function matchesTopicAllowlist(
  allowTopics: DeviceRelayAgentConfig['allowStreamTopics'],
  topic: string,
): boolean {
  if (!allowTopics) return false;
  if (typeof allowTopics === 'function') return allowTopics(topic);
  return allowTopics.includes(topic);
}

export async function handleAgentRpcRequest(input: {
  readonly config: DeviceRelayAgentConfig;
  readonly client: RelayAgentClient;
  readonly limits: AgentWorkLimits;
  readonly inFlightRpcs: Map<string, AbortController>;
  readonly isClosed: () => boolean;
  readonly request: DeviceRelayRpcRequest;
}): Promise<void> {
  const { config, client, limits, inFlightRpcs, isClosed, request } = input;
  const sendError = (code: DeviceRelayError['code'], message: string, retryable?: boolean) => {
    client.emit('stitchkit.relay.rpc-response', {
      schemaVersion: 1,
      requestId: request.requestId,
      outcome: 'error',
      code,
      message,
      retryable: retryable ?? new DeviceRelayError(code, message).retryable,
    });
  };

  let canonicalPath: string;
  try {
    canonicalPath = canonicalizeRelayPath(request.path, { allowOrigin: false }).path;
  } catch (error) {
    if (error instanceof DeviceRelayError) {
      sendError(error.code, error.message, error.retryable);
      return;
    }
    sendError('INVALID_REQUEST', 'Invalid relay request path', false);
    return;
  }

  if (!matchesRpcAllowlist(config.allowRpc, request.method, canonicalPath)) {
    sendError(
      'OPERATION_NOT_ALLOWED',
      `RPC "${request.method} ${canonicalPath}" is not allowed by local device policy`,
      false,
    );
    return;
  }
  if (!config.fetch) {
    sendError(
      'OPERATION_NOT_ALLOWED',
      'Local device agent has no RPC handler configured',
      false,
    );
    return;
  }
  let bodyByteLength: number;
  try {
    bodyByteLength = decodedBodyByteLength(request.body, request.bodyEncoding);
  } catch (error) {
    if (error instanceof DeviceRelayError) {
      sendError(error.code, error.message, error.retryable);
      return;
    }
    sendError('INVALID_REQUEST', 'Invalid relay request body encoding', false);
    return;
  }
  if (bodyByteLength > limits.maxRequestBodyBytes) {
    sendError(
      'PAYLOAD_TOO_LARGE',
      `Request body exceeds device limit of ${limits.maxRequestBodyBytes} bytes`,
      false,
    );
    return;
  }
  if (inFlightRpcs.has(request.requestId)) {
    return;
  }
  if (inFlightRpcs.size >= limits.maxInFlightRequests) {
    sendError('DEVICE_BUSY', 'Local device in-flight request limit reached', true);
    return;
  }

  const canonicalRequest: DeviceRelayRpcRequest = { ...request, path: canonicalPath };
  const controller = new AbortController();
  inFlightRpcs.set(request.requestId, controller);
  try {
    const fetchRequest = buildFetchRequestFromRelay(canonicalRequest, controller.signal);
    const response = await config.fetch(fetchRequest, { signal: controller.signal });
    if (controller.signal.aborted || isClosed()) return;
    const limit = Math.min(
      limits.maxResponseBodyBytes,
      request.maxResponseBodyBytes ?? limits.maxResponseBodyBytes,
    );
    const encoded = await encodeFetchResponse(request.requestId, response, limit);
    if (controller.signal.aborted || isClosed()) return;
    client.emit('stitchkit.relay.rpc-response', encoded);
  } catch (error) {
    if (controller.signal.aborted || isClosed()) return;
    if (error instanceof DeviceRelayError) {
      sendError(error.code, error.message, error.retryable);
      return;
    }
    sendError(
      'TRANSPORT_ERROR',
      error instanceof Error ? error.message : 'Local RPC execution failed',
      false,
    );
  } finally {
    if (inFlightRpcs.get(request.requestId) === controller) {
      inFlightRpcs.delete(request.requestId);
    }
  }
}

export function handleAgentStreamOpen(input: {
  readonly config: DeviceRelayAgentConfig;
  readonly client: RelayAgentClient;
  readonly limits: AgentWorkLimits;
  readonly activeStreams: Map<string, ActiveAgentStream>;
  readonly isClosed: () => boolean;
  readonly request: DeviceRelayStreamOpen;
}): void {
  const { config, client, limits, activeStreams, isClosed, request } = input;
  if (activeStreams.has(request.streamId)) {
    return;
  }
  const refuse = (code: DeviceRelayError['code'], message: string, retryable: boolean) => {
    client.emit('stitchkit.relay.stream-open-ack', {
      schemaVersion: 1,
      streamId: request.streamId,
      outcome: 'error',
      code,
      message,
      retryable,
    });
  };
  if (!matchesTopicAllowlist(config.allowStreamTopics, request.topic)) {
    refuse(
      'OPERATION_NOT_ALLOWED',
      `Stream topic "${request.topic}" is not allowed by local device policy`,
      false,
    );
    return;
  }
  if (!config.openStream) {
    refuse('STREAM_UNAVAILABLE', 'Local device agent has no stream handler configured', false);
    return;
  }
  if (activeStreams.size >= limits.maxConcurrentStreams) {
    refuse('STREAM_CAPACITY', 'Local device stream capacity reached', true);
    return;
  }
  const streamState: ActiveAgentStream = {
    controller: new AbortController(),
    credits: request.initialCredits,
    closed: false,
  };
  activeStreams.set(request.streamId, streamState);
  void pumpAgentStream({
    config,
    client,
    maxStreamFrameBytes: limits.maxStreamFrameBytes,
    activeStreams,
    isClosed,
    request,
    streamState,
  });
}

export async function pumpAgentStream(input: {
  readonly config: DeviceRelayAgentConfig;
  readonly client: RelayAgentClient;
  readonly maxStreamFrameBytes: number;
  readonly activeStreams: Map<string, ActiveAgentStream>;
  readonly isClosed: () => boolean;
  readonly request: DeviceRelayStreamOpen;
  readonly streamState: ActiveAgentStream;
}): Promise<void> {
  const {
    config,
    client,
    maxStreamFrameBytes,
    activeStreams,
    isClosed,
    request,
    streamState,
  } = input;
  const frameLimit = Math.min(maxStreamFrameBytes, request.maxFrameBytes);
  let iterator: AsyncIterator<DeviceRelayUpstreamFrame> | undefined;
  let openAckSent = false;
  try {
    const iterable = await config.openStream?.({
      topic: request.topic,
      ...(request.cursor !== undefined && { cursor: request.cursor }),
      ...(request.params !== undefined && { params: request.params }),
      signal: streamState.controller.signal,
    });
    if (!iterable) {
      client.emit('stitchkit.relay.stream-open-ack', {
        schemaVersion: 1,
        streamId: request.streamId,
        outcome: 'error',
        code: 'STREAM_UNAVAILABLE',
        message: 'Local stream handler is unavailable',
        retryable: false,
      });
      return;
    }
    if (streamState.closed || isClosed()) return;
    iterator = iterable[Symbol.asyncIterator]();
    client.emit('stitchkit.relay.stream-open-ack', {
      schemaVersion: 1,
      streamId: request.streamId,
      outcome: 'ok',
    });
    openAckSent = true;
    while (!streamState.closed && !isClosed()) {
      while (streamState.credits <= 0 && !streamState.closed && !isClosed()) {
        await new Promise<void>((resolve) => {
          streamState.wakeCredit = resolve;
        });
        streamState.wakeCredit = undefined;
      }
      if (streamState.closed || isClosed()) break;
      const step = await iterator.next();
      if (streamState.closed || isClosed()) break;
      if (step.done) {
        client.emit('stitchkit.relay.stream-event', {
          schemaVersion: 1,
          streamId: request.streamId,
          kind: 'end',
        });
        return;
      }
      const payload = step.value.payload;
      if (utf8ByteLength(JSON.stringify(payload)) > frameLimit) {
        client.emit('stitchkit.relay.stream-event', {
          schemaVersion: 1,
          streamId: request.streamId,
          kind: 'error',
          code: 'FRAME_UNREPRESENTABLE',
          message: `Stream frame exceeded ${frameLimit} bytes`,
          retryable: false,
        });
        return;
      }
      streamState.credits -= 1;
      client.emit('stitchkit.relay.stream-event', {
        schemaVersion: 1,
        streamId: request.streamId,
        kind: 'data',
        ...(step.value.cursor !== undefined && { cursor: step.value.cursor }),
        payload,
      });
    }
  } catch (error) {
    if (streamState.closed || streamState.controller.signal.aborted || isClosed()) return;
    const relayError =
      error instanceof DeviceRelayError
        ? error
        : new DeviceRelayError(
            'STREAM_UNAVAILABLE',
            error instanceof Error ? error.message : 'Upstream stream failed',
            { retryable: false, deviceId: config.deviceId, cause: error },
          );
    if (!openAckSent) {
      client.emit('stitchkit.relay.stream-open-ack', {
        schemaVersion: 1,
        streamId: request.streamId,
        outcome: 'error',
        code: relayError.code,
        message: relayError.message,
        retryable: relayError.retryable,
      });
      return;
    }
    client.emit('stitchkit.relay.stream-event', {
      schemaVersion: 1,
      streamId: request.streamId,
      kind: 'error',
      code: relayError.code,
      message: relayError.message,
      retryable: relayError.retryable,
    });
  } finally {
    if (activeStreams.get(request.streamId) === streamState) {
      activeStreams.delete(request.streamId);
    }
    streamState.closed = true;
    await iterator?.return?.().catch(() => undefined);
  }
}
