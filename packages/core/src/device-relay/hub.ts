import type { ClientFetch } from '../browser/transport';
import { assertTimerMs } from '../internal/deadline';
import type { StitchLogger } from '../internal/logger';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import type { ValidatedRealtimeSocket } from '../realtime/socket';
import { createMemoryRelayBroker, type RelayBrokerPort } from './broker';
import {
  DEFAULT_DEVICE_RELAY_LEASE_TTL_MS,
  DEFAULT_DEVICE_RELAY_MAX_BUFFERED_FRAMES,
  DEFAULT_DEVICE_RELAY_MAX_CONCURRENT_STREAMS,
  DEFAULT_DEVICE_RELAY_MAX_IN_FLIGHT_RPCS,
  DEFAULT_DEVICE_RELAY_MAX_REQUEST_BYTES,
  DEFAULT_DEVICE_RELAY_MAX_RESPONSE_BYTES,
  DEFAULT_DEVICE_RELAY_MAX_STREAM_FRAME_BYTES,
  DEFAULT_DEVICE_RELAY_RPC_TIMEOUT_MS,
  DeviceRelayError,
  type DeviceRelayHello,
  type DeviceRelayJsonValue,
  type DeviceRelayState,
  type deviceRelayRealtimeContract,
} from './contract';
import {
  attachDeviceConnection,
  executeLocalDeviceRpc,
  type HubRuntime,
  type LocalDeviceSession,
  observeHubBackground,
  openLocalDeviceStream,
  teardownLocalDevice,
} from './hub-connection';
import {
  buildRelayFetch,
  type HubDispatchContext,
  openRelayStreamOnHub,
} from './hub-dispatch';
import type { DeviceRelayStream, SharedUpstreamSubscription } from './hub-streams';

/** Minimal peer-free socket lifecycle interface satisfied by Socket.IO `Socket` and custom transports. */
export interface DeviceRelayRawSocket<TIdentity = unknown> {
  readonly id: string;
  readonly data: TIdentity;
  on(event: 'disconnect', listener: (reason?: string) => void): unknown;
  off(event: 'disconnect', listener: (reason?: string) => void): unknown;
  disconnect(close?: boolean): unknown;
}

/** Minimal peer-free server connection accepted by `DeviceRelayHub.attachConnection`. */
export interface DeviceRelayServerConnection<TIdentity = unknown> {
  readonly raw: DeviceRelayRawSocket<TIdentity>;
  readonly events: ValidatedRealtimeSocket<
    typeof deviceRelayRealtimeContract.clientToServer,
    typeof deviceRelayRealtimeContract.serverToClient
  >;
}

/** Minimal peer-free realtime server interface satisfied directly by `bindRealtimeServer(deviceRelayRealtimeContract, io)`. */
export interface DeviceRelayRealtimeServer<TIdentity = unknown> {
  onConnection(
    handler: (connection: DeviceRelayServerConnection<TIdentity>) => void | Promise<void>,
  ): () => void;
}

/** Input passed to `DeviceRelayHubConfig.authenticateDevice` when a desktop connects and sends `hello`. */
export interface DeviceRelayDeviceAuthInput<TIdentity = unknown> {
  readonly identity: TIdentity;
  readonly hello: DeviceRelayHello;
  readonly socketId: string;
}

/** Verified device identity returned by `authenticateDevice`. */
export interface DeviceRelayAuthenticatedDevice {
  readonly accountId: string;
  readonly deviceId: string;
  readonly capabilities?: readonly string[];
}

/** Input passed to `DeviceRelayHubConfig.authorizeAccess` before forwarding an RPC or stream. */
export interface DeviceRelayAccessRequest {
  readonly callerAccountId: string;
  readonly deviceAccountId: string;
  readonly deviceId: string;
  readonly kind: 'rpc' | 'stream';
  readonly method?: string;
  readonly path?: string;
  readonly topic?: string;
}

/** Configuration for `createDeviceRelayHub`. */
export interface DeviceRelayHubConfig<TIdentity = unknown> {
  /** Verify the connecting socket's handshake identity and bind it to `(accountId, deviceId)`. */
  authenticateDevice(
    input: DeviceRelayDeviceAuthInput<TIdentity>,
  ): DeviceRelayAuthenticatedDevice | null | Promise<DeviceRelayAuthenticatedDevice | null>;
  /** Optional custom access policy; defaults to strict owner-only (`callerAccountId === deviceAccountId`). */
  authorizeAccess?(input: DeviceRelayAccessRequest): boolean | Promise<boolean>;
  /** Routing broker for multi-replica deployments; defaults to an in-memory broker. */
  broker?: RelayBrokerPort;
  /** Unique backend replica identifier advertised in device records. */
  instanceId?: string;
  /** Conservative heartbeat lease TTL in ms (default 30 000). */
  leaseTtlMs?: number;
  /** Periodic lease expiry check interval in ms. */
  leaseSweepIntervalMs?: number;
  /** Default unary RPC timeout in ms (default 30 000). */
  defaultRpcTimeoutMs?: number;
  /** Default unary request body limit in bytes (default 64 KiB). */
  maxRequestBodyBytes?: number;
  /** Default unary response body limit in bytes (default 1 MiB). */
  maxResponseBodyBytes?: number;
  /** Maximum concurrent in-flight unary RPCs per device (default 64). */
  maxInFlightRequestsPerDevice?: number;
  /** Maximum concurrent open streams per device (default 32). */
  maxConcurrentStreamsPerDevice?: number;
  /** Maximum UTF-8 byte length for one stream event payload (default 64 KiB). */
  maxStreamFrameBytes?: number;
  /** Default per-stream frame buffer and credit window (default 128). */
  maxBufferedStreamFrames?: number;
  /** Optional clock for deterministic lease tests (defaults to `Date.now`). */
  now?: () => number;
  /** Observer called whenever a local device transitions online or offline. */
  onDeviceStateChange?: (state: DeviceRelayState) => void;
  /** Optional logger for internal diagnostics. */
  logger?: StitchLogger;
}

/** Options for `DeviceRelayHub.createRelayFetch`. */
export interface DeviceRelayFetchOptions {
  readonly accountId: string;
  readonly deviceId: string;
  readonly timeoutMs?: number;
  readonly maxRequestBodyBytes?: number;
  readonly maxResponseBodyBytes?: number;
}

/** Options for `DeviceRelayHub.openRelayStream`. */
export interface DeviceRelayStreamOpenOptions {
  readonly accountId: string;
  readonly deviceId: string;
  readonly topic: string;
  readonly cursor?: string;
  readonly params?: Record<string, DeviceRelayJsonValue>;
  /** Share one upstream subscription across subscribers for the same `(accountId, deviceId, topic, params)` when no per-subscriber cursor is set. */
  readonly share?: boolean;
  readonly signal?: AbortSignal;
  readonly openTimeoutMs?: number;
  readonly maxBufferedFrames?: number;
  readonly maxFrameBytes?: number;
}

/** Backend relay hub managing authenticated desktop connections, leases, unary fetch and streams. */
export interface DeviceRelayHub<TIdentity = unknown> {
  readonly instanceId: string;
  bindRealtime(server: DeviceRelayRealtimeServer<TIdentity>): () => void;
  attachConnection(connection: DeviceRelayServerConnection<TIdentity>): () => void;
  getDevice(accountId: string, deviceId: string): Promise<DeviceRelayState | undefined>;
  listDevices(accountId: string): Promise<readonly DeviceRelayState[]>;
  createRelayFetch(options: DeviceRelayFetchOptions): ClientFetch;
  openRelayStream(options: DeviceRelayStreamOpenOptions): Promise<DeviceRelayStream>;
  sweepExpiredLeases(): Promise<void>;
  close(): Promise<void>;
}

function defaultAuthorizeAccess(input: DeviceRelayAccessRequest): boolean {
  return input.callerAccountId === input.deviceAccountId;
}

function validateHubLimits<TIdentity>(config: DeviceRelayHubConfig<TIdentity>) {
  const leaseTtlMs = config.leaseTtlMs ?? DEFAULT_DEVICE_RELAY_LEASE_TTL_MS;
  const leaseSweepIntervalMs =
    config.leaseSweepIntervalMs ?? Math.min(5_000, Math.max(25, Math.floor(leaseTtlMs / 3)));
  const defaultRpcTimeoutMs =
    config.defaultRpcTimeoutMs ?? DEFAULT_DEVICE_RELAY_RPC_TIMEOUT_MS;
  const defaultMaxRequestBytes =
    config.maxRequestBodyBytes ?? DEFAULT_DEVICE_RELAY_MAX_REQUEST_BYTES;
  const defaultMaxResponseBytes =
    config.maxResponseBodyBytes ?? DEFAULT_DEVICE_RELAY_MAX_RESPONSE_BYTES;
  const maxInFlightPerDevice =
    config.maxInFlightRequestsPerDevice ?? DEFAULT_DEVICE_RELAY_MAX_IN_FLIGHT_RPCS;
  const maxStreamsPerDevice =
    config.maxConcurrentStreamsPerDevice ?? DEFAULT_DEVICE_RELAY_MAX_CONCURRENT_STREAMS;
  const defaultMaxStreamFrameBytes =
    config.maxStreamFrameBytes ?? DEFAULT_DEVICE_RELAY_MAX_STREAM_FRAME_BYTES;
  const defaultMaxBufferedFrames =
    config.maxBufferedStreamFrames ?? DEFAULT_DEVICE_RELAY_MAX_BUFFERED_FRAMES;

  assertTimerMs('DeviceRelayHubConfig.leaseTtlMs', leaseTtlMs);
  assertTimerMs('DeviceRelayHubConfig.leaseSweepIntervalMs', leaseSweepIntervalMs);
  assertTimerMs('DeviceRelayHubConfig.defaultRpcTimeoutMs', defaultRpcTimeoutMs);
  assertPositiveSafeInteger(
    'DeviceRelayHubConfig.maxRequestBodyBytes',
    defaultMaxRequestBytes,
  );
  assertPositiveSafeInteger(
    'DeviceRelayHubConfig.maxResponseBodyBytes',
    defaultMaxResponseBytes,
  );
  assertPositiveSafeInteger(
    'DeviceRelayHubConfig.maxInFlightRequestsPerDevice',
    maxInFlightPerDevice,
  );
  assertPositiveSafeInteger(
    'DeviceRelayHubConfig.maxConcurrentStreamsPerDevice',
    maxStreamsPerDevice,
  );
  assertPositiveSafeInteger(
    'DeviceRelayHubConfig.maxStreamFrameBytes',
    defaultMaxStreamFrameBytes,
  );
  assertPositiveSafeInteger(
    'DeviceRelayHubConfig.maxBufferedStreamFrames',
    defaultMaxBufferedFrames,
  );
  return {
    leaseTtlMs,
    leaseSweepIntervalMs,
    defaultRpcTimeoutMs,
    defaultMaxRequestBytes,
    defaultMaxResponseBytes,
    maxInFlightPerDevice,
    maxStreamsPerDevice,
    defaultMaxStreamFrameBytes,
    defaultMaxBufferedFrames,
  };
}

/** Create a backend User Device Relay hub over existing Stitchkit realtime connections. */
export function createDeviceRelayHub<TIdentity = unknown>(
  config: DeviceRelayHubConfig<TIdentity>,
): DeviceRelayHub<TIdentity> {
  const limits = validateHubLimits(config);
  const instanceId = config.instanceId ?? `relay-${crypto.randomUUID()}`;
  const broker = config.broker ?? createMemoryRelayBroker();
  const now = config.now ?? (() => Date.now());
  const authorize = config.authorizeAccess ?? defaultAuthorizeAccess;
  const localDevices = new Map<string, LocalDeviceSession<TIdentity>>();
  const sharedStreams = new Map<string, SharedUpstreamSubscription>();
  const socketCleanups = new Set<() => void>();
  let closed = false;

  const runtime: HubRuntime<TIdentity> = {
    instanceId,
    broker,
    config,
    leaseTtlMs: limits.leaseTtlMs,
    maxInFlightPerDevice: limits.maxInFlightPerDevice,
    maxStreamsPerDevice: limits.maxStreamsPerDevice,
    now,
    localDevices,
    socketCleanups,
    logger: config.logger,
    isClosed: () => closed,
    notifyState(state) {
      try {
        config.onDeviceStateChange?.(state);
      } catch (error) {
        config.logger?.warn('DeviceRelayHub onDeviceStateChange threw', { error });
      }
    },
  };

  const unbindBroker = broker.bindInstance(instanceId, {
    executeLocalRpc: (deviceId, request, signal) =>
      executeLocalDeviceRpc(runtime, deviceId, request, signal),
    openLocalStream: (deviceId, request, sink, signal) =>
      openLocalDeviceStream(runtime, deviceId, request, sink, signal),
  });

  const sweepExpiredLeases = async (): Promise<void> => {
    const currentNow = now();
    const expired: Array<[string, LocalDeviceSession<TIdentity>]> = [];
    for (const [deviceId, session] of localDevices) {
      if (currentNow >= session.state.leaseExpiresAt) expired.push([deviceId, session]);
    }
    for (const [deviceId, session] of expired) {
      await teardownLocalDevice(runtime, deviceId, session, 'lease-expired');
    }
  };

  const sweepTimer = setInterval(() => {
    observeHubBackground(runtime.logger, 'sweepExpiredLeases', sweepExpiredLeases);
  }, limits.leaseSweepIntervalMs);
  sweepTimer.unref?.();

  const resolveAuthorizedDevice = async (
    access: Omit<DeviceRelayAccessRequest, 'deviceAccountId'>,
  ): Promise<DeviceRelayState> => {
    await sweepExpiredLeases();
    const record = await broker.lookupDevice(access.deviceId);
    if (!record) {
      const allowedMissing = await authorize({
        ...access,
        deviceAccountId: access.callerAccountId,
      });
      if (!allowedMissing) {
        throw new DeviceRelayError(
          'FORBIDDEN',
          'Caller is not authorized to access this device',
          {
            deviceId: access.deviceId,
          },
        );
      }
      throw new DeviceRelayError('DEVICE_OFFLINE', `Device "${access.deviceId}" is offline`, {
        delivery: 'not-sent',
        deviceId: access.deviceId,
      });
    }
    const allowed = await authorize({ ...access, deviceAccountId: record.accountId });
    if (!allowed) {
      throw new DeviceRelayError(
        'FORBIDDEN',
        'Caller is not authorized to access this device',
        {
          deviceId: access.deviceId,
        },
      );
    }
    if (record.status !== 'online' || now() >= record.leaseExpiresAt) {
      throw new DeviceRelayError('DEVICE_OFFLINE', `Device "${access.deviceId}" is offline`, {
        delivery: 'not-sent',
        deviceId: access.deviceId,
      });
    }
    return record;
  };

  const dispatch: HubDispatchContext = {
    broker,
    sharedStreams,
    defaultRpcTimeoutMs: limits.defaultRpcTimeoutMs,
    defaultMaxRequestBytes: limits.defaultMaxRequestBytes,
    defaultMaxResponseBytes: limits.defaultMaxResponseBytes,
    defaultMaxStreamFrameBytes: limits.defaultMaxStreamFrameBytes,
    defaultMaxBufferedFrames: limits.defaultMaxBufferedFrames,
    isClosed: () => closed,
    resolveAuthorizedDevice,
  };

  return {
    instanceId,
    bindRealtime(server) {
      return server.onConnection((connection) => {
        attachDeviceConnection(runtime, connection);
      });
    },
    attachConnection: (connection) => attachDeviceConnection(runtime, connection),
    async getDevice(accountId, deviceId) {
      await sweepExpiredLeases();
      const record = await broker.lookupDevice(deviceId);
      if (!record || record.accountId !== accountId) return undefined;
      return record;
    },
    async listDevices(accountId) {
      await sweepExpiredLeases();
      return broker.listDevicesByAccount(accountId);
    },
    createRelayFetch: (options) => buildRelayFetch(dispatch, options),
    openRelayStream: (options) => openRelayStreamOnHub(dispatch, options),
    sweepExpiredLeases,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweepTimer);
      unbindBroker();
      for (const cleanup of [...socketCleanups]) cleanup();
      for (const [deviceId, session] of [...localDevices]) {
        await teardownLocalDevice(runtime, deviceId, session, 'closed');
      }
      for (const shared of sharedStreams.values()) {
        shared.closed = true;
        shared.openController.abort(
          new DeviceRelayError('CLOSED', 'Device relay hub is closed'),
        );
        shared.handle?.close('hub-closed');
      }
      sharedStreams.clear();
    },
  };
}
