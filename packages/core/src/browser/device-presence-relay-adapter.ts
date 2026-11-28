import type { z } from 'zod';
import { transportResult } from '../internal/typed';
import type {
  DevicePresenceCapabilityKey,
  DevicePresenceCapabilityMap,
  DevicePresenceRelayState,
  DevicePresenceStateUpdateAck,
} from '../realtime/device-presence-contract';
import type { DevicePresenceClient } from './device-presence-client';

/** Structural state shape satisfied by `DeviceRelayAgent.getState()` without importing `stitchkit/device-relay`. */
export interface DevicePresenceRelayStateSource {
  readonly status: DevicePresenceRelayState['status'];
  readonly deviceId: string;
  readonly leaseExpiresAt?: number;
}

/** Configuration for `createDevicePresenceRelayAdapter`. */
export interface DevicePresenceRelayAdapterConfig<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
> {
  /** Mounted `DevicePresenceClient` sharing the same realtime socket as the host's relay agent. */
  readonly presence: Pick<DevicePresenceClient<TCaps>, 'publishState'>;
  /** Capability slot on `presence` whose schema accepts `DevicePresenceRelayState`. */
  readonly capability: K;
  /** Relay capabilities advertised by this host (e.g. `['rpc', 'streams']`). */
  readonly capabilities: readonly string[];
  /** Optional live getter (e.g. `() => relayAgent.getState()`) for immediate initial publication and manual `sync()`. */
  readonly getState?: () => DevicePresenceRelayStateSource;
  /** Clear the capability slot (`null`) when the relay transitions to `'closed'` or `adapter.close()` is called (default `true`). */
  readonly clearOnClose?: boolean;
}

/** Bridge publishing a desktop or mobile relay host's lifecycle state into a `DevicePresenceClient` slot. */
export interface DevicePresenceRelayAdapter {
  /** Pass directly to `createDeviceRelayAgent({ onStateChange: adapter.onStateChange })`. */
  onStateChange(state: DevicePresenceRelayStateSource): Promise<DevicePresenceStateUpdateAck>;
  /** Pull the current relay state via `getState()` and publish it to presence. */
  sync(): Promise<DevicePresenceStateUpdateAck | undefined>;
  /** Detach the adapter and optionally clear the relay capability slot on presence. */
  close(): Promise<DevicePresenceStateUpdateAck | undefined>;
}

/**
 * Connect a desktop or mobile relay agent's lifecycle state to a `DevicePresenceClient` capability
 * slot over the same Socket.IO connection without creating a runtime dependency between packages.
 */
export function createDevicePresenceRelayAdapter<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
>(
  config: DevicePresenceRelayAdapterConfig<TCaps, K> &
    (DevicePresenceRelayState extends z.input<TCaps[K]['state']> ? unknown : never),
): DevicePresenceRelayAdapter {
  const clearOnClose = config.clearOnClose ?? true;
  const advertised = [...new Set(config.capabilities)];
  let closed = false;

  const publish = (
    state: DevicePresenceRelayStateSource,
  ): Promise<DevicePresenceStateUpdateAck> => {
    if (clearOnClose && state.status === 'closed') {
      return config.presence.publishState(config.capability, null);
    }
    const slot: DevicePresenceRelayState = {
      status: state.status,
      deviceId: state.deviceId,
      capabilities: advertised,
      ...(state.leaseExpiresAt !== undefined && { leaseExpiresAt: state.leaseExpiresAt }),
    };
    return config.presence.publishState(config.capability, transportResult(slot));
  };

  if (config.getState) {
    void publish(config.getState()).catch(() => undefined);
  }

  return {
    async onStateChange(state) {
      if (closed) {
        return {
          schemaVersion: 1,
          outcome: 'error',
          code: 'DISCONNECTED',
          message: 'Device presence relay adapter is closed',
        };
      }
      return publish(state);
    },
    async sync() {
      if (closed || !config.getState) return undefined;
      return publish(config.getState());
    },
    async close() {
      if (closed) return undefined;
      closed = true;
      if (!clearOnClose) return undefined;
      return config.presence.publishState(config.capability, null);
    },
  };
}
