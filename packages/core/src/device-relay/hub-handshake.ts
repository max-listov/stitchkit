import type {
  DeviceRelayHeartbeat,
  DeviceRelayHeartbeatAck,
  DeviceRelayHello,
  DeviceRelayHelloAck,
  DeviceRelayState,
} from './contract';
import type { DeviceRelayServerConnection } from './hub';
import {
  type HubRuntime,
  type LocalDeviceSession,
  observeHubBackground,
} from './hub-connection';

export interface ConnectionBinding<TIdentity> {
  activeDeviceId: string | undefined;
  activeSession: LocalDeviceSession<TIdentity> | undefined;
  lastRegisteredDeviceId: string | undefined;
  detached: boolean;
  helloSeq: number;
}

function closedHelloAck(): DeviceRelayHelloAck {
  return {
    schemaVersion: 1,
    outcome: 'error',
    code: 'CLOSED',
    message: 'Device relay hub is closed',
    retryable: false,
  };
}

export async function handleDeviceHello<TIdentity>(input: {
  readonly runtime: HubRuntime<TIdentity>;
  readonly connection: DeviceRelayServerConnection<TIdentity>;
  readonly binding: ConnectionBinding<TIdentity>;
  readonly hello: DeviceRelayHello;
  readonly ack: (reply: DeviceRelayHelloAck) => void;
  readonly teardown: (
    runtime: HubRuntime<TIdentity>,
    deviceId: string,
    expected: LocalDeviceSession<TIdentity> | undefined,
    reason: 'replaced' | 'closed' | 'disconnected',
  ) => Promise<void>;
}): Promise<void> {
  const { runtime, connection, binding, hello, ack, teardown } = input;
  const seq = ++binding.helloSeq;
  const isStale = (): boolean =>
    runtime.isClosed() || binding.detached || seq !== binding.helloSeq;
  try {
    if (isStale()) {
      ack(closedHelloAck());
      return;
    }
    const verified = await runtime.config.authenticateDevice({
      identity: connection.raw.data,
      hello,
      socketId: connection.raw.id,
    });
    if (isStale()) {
      ack(closedHelloAck());
      return;
    }
    if (!verified) {
      ack({
        schemaVersion: 1,
        outcome: 'error',
        code: 'UNAUTHORIZED',
        message: 'Device authentication refused',
        retryable: false,
      });
      return;
    }
    if (verified.deviceId !== hello.deviceId) {
      ack({
        schemaVersion: 1,
        outcome: 'error',
        code: 'IDENTITY_MISMATCH',
        message: 'Authenticated device identity does not match hello deviceId',
        retryable: false,
      });
      return;
    }
    if (binding.activeDeviceId !== undefined && binding.activeDeviceId !== verified.deviceId) {
      const priorDeviceId = binding.activeDeviceId;
      const priorSession = binding.activeSession;
      binding.activeDeviceId = undefined;
      binding.activeSession = undefined;
      await teardown(runtime, priorDeviceId, priorSession, 'replaced');
      if (isStale()) {
        ack(closedHelloAck());
        return;
      }
    }
    const previous = runtime.localDevices.get(verified.deviceId);
    if (previous && previous.connection !== connection) {
      await teardown(runtime, verified.deviceId, previous, 'replaced');
      if (isStale()) {
        ack(closedHelloAck());
        return;
      }
    }
    const sameSocketPrevious =
      previous && previous.connection === connection ? previous : undefined;
    const effectiveLeaseMs = Math.min(
      runtime.leaseTtlMs,
      hello.leaseTtlMs ?? runtime.leaseTtlMs,
    );
    const timestamp = runtime.now();
    const state: DeviceRelayState = {
      accountId: verified.accountId,
      deviceId: verified.deviceId,
      status: 'online',
      capabilities: [...(verified.capabilities ?? hello.capabilities)],
      instanceId: runtime.instanceId,
      connectedAt: timestamp,
      lastHeartbeatAt: timestamp,
      leaseExpiresAt: timestamp + effectiveLeaseMs,
    };
    const session: LocalDeviceSession<TIdentity> = {
      state,
      effectiveLeaseMs,
      connection,
      binding,
      inFlightRpcs: sameSocketPrevious ? sameSocketPrevious.inFlightRpcs : new Map(),
      openStreams: sameSocketPrevious ? sameSocketPrevious.openStreams : new Map(),
    };
    binding.activeDeviceId = verified.deviceId;
    binding.activeSession = session;
    runtime.localDevices.set(verified.deviceId, session);
    try {
      await runtime.broker.registerDevice(state);
    } catch (error) {
      if (runtime.localDevices.get(verified.deviceId) === session) {
        runtime.localDevices.delete(verified.deviceId);
      }
      if (binding.activeSession === session) {
        binding.activeSession = undefined;
        binding.activeDeviceId = undefined;
      }
      runtime.logger?.warn('DeviceRelayHub broker registerDevice failed', {
        deviceId: verified.deviceId,
        error,
      });
      ack({
        schemaVersion: 1,
        outcome: 'error',
        code: 'BROKER_UNAVAILABLE',
        message: 'Device relay broker failed to register device',
        retryable: true,
      });
      return;
    }
    if (isStale() || runtime.localDevices.get(verified.deviceId) !== session) {
      const reason = runtime.isClosed() ? 'closed' : 'disconnected';
      if (runtime.localDevices.get(verified.deviceId) === session) {
        await teardown(runtime, verified.deviceId, session, reason);
      } else if (!runtime.localDevices.has(verified.deviceId)) {
        try {
          await runtime.broker.markDeviceOffline({
            deviceId: verified.deviceId,
            instanceId: runtime.instanceId,
            reason,
          });
        } catch (error) {
          runtime.logger?.warn('DeviceRelayHub broker markDeviceOffline failed', {
            deviceId: verified.deviceId,
            reason,
            error,
          });
        }
      }
      ack(closedHelloAck());
      return;
    }
    binding.lastRegisteredDeviceId = verified.deviceId;
    runtime.notifyState(state);
    ack({
      schemaVersion: 1,
      outcome: 'ok',
      leaseTtlMs: effectiveLeaseMs,
      leaseExpiresAtMs: state.leaseExpiresAt,
      serverTimeMs: timestamp,
      instanceId: runtime.instanceId,
    });
  } catch (error) {
    runtime.logger?.error('DeviceRelayHub authenticateDevice failed', { error });
    ack({
      schemaVersion: 1,
      outcome: 'error',
      code: 'UNAUTHORIZED',
      message: 'Device authentication failed',
      retryable: false,
    });
  }
}

export function handleDeviceHeartbeat<TIdentity>(
  runtime: HubRuntime<TIdentity>,
  binding: ConnectionBinding<TIdentity>,
  heartbeat: DeviceRelayHeartbeat,
  ack: (reply: DeviceRelayHeartbeatAck) => void,
  teardown: (
    runtime: HubRuntime<TIdentity>,
    deviceId: string,
    expected: LocalDeviceSession<TIdentity> | undefined,
    reason: 'lease-expired',
  ) => Promise<void>,
): void {
  if (runtime.isClosed() || binding.detached) {
    ack({
      schemaVersion: 1,
      outcome: 'error',
      code: 'CLOSED',
      message: 'Device relay hub is closed',
      retryable: false,
    });
    return;
  }
  const session = binding.activeSession;
  if (!session) {
    if (binding.lastRegisteredDeviceId === heartbeat.deviceId) {
      ack({
        schemaVersion: 1,
        outcome: 'error',
        code: 'DEVICE_OFFLINE',
        message: 'Device session is no longer active; re-register with hello',
        retryable: true,
      });
      return;
    }
    ack({
      schemaVersion: 1,
      outcome: 'error',
      code: 'IDENTITY_MISMATCH',
      message: 'Device is not registered on this connection',
      retryable: false,
    });
    return;
  }
  if (binding.activeDeviceId !== heartbeat.deviceId) {
    ack({
      schemaVersion: 1,
      outcome: 'error',
      code: 'IDENTITY_MISMATCH',
      message: 'Device is not registered on this connection',
      retryable: false,
    });
    return;
  }
  if (
    session.state.status !== 'online' ||
    runtime.localDevices.get(heartbeat.deviceId) !== session
  ) {
    if (binding.activeSession === session) {
      binding.activeSession = undefined;
      binding.activeDeviceId = undefined;
    }
    ack({
      schemaVersion: 1,
      outcome: 'error',
      code: 'DEVICE_OFFLINE',
      message: 'Device session is no longer active; re-register with hello',
      retryable: true,
    });
    return;
  }
  const timestamp = runtime.now();
  if (timestamp >= session.state.leaseExpiresAt) {
    if (binding.activeSession === session) {
      binding.activeSession = undefined;
      binding.activeDeviceId = undefined;
    }
    observeHubBackground(runtime.logger, 'teardownLocalDevice', () =>
      teardown(runtime, heartbeat.deviceId, session, 'lease-expired'),
    );
    ack({
      schemaVersion: 1,
      outcome: 'error',
      code: 'DEVICE_OFFLINE',
      message: 'Device lease expired; re-register with hello',
      retryable: true,
    });
    return;
  }
  const leaseExpiresAt = timestamp + session.effectiveLeaseMs;
  session.state = {
    ...session.state,
    lastHeartbeatAt: timestamp,
    leaseExpiresAt,
  };
  observeHubBackground(runtime.logger, 'refreshDeviceLease', () =>
    runtime.broker.refreshDeviceLease({
      deviceId: heartbeat.deviceId,
      instanceId: runtime.instanceId,
      lastHeartbeatAt: timestamp,
      leaseExpiresAt,
    }),
  );
  ack({
    schemaVersion: 1,
    outcome: 'ok',
    leaseExpiresAtMs: leaseExpiresAt,
    serverTimeMs: timestamp,
  });
}
