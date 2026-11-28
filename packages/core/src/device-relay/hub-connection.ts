import { abortError } from '../internal/abort-error';
import { abortReason } from '../internal/abort-race';
import type { StitchLogger } from '../internal/logger';
import type {
  RelayBrokerPort,
  RelayBrokerStreamHandle,
  RelayBrokerStreamSink,
} from './broker';
import {
  DeviceRelayError,
  type DeviceRelayOfflineReason,
  type DeviceRelayRpcRequest,
  type DeviceRelayRpcResponse,
  type DeviceRelayState,
  type DeviceRelayStreamEvent,
  type DeviceRelayStreamOpen,
  type DeviceRelayStreamOpenAck,
} from './contract';
import type { DeviceRelayHubConfig, DeviceRelayServerConnection } from './hub';
import {
  type ConnectionBinding,
  handleDeviceHeartbeat,
  handleDeviceHello,
} from './hub-handshake';

export interface LocalPendingRpc {
  resolve(response: DeviceRelayRpcResponse): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export interface LocalOpenStream {
  readonly sink: RelayBrokerStreamSink;
  resolveOpen?: (ack: DeviceRelayStreamOpenAck) => void;
  opened: boolean;
}

export interface LocalDeviceSession<TIdentity> {
  state: DeviceRelayState;
  readonly effectiveLeaseMs: number;
  readonly connection: DeviceRelayServerConnection<TIdentity>;
  readonly binding: ConnectionBinding<TIdentity>;
  readonly inFlightRpcs: Map<string, LocalPendingRpc>;
  readonly openStreams: Map<string, LocalOpenStream>;
}

export interface HubRuntime<TIdentity> {
  readonly instanceId: string;
  readonly broker: RelayBrokerPort;
  readonly config: DeviceRelayHubConfig<TIdentity>;
  readonly leaseTtlMs: number;
  readonly maxInFlightPerDevice: number;
  readonly maxStreamsPerDevice: number;
  readonly now: () => number;
  readonly localDevices: Map<string, LocalDeviceSession<TIdentity>>;
  readonly socketCleanups: Set<() => void>;
  readonly logger: StitchLogger | undefined;
  isClosed(): boolean;
  notifyState(state: DeviceRelayState): void;
}

export function observeHubBackground(
  logger: StitchLogger | undefined,
  operation: string,
  run: () => void | Promise<void>,
): void {
  try {
    const pending = run();
    if (pending !== undefined) {
      void Promise.resolve(pending).catch((error: unknown) => {
        logger?.warn(`DeviceRelayHub ${operation} failed`, { error });
      });
    }
  } catch (error: unknown) {
    logger?.warn(`DeviceRelayHub ${operation} failed`, { error });
  }
}

export async function teardownLocalDevice<TIdentity>(
  runtime: HubRuntime<TIdentity>,
  deviceId: string,
  expected: LocalDeviceSession<TIdentity> | undefined,
  reason: DeviceRelayOfflineReason,
): Promise<void> {
  const session = runtime.localDevices.get(deviceId);
  if (!session || (expected && session !== expected)) return;
  runtime.localDevices.delete(deviceId);
  if (session.binding.activeSession === session) {
    session.binding.activeSession = undefined;
    session.binding.activeDeviceId = undefined;
  }
  session.state = { ...session.state, status: 'offline', offlineReason: reason };
  try {
    await runtime.broker.markDeviceOffline({
      deviceId,
      instanceId: runtime.instanceId,
      reason,
    });
  } catch (error) {
    runtime.logger?.warn('DeviceRelayHub broker markDeviceOffline failed', {
      deviceId,
      reason,
      error,
    });
  }
  runtime.notifyState(session.state);

  const rpcError = new DeviceRelayError(
    'DELIVERY_UNKNOWN',
    `Device "${deviceId}" went offline (${reason}) while request was in flight`,
    { retryable: false, delivery: 'unknown', deviceId },
  );
  for (const pending of session.inFlightRpcs.values()) {
    pending.cleanup();
    pending.reject(rpcError);
  }
  session.inFlightRpcs.clear();

  for (const [streamId, open] of session.openStreams) {
    if (!open.opened && open.resolveOpen) {
      open.resolveOpen({
        schemaVersion: 1,
        streamId,
        outcome: 'error',
        code: 'DEVICE_OFFLINE',
        message: `Device "${deviceId}" went offline (${reason})`,
        retryable: true,
      });
    } else {
      open.sink.push({
        schemaVersion: 1,
        streamId,
        kind: 'error',
        code: 'DEVICE_OFFLINE',
        message: `Device "${deviceId}" went offline (${reason})`,
        retryable: true,
      });
    }
  }
  session.openStreams.clear();
}

export async function executeLocalDeviceRpc<TIdentity>(
  runtime: HubRuntime<TIdentity>,
  deviceId: string,
  request: DeviceRelayRpcRequest,
  signal?: AbortSignal,
): Promise<DeviceRelayRpcResponse> {
  const session = runtime.localDevices.get(deviceId);
  if (session?.state.status !== 'online' || runtime.now() >= session.state.leaseExpiresAt) {
    if (session && runtime.now() >= session.state.leaseExpiresAt) {
      await teardownLocalDevice(runtime, deviceId, session, 'lease-expired');
    }
    throw new DeviceRelayError('DEVICE_OFFLINE', `Device "${deviceId}" is offline`, {
      delivery: 'not-sent',
      deviceId,
    });
  }
  if (session.inFlightRpcs.size >= runtime.maxInFlightPerDevice) {
    throw new DeviceRelayError(
      'DEVICE_BUSY',
      `Device "${deviceId}" reached its ${runtime.maxInFlightPerDevice} in-flight request limit`,
      { delivery: 'not-sent', deviceId },
    );
  }
  if (signal?.aborted) throw abortReason(signal);

  return new Promise<DeviceRelayRpcResponse>((resolve, reject) => {
    const onAbort = (): void => {
      if (!session.inFlightRpcs.delete(request.requestId)) return;
      cleanup();
      try {
        session.connection.events.emit('stitchkit.relay.rpc-cancel', {
          schemaVersion: 1,
          requestId: request.requestId,
          reason: 'aborted',
        });
      } catch {
        // Socket may already be closed.
      }
      reject(signal ? abortReason(signal) : abortError('Relay request aborted'));
    };
    const cleanup = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    session.inFlightRpcs.set(request.requestId, { resolve, reject, cleanup });
    const accepted = session.connection.events.emit('stitchkit.relay.rpc-request', request);
    if (!accepted) {
      session.inFlightRpcs.delete(request.requestId);
      cleanup();
      reject(
        new DeviceRelayError(
          'DEVICE_OFFLINE',
          `Device "${deviceId}" transport rejected emit`,
          {
            delivery: 'not-sent',
            deviceId,
          },
        ),
      );
    }
  });
}

function emitStreamCloseSafely<TIdentity>(
  connection: DeviceRelayServerConnection<TIdentity>,
  streamId: string,
  reason?: string,
): void {
  try {
    connection.events.emit('stitchkit.relay.stream-close', {
      schemaVersion: 1,
      streamId,
      ...(reason !== undefined && { reason }),
    });
  } catch {
    // Socket may already be closed.
  }
}

export async function openLocalDeviceStream<TIdentity>(
  runtime: HubRuntime<TIdentity>,
  deviceId: string,
  request: DeviceRelayStreamOpen,
  sink: RelayBrokerStreamSink,
  signal?: AbortSignal,
): Promise<RelayBrokerStreamHandle> {
  const session = runtime.localDevices.get(deviceId);
  if (session?.state.status !== 'online' || runtime.now() >= session.state.leaseExpiresAt) {
    if (session && runtime.now() >= session.state.leaseExpiresAt) {
      await teardownLocalDevice(runtime, deviceId, session, 'lease-expired');
    }
    throw new DeviceRelayError('DEVICE_OFFLINE', `Device "${deviceId}" is offline`, {
      delivery: 'not-sent',
      deviceId,
    });
  }
  if (session.openStreams.size >= runtime.maxStreamsPerDevice) {
    throw new DeviceRelayError(
      'STREAM_CAPACITY',
      `Device "${deviceId}" reached its ${runtime.maxStreamsPerDevice} concurrent stream limit`,
      { delivery: 'not-sent', deviceId },
    );
  }
  if (signal?.aborted) throw abortReason(signal);

  const ack = await new Promise<DeviceRelayStreamOpenAck>((resolve, reject) => {
    const cleanupAbort = (): void => {
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      const removed = session.openStreams.delete(request.streamId);
      cleanupAbort();
      if (removed) {
        emitStreamCloseSafely(session.connection, request.streamId, 'open-cancelled');
      }
      reject(signal ? abortReason(signal) : abortError('Relay stream open aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    session.openStreams.set(request.streamId, {
      sink,
      resolveOpen(frame) {
        cleanupAbort();
        resolve(frame);
      },
      opened: false,
    });
    const accepted = session.connection.events.emit('stitchkit.relay.stream-open', request);
    if (!accepted) {
      session.openStreams.delete(request.streamId);
      cleanupAbort();
      reject(
        new DeviceRelayError(
          'DEVICE_OFFLINE',
          `Device "${deviceId}" transport rejected emit`,
          { delivery: 'not-sent', deviceId },
        ),
      );
    }
  });

  if (ack.outcome === 'error') {
    session.openStreams.delete(request.streamId);
    throw new DeviceRelayError(ack.code, ack.message, {
      retryable: ack.retryable,
      deviceId,
    });
  }
  if (signal?.aborted) {
    if (session.openStreams.delete(request.streamId)) {
      emitStreamCloseSafely(session.connection, request.streamId, 'open-cancelled');
    }
    throw abortReason(signal);
  }

  const entry = session.openStreams.get(request.streamId);
  if (entry) entry.opened = true;

  let closedStream = false;
  return {
    grantCredits(credits) {
      if (closedStream || !session.openStreams.has(request.streamId)) return;
      session.connection.events.emit('stitchkit.relay.stream-credit', {
        schemaVersion: 1,
        streamId: request.streamId,
        credits,
      });
    },
    close(reason) {
      if (closedStream) return;
      closedStream = true;
      if (!session.openStreams.delete(request.streamId)) return;
      emitStreamCloseSafely(session.connection, request.streamId, reason);
    },
  };
}

export function attachDeviceConnection<TIdentity>(
  runtime: HubRuntime<TIdentity>,
  connection: DeviceRelayServerConnection<TIdentity>,
): () => void {
  const binding: ConnectionBinding<TIdentity> = {
    activeDeviceId: undefined,
    activeSession: undefined,
    lastRegisteredDeviceId: undefined,
    detached: false,
    helloSeq: 0,
  };

  const onDisconnect = (): void => {
    const deviceId = binding.activeDeviceId;
    const session = binding.activeSession;
    binding.activeDeviceId = undefined;
    binding.activeSession = undefined;
    cleanup();
    if (deviceId !== undefined) {
      observeHubBackground(runtime.logger, 'teardownLocalDevice', () =>
        teardownLocalDevice(runtime, deviceId, session, 'disconnected'),
      );
    }
  };

  const offHello = connection.events.on('stitchkit.relay.hello', (hello, ack) => {
    observeHubBackground(runtime.logger, 'handleDeviceHello', () =>
      handleDeviceHello({
        runtime,
        connection,
        binding,
        hello,
        ack,
        teardown: teardownLocalDevice,
      }),
    );
  });

  const offHeartbeat = connection.events.on('stitchkit.relay.heartbeat', (heartbeat, ack) => {
    handleDeviceHeartbeat(runtime, binding, heartbeat, ack, teardownLocalDevice);
  });

  const offRpcResponse = connection.events.on('stitchkit.relay.rpc-response', (response) => {
    const pending = binding.activeSession?.inFlightRpcs.get(response.requestId);
    if (!pending || !binding.activeSession) return;
    binding.activeSession.inFlightRpcs.delete(response.requestId);
    pending.cleanup();
    pending.resolve(response);
  });

  const offStreamAck = connection.events.on('stitchkit.relay.stream-open-ack', (ackFrame) => {
    const entry = binding.activeSession?.openStreams.get(ackFrame.streamId);
    if (!entry) {
      if (ackFrame.outcome === 'ok') {
        emitStreamCloseSafely(connection, ackFrame.streamId, 'late-open-ack');
      }
      return;
    }
    if (!entry.resolveOpen) {
      return;
    }
    const resolve = entry.resolveOpen;
    entry.resolveOpen = undefined;
    if (ackFrame.outcome === 'ok') {
      entry.opened = true;
    } else {
      binding.activeSession?.openStreams.delete(ackFrame.streamId);
    }
    resolve(ackFrame);
  });

  const offStreamEvent = connection.events.on(
    'stitchkit.relay.stream-event',
    (event: DeviceRelayStreamEvent) => {
      const entry = binding.activeSession?.openStreams.get(event.streamId);
      if (!entry || !binding.activeSession) return;
      if (event.kind === 'end' || event.kind === 'error') {
        binding.activeSession.openStreams.delete(event.streamId);
        if (!entry.opened && entry.resolveOpen) {
          const resolve = entry.resolveOpen;
          entry.resolveOpen = undefined;
          resolve(
            event.kind === 'error'
              ? {
                  schemaVersion: 1,
                  streamId: event.streamId,
                  outcome: 'error',
                  code: event.code,
                  message: event.message,
                  retryable: event.retryable,
                }
              : {
                  schemaVersion: 1,
                  streamId: event.streamId,
                  outcome: 'error',
                  code: 'STREAM_UNAVAILABLE',
                  message: 'Stream ended before open acknowledgment',
                  retryable: false,
                },
          );
          return;
        }
      }
      entry.sink.push(event);
    },
  );

  connection.raw.on('disconnect', onDisconnect);

  const cleanup = (): void => {
    if (binding.detached) return;
    binding.detached = true;
    offHello();
    offHeartbeat();
    offRpcResponse();
    offStreamAck();
    offStreamEvent();
    connection.raw.off('disconnect', onDisconnect);
    runtime.socketCleanups.delete(cleanup);
  };
  runtime.socketCleanups.add(cleanup);
  return cleanup;
}
