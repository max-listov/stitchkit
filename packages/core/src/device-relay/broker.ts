import { assertTimerMs } from '../internal/deadline';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import {
  DeviceRelayError,
  type DeviceRelayOfflineReason,
  type DeviceRelayRpcRequest,
  type DeviceRelayRpcResponse,
  type DeviceRelayState,
  type DeviceRelayStreamEvent,
  type DeviceRelayStreamOpen,
} from './contract';

const DEFAULT_MAX_OFFLINE_DEVICES = 1_024;
const DEFAULT_OFFLINE_DEVICE_TTL_MS = 5 * 60_000;

/** Downstream consumer sink receiving routed stream events from a brokered backend instance. */
export interface RelayBrokerStreamSink {
  push(event: DeviceRelayStreamEvent): void;
}

/** Control handle returned by `RelayBrokerPort.forwardStreamOpen` for flow control and cleanup. */
export interface RelayBrokerStreamHandle {
  grantCredits(credits: number): void;
  close(reason?: string): void;
}

/** Local hub endpoints registered with a `RelayBrokerPort` so remote replicas can route traffic to it. */
export interface RelayBrokerInstanceHandler {
  executeLocalRpc(
    deviceId: string,
    request: DeviceRelayRpcRequest,
    signal?: AbortSignal,
  ): Promise<DeviceRelayRpcResponse>;
  openLocalStream(
    deviceId: string,
    request: DeviceRelayStreamOpen,
    sink: RelayBrokerStreamSink,
    signal?: AbortSignal,
  ): Promise<RelayBrokerStreamHandle>;
}

/**
 * Routing abstraction decoupling `DeviceRelayHub` from single-process memory so horizontal
 * multi-replica backends can plug in Redis/Postgres/pub-sub without changing the relay protocol.
 */
export interface RelayBrokerPort {
  registerDevice(record: DeviceRelayState): void | Promise<void>;
  refreshDeviceLease(input: {
    deviceId: string;
    instanceId: string;
    lastHeartbeatAt: number;
    leaseExpiresAt: number;
  }): void | Promise<void>;
  markDeviceOffline(input: {
    deviceId: string;
    instanceId: string;
    reason: DeviceRelayOfflineReason;
  }): void | Promise<void>;
  lookupDevice(
    deviceId: string,
  ): DeviceRelayState | undefined | Promise<DeviceRelayState | undefined>;
  listDevicesByAccount(
    accountId: string,
  ): readonly DeviceRelayState[] | Promise<readonly DeviceRelayState[]>;
  bindInstance(instanceId: string, handler: RelayBrokerInstanceHandler): () => void;
  forwardRpc(
    instanceId: string,
    deviceId: string,
    request: DeviceRelayRpcRequest,
    signal?: AbortSignal,
  ): Promise<DeviceRelayRpcResponse>;
  forwardStreamOpen(
    instanceId: string,
    deviceId: string,
    request: DeviceRelayStreamOpen,
    sink: RelayBrokerStreamSink,
    signal?: AbortSignal,
  ): Promise<RelayBrokerStreamHandle>;
}

/**
 * Default in-process `RelayBrokerPort`. Supports both one standalone hub and multiple hubs
 * sharing the same broker instance in tests or single-process clusters. Bounds retained
 * offline device tombstones by count and TTL so disconnected devices never grow unboundedly.
 */
export function createMemoryRelayBroker(options?: {
  readonly maxOfflineDevices?: number;
  readonly offlineTtlMs?: number;
  readonly now?: () => number;
}): RelayBrokerPort {
  const maxOfflineDevices = options?.maxOfflineDevices ?? DEFAULT_MAX_OFFLINE_DEVICES;
  const offlineTtlMs = options?.offlineTtlMs ?? DEFAULT_OFFLINE_DEVICE_TTL_MS;
  const now = options?.now ?? (() => Date.now());
  assertPositiveSafeInteger('MemoryRelayBroker.maxOfflineDevices', maxOfflineDevices);
  assertTimerMs('MemoryRelayBroker.offlineTtlMs', offlineTtlMs);

  const devices = new Map<string, DeviceRelayState>();
  const offlineAt = new Map<string, number>();
  const instances = new Map<string, RelayBrokerInstanceHandler>();

  const evictOffline = (): void => {
    const cutoff = now() - offlineTtlMs;
    for (const [deviceId, markedAt] of offlineAt) {
      if (markedAt > cutoff) break;
      offlineAt.delete(deviceId);
      if (devices.get(deviceId)?.status === 'offline') {
        devices.delete(deviceId);
      }
    }
    while (offlineAt.size > maxOfflineDevices) {
      const oldest = offlineAt.keys().next().value;
      if (oldest === undefined) break;
      offlineAt.delete(oldest);
      if (devices.get(oldest)?.status === 'offline') {
        devices.delete(oldest);
      }
    }
  };

  return {
    registerDevice(record) {
      offlineAt.delete(record.deviceId);
      devices.set(record.deviceId, { ...record, capabilities: [...record.capabilities] });
      evictOffline();
    },
    refreshDeviceLease({ deviceId, instanceId, lastHeartbeatAt, leaseExpiresAt }) {
      const existing = devices.get(deviceId);
      if (!existing || existing.instanceId !== instanceId || existing.status !== 'online')
        return;
      devices.set(deviceId, { ...existing, lastHeartbeatAt, leaseExpiresAt });
    },
    markDeviceOffline({ deviceId, instanceId, reason }) {
      const existing = devices.get(deviceId);
      if (!existing || existing.instanceId !== instanceId) return;
      devices.set(deviceId, { ...existing, status: 'offline', offlineReason: reason });
      offlineAt.delete(deviceId);
      offlineAt.set(deviceId, now());
      evictOffline();
    },
    lookupDevice(deviceId) {
      evictOffline();
      return devices.get(deviceId);
    },
    listDevicesByAccount(accountId) {
      evictOffline();
      const list: DeviceRelayState[] = [];
      for (const record of devices.values()) {
        if (record.accountId === accountId) list.push(record);
      }
      return list;
    },
    bindInstance(instanceId, handler) {
      instances.set(instanceId, handler);
      return () => {
        if (instances.get(instanceId) === handler) instances.delete(instanceId);
      };
    },
    async forwardRpc(instanceId, deviceId, request, signal) {
      const handler = instances.get(instanceId);
      if (!handler) {
        throw new DeviceRelayError(
          'BROKER_UNAVAILABLE',
          `Relay backend instance "${instanceId}" is not reachable`,
          { deviceId },
        );
      }
      return handler.executeLocalRpc(deviceId, request, signal);
    },
    async forwardStreamOpen(instanceId, deviceId, request, sink, signal) {
      const handler = instances.get(instanceId);
      if (!handler) {
        throw new DeviceRelayError(
          'BROKER_UNAVAILABLE',
          `Relay backend instance "${instanceId}" is not reachable`,
          { deviceId },
        );
      }
      return handler.openLocalStream(deviceId, request, sink, signal);
    },
  };
}
