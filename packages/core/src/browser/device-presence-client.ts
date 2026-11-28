import type { z } from 'zod';
import { assertTimerMs } from '../internal/deadline';
import { transportResult } from '../internal/typed';
import {
  DEFAULT_DEVICE_PRESENCE_COMMAND_TIMEOUT_MS,
  DEFAULT_DEVICE_PRESENCE_REQUEST_TIMEOUT_MS,
  type DevicePresenceCapabilityKey,
  type DevicePresenceCapabilityMap,
  type DevicePresenceCapabilityResult,
  type DevicePresenceCommandResult,
  type DevicePresenceContract,
  type DevicePresenceDevice,
  type DevicePresenceIdentity,
  DevicePresenceIdentitySchema,
  type DevicePresenceSnapshot,
  type DevicePresenceStatesInput,
  type DevicePresenceStateUpdateAck,
} from '../realtime/device-presence-contract';
import {
  applyClientSnapshot,
  type DevicePresenceCommandContext,
  type DevicePresenceCommandHandler,
  type DevicePresenceSendCommandInput,
  type DevicePresenceSubscriber,
  dispatchAnnounce,
  handleDeliveredCommand,
  type PresenceClientState,
  publishClientState,
  sendClientCommand,
} from './device-presence-ops';
import { bindRealtimeClient, type RealtimeClientTransport } from './realtime-client';

export type {
  DevicePresenceCommandContext,
  DevicePresenceCommandHandler,
  DevicePresenceSendCommandInput,
  DevicePresenceSubscriber,
};

/** Configuration for `createDevicePresenceClient`. */
export interface DevicePresenceClientConfig<TCaps extends DevicePresenceCapabilityMap> {
  /** Shared realtime transport (`createSocketIOClient`, `createRealtimeClient` or compatible). */
  readonly transport: RealtimeClientTransport;
  /** Identity metadata of this device (`deviceId`, `name`, `platform`). */
  readonly device: DevicePresenceIdentity;
  /** Explicit capabilities announced for this device (combined with any registered `onCommand` capabilities). */
  readonly capabilities?: readonly DevicePresenceCapabilityKey<TCaps>[];
  /** Initial local capability states announced on connect and automatically republished on every reconnect. */
  readonly initialStates?: DevicePresenceStatesInput<TCaps>;
  /** Timeout in ms for `announce` and `publishState` acknowledgements (default 10 000). */
  readonly requestTimeoutMs?: number;
  /** Default timeout in ms for `sendCommand` calls when not overridden per command (default 10 000). */
  readonly commandTimeoutMs?: number;
  /** Optional observer invoked whenever a new account snapshot arrives. */
  readonly onSnapshot?: (snapshot: DevicePresenceSnapshot<TCaps>) => void;
  /** Optional observer invoked on announce, transport or local command handler failures. */
  readonly onError?: (error: Error) => void;
}

/** Typed browser / mobile / desktop client for account device presence and targeted remote commands. */
export interface DevicePresenceClient<TCaps extends DevicePresenceCapabilityMap> {
  readonly device: DevicePresenceIdentity;
  getSnapshot(): DevicePresenceSnapshot<TCaps> | undefined;
  getDevices(): readonly DevicePresenceDevice<TCaps>[];
  subscribe(listener: DevicePresenceSubscriber<TCaps>): () => void;
  publishState<K extends DevicePresenceCapabilityKey<TCaps>>(
    capability: K,
    state: z.input<TCaps[K]['state']> | null,
  ): Promise<DevicePresenceStateUpdateAck>;
  sendCommand<K extends DevicePresenceCapabilityKey<TCaps>>(
    input: DevicePresenceSendCommandInput<TCaps, K>,
  ): Promise<DevicePresenceCommandResult<DevicePresenceCapabilityResult<TCaps, K>>>;
  onCommand<K extends DevicePresenceCapabilityKey<TCaps>>(
    capability: K,
    handler: DevicePresenceCommandHandler<TCaps, K>,
  ): () => void;
  /** Detach presence listeners without closing the shared realtime transport. */
  close(): void;
}

/**
 * Create a typed device presence & remote command client over a shared `RealtimeClientTransport`.
 * Automatically re-announces the device and republishes its local capability states after every reconnect.
 */
export function createDevicePresenceClient<const TCaps extends DevicePresenceCapabilityMap>(
  contract: DevicePresenceContract<TCaps>,
  config: DevicePresenceClientConfig<TCaps>,
): DevicePresenceClient<TCaps> {
  const device = DevicePresenceIdentitySchema.parse(config.device);
  const requestTimeoutMs =
    config.requestTimeoutMs ?? DEFAULT_DEVICE_PRESENCE_REQUEST_TIMEOUT_MS;
  const defaultCommandTimeoutMs =
    config.commandTimeoutMs ?? DEFAULT_DEVICE_PRESENCE_COMMAND_TIMEOUT_MS;
  assertTimerMs('DevicePresenceClientConfig.requestTimeoutMs', requestTimeoutMs);
  assertTimerMs('DevicePresenceClientConfig.commandTimeoutMs', defaultCommandTimeoutMs);

  const explicitCapabilities = new Set<string>(config.capabilities ?? []);
  for (const cap of explicitCapabilities) {
    if (!Object.hasOwn(contract.capabilities, cap)) {
      throw new TypeError(`Unknown device presence capability "${cap}"`);
    }
  }

  const localStates = new Map<string, unknown>();
  if (config.initialStates) {
    const parsedInitial = contract.schemas.states.parse(config.initialStates);
    for (const [key, value] of Object.entries(parsedInitial)) {
      if (value !== undefined) localStates.set(key, value);
    }
  }

  const state: PresenceClientState<TCaps> = {
    contract,
    config,
    device,
    client: bindRealtimeClient(contract.realtime, config.transport),
    requestTimeoutMs,
    defaultCommandTimeoutMs,
    explicitCapabilities,
    localStates,
    subscribers: new Set(),
    commandHandlers: new Map(),
    latestSnapshot: undefined,
    generation: 0,
    announced: false,
    pendingAnnounce: undefined,
    closed: false,
  };

  const offSnapshot = state.client.on(contract.events.snapshot, (rawSnapshot) => {
    applyClientSnapshot(state, transportResult<DevicePresenceSnapshot<TCaps>>(rawSnapshot));
  });
  const offCommand = state.client.on(contract.events.commandDeliver, (rawDelivery) => {
    handleDeliveredCommand(state, rawDelivery);
  });
  const offConnection = state.client.onConnectionChange((connected) => {
    if (state.closed) return;
    state.generation += 1;
    state.announced = false;
    if (connected) void dispatchAnnounce(state, state.generation);
  });

  if (state.client.connected) {
    state.generation += 1;
    void dispatchAnnounce(state, state.generation);
  }

  return {
    device,
    getSnapshot: () => state.latestSnapshot,
    getDevices: () => state.latestSnapshot?.devices ?? [],
    subscribe(listener) {
      if (state.closed) return () => undefined;
      state.subscribers.add(listener);
      return () => {
        state.subscribers.delete(listener);
      };
    },
    publishState: (capability, value) => publishClientState(state, capability, value),
    sendCommand: (input) => sendClientCommand(state, input),
    onCommand(capability, handler) {
      if (!Object.hasOwn(contract.capabilities, capability)) {
        throw new TypeError(`Unknown device presence capability "${capability}"`);
      }
      const had =
        state.commandHandlers.has(capability) || state.explicitCapabilities.has(capability);
      state.commandHandlers.set(capability, (command, context) =>
        handler(transportResult(command), transportResult(context)),
      );
      if (!had && !state.closed && state.client.connected) {
        void dispatchAnnounce(state, state.generation);
      }
      return () => {
        state.commandHandlers.delete(capability);
        if (
          !state.explicitCapabilities.has(capability) &&
          !state.closed &&
          state.client.connected
        ) {
          void dispatchAnnounce(state, state.generation);
        }
      };
    },
    close() {
      if (state.closed) return;
      state.closed = true;
      state.generation += 1;
      state.announced = false;
      offSnapshot();
      offCommand();
      offConnection();
      state.subscribers.clear();
      state.commandHandlers.clear();
    },
  };
}
