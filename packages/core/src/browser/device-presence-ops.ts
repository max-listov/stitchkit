import type { z } from 'zod';
import { assertTimerMs } from '../internal/deadline';
import { clampTimerMs } from '../internal/timers';
import { transportResult } from '../internal/typed';
import type { RealtimeEventRegistry } from '../realtime/contract';
import type {
  DevicePresenceAnnounceAck,
  DevicePresenceCapabilityKey,
  DevicePresenceCapabilityMap,
  DevicePresenceCapabilityResult,
  DevicePresenceCommandDelivery,
  DevicePresenceCommandResult,
  DevicePresenceContract,
  DevicePresenceDevice,
  DevicePresenceIdentity,
  DevicePresenceSnapshot,
  DevicePresenceStateUpdateAck,
} from '../realtime/device-presence-contract';
import {
  RealtimeRequestDisconnectedError,
  RealtimeRequestTimeoutError,
} from '../realtime/request';
import type { DevicePresenceClientConfig } from './device-presence-client';
import type { BoundRealtimeClient } from './realtime-client';

const CLIENT_COMMAND_TIMEOUT_GRACE_MS = 1_000;

/** Metadata passed alongside a decoded command to `onCommand` handlers. */
export interface DevicePresenceCommandContext<K extends string = string> {
  readonly commandId: string;
  readonly fromDeviceId: string;
  readonly capability: K;
}

/** Handler invoked on a target device when an authorized account peer sends a command. */
export type DevicePresenceCommandHandler<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
> = (
  command: z.output<TCaps[K]['command']>,
  context: DevicePresenceCommandContext<K>,
) =>
  | DevicePresenceCapabilityResult<TCaps, K>
  | Promise<DevicePresenceCapabilityResult<TCaps, K>>;

/** Input for `DevicePresenceClient.sendCommand`. */
export interface DevicePresenceSendCommandInput<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
> {
  readonly targetDeviceId: string;
  readonly capability: K;
  readonly command: z.input<TCaps[K]['command']>;
  readonly timeoutMs?: number;
}

/** Listener notified whenever the account's online device snapshot updates. */
export type DevicePresenceSubscriber<TCaps extends DevicePresenceCapabilityMap> = (
  devices: readonly DevicePresenceDevice<TCaps>[],
  snapshot: DevicePresenceSnapshot<TCaps>,
) => void;

export type PresenceBoundClient = BoundRealtimeClient<
  RealtimeEventRegistry,
  RealtimeEventRegistry
>;
export type ErasedCommandHandler = (
  command: unknown,
  context: DevicePresenceCommandContext,
) => unknown | Promise<unknown>;

export interface PresenceClientState<TCaps extends DevicePresenceCapabilityMap> {
  readonly contract: DevicePresenceContract<TCaps>;
  readonly config: DevicePresenceClientConfig<TCaps>;
  readonly device: DevicePresenceIdentity;
  readonly client: PresenceBoundClient;
  readonly requestTimeoutMs: number;
  readonly defaultCommandTimeoutMs: number;
  readonly explicitCapabilities: Set<string>;
  readonly localStates: Map<string, unknown>;
  readonly subscribers: Set<DevicePresenceSubscriber<TCaps>>;
  readonly commandHandlers: Map<string, ErasedCommandHandler>;
  latestSnapshot: DevicePresenceSnapshot<TCaps> | undefined;
  generation: number;
  announced: boolean;
  pendingAnnounce: Promise<void> | undefined;
  closed: boolean;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function emitWireEvent(client: PresenceBoundClient, event: string, payload: unknown): boolean {
  return transportResult<boolean>(Reflect.apply(client.emit, client, [event, payload]));
}

function requestWireEvent<TResult>(
  client: PresenceBoundClient,
  event: string,
  payload: unknown,
  timeoutMs: number,
): Promise<TResult> {
  return transportResult<Promise<TResult>>(
    Reflect.apply(client.request, client, [event, payload, { timeoutMs }]),
  );
}

export function applyClientSnapshot<TCaps extends DevicePresenceCapabilityMap>(
  state: PresenceClientState<TCaps>,
  snapshot: DevicePresenceSnapshot<TCaps>,
): void {
  if (state.closed) return;
  state.latestSnapshot = snapshot;
  state.config.onSnapshot?.(snapshot);
  for (const subscriber of [...state.subscribers]) {
    subscriber(snapshot.devices, snapshot);
  }
}

export function dispatchAnnounce<TCaps extends DevicePresenceCapabilityMap>(
  state: PresenceClientState<TCaps>,
  epoch: number,
): Promise<void> {
  if (state.closed || !state.client.connected || epoch !== state.generation) {
    return Promise.resolve();
  }
  const mergedCaps = new Set<string>(state.explicitCapabilities);
  for (const key of state.commandHandlers.keys()) mergedCaps.add(key);
  const statesObj: Record<string, unknown> = {};
  for (const [key, value] of state.localStates) statesObj[key] = value;

  const run = (async () => {
    try {
      const ack = await requestWireEvent<DevicePresenceAnnounceAck<TCaps>>(
        state.client,
        state.contract.events.announce,
        {
          schemaVersion: 1,
          deviceId: state.device.deviceId,
          name: state.device.name,
          platform: state.device.platform,
          capabilities: [...mergedCaps].sort(),
          states: statesObj,
        },
        state.requestTimeoutMs,
      );
      if (state.closed || epoch !== state.generation) return;
      if (ack.outcome === 'ok') {
        state.announced = true;
        applyClientSnapshot(state, ack.snapshot);
        return;
      }
      state.announced = false;
      state.config.onError?.(
        new Error(`Device presence announce failed (${ack.code}): ${ack.message}`),
      );
    } catch (cause) {
      if (state.closed || epoch !== state.generation) return;
      state.announced = false;
      state.config.onError?.(toError(cause));
    }
  })();
  state.pendingAnnounce = run;
  void run.finally(() => {
    if (state.pendingAnnounce === run) state.pendingAnnounce = undefined;
  });
  return run;
}

export function handleDeliveredCommand<TCaps extends DevicePresenceCapabilityMap>(
  state: PresenceClientState<TCaps>,
  rawDelivery: unknown,
): void {
  if (state.closed) return;
  const delivery = transportResult<DevicePresenceCommandDelivery<TCaps>>(rawDelivery);
  const handler = state.commandHandlers.get(delivery.capability);
  if (!handler) {
    emitWireEvent(state.client, state.contract.events.commandResult, {
      schemaVersion: 1,
      commandId: delivery.commandId,
      outcome: 'error',
      code: 'UNSUPPORTED_CAPABILITY',
      message: `Device "${state.device.deviceId}" has no handler for capability "${delivery.capability}"`,
    });
    return;
  }

  void Promise.resolve()
    .then(() =>
      handler(delivery.command, {
        commandId: delivery.commandId,
        fromDeviceId: delivery.fromDeviceId,
        capability: delivery.capability,
      }),
    )
    .then(
      (result) => {
        if (state.closed) return;
        const capDef = state.contract.capabilities[delivery.capability];
        if (capDef?.result) {
          const parsed = capDef.result.safeParse(result);
          if (!parsed.success) {
            const err = new Error(
              `Command handler for "${delivery.capability}" returned an invalid result`,
            );
            state.config.onError?.(err);
            emitWireEvent(state.client, state.contract.events.commandResult, {
              schemaVersion: 1,
              commandId: delivery.commandId,
              outcome: 'error',
              code: 'HANDLER_ERROR',
              message: err.message,
            });
            return;
          }
          emitWireEvent(state.client, state.contract.events.commandResult, {
            schemaVersion: 1,
            commandId: delivery.commandId,
            outcome: 'ok',
            result: parsed.data,
          });
          return;
        }
        emitWireEvent(state.client, state.contract.events.commandResult, {
          schemaVersion: 1,
          commandId: delivery.commandId,
          outcome: 'ok',
          ...(result !== undefined && { result }),
        });
      },
      (cause) => {
        const err = toError(cause);
        state.config.onError?.(err);
        if (state.closed) return;
        emitWireEvent(state.client, state.contract.events.commandResult, {
          schemaVersion: 1,
          commandId: delivery.commandId,
          outcome: 'error',
          code: 'HANDLER_ERROR',
          message: err.message || 'Command handler failed',
        });
      },
    );
}

export async function publishClientState<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
>(
  state: PresenceClientState<TCaps>,
  capability: K,
  value: z.input<TCaps[K]['state']> | null,
): Promise<DevicePresenceStateUpdateAck> {
  const capDef = state.contract.capabilities[capability];
  if (!capDef) {
    throw new TypeError(`Unknown device presence capability "${capability}"`);
  }
  const nextValue = value === null ? null : capDef.state.parse(value);
  if (nextValue === null) state.localStates.delete(capability);
  else state.localStates.set(capability, nextValue);

  if (state.closed || !state.client.connected) {
    return {
      schemaVersion: 1,
      outcome: 'error',
      code: 'DISCONNECTED',
      message: 'Realtime transport is disconnected; state retained for next reconnect',
    };
  }
  if (state.pendingAnnounce) await state.pendingAnnounce;
  if (!state.announced && state.client.connected && !state.closed) {
    await dispatchAnnounce(state, state.generation);
  }
  if (state.closed || !state.client.connected) {
    return {
      schemaVersion: 1,
      outcome: 'error',
      code: 'DISCONNECTED',
      message: 'Realtime transport is disconnected; state retained for next reconnect',
    };
  }
  try {
    return await requestWireEvent<DevicePresenceStateUpdateAck>(
      state.client,
      state.contract.events.setState,
      { schemaVersion: 1, capability, state: nextValue },
      state.requestTimeoutMs,
    );
  } catch (cause) {
    if (cause instanceof RealtimeRequestTimeoutError) {
      return { schemaVersion: 1, outcome: 'error', code: 'TIMEOUT', message: cause.message };
    }
    return {
      schemaVersion: 1,
      outcome: 'error',
      code: 'DISCONNECTED',
      message: toError(cause).message,
    };
  }
}

export async function sendClientCommand<
  TCaps extends DevicePresenceCapabilityMap,
  K extends DevicePresenceCapabilityKey<TCaps>,
>(
  state: PresenceClientState<TCaps>,
  input: DevicePresenceSendCommandInput<TCaps, K>,
): Promise<DevicePresenceCommandResult<DevicePresenceCapabilityResult<TCaps, K>>> {
  const capDef = state.contract.capabilities[input.capability];
  if (!capDef) {
    throw new TypeError(`Unknown device presence capability "${input.capability}"`);
  }
  if (!input.targetDeviceId.trim()) {
    throw new TypeError('DevicePresenceSendCommandInput.targetDeviceId cannot be empty');
  }
  const effectiveTimeoutMs = input.timeoutMs ?? state.defaultCommandTimeoutMs;
  assertTimerMs('DevicePresenceSendCommandInput.timeoutMs', effectiveTimeoutMs);
  const parsedCommand = capDef.command.parse(input.command);
  const commandId = crypto.randomUUID();

  if (state.closed || !state.client.connected) {
    return {
      schemaVersion: 1,
      commandId,
      outcome: 'error',
      code: 'DISCONNECTED',
      message: 'Realtime transport is disconnected',
    };
  }

  const wireTimeoutMs = clampTimerMs(effectiveTimeoutMs + CLIENT_COMMAND_TIMEOUT_GRACE_MS);
  try {
    return await requestWireEvent<
      DevicePresenceCommandResult<DevicePresenceCapabilityResult<TCaps, K>>
    >(
      state.client,
      state.contract.events.sendCommand,
      {
        schemaVersion: 1,
        commandId,
        targetDeviceId: input.targetDeviceId,
        capability: input.capability,
        command: parsedCommand,
        timeoutMs: effectiveTimeoutMs,
      },
      wireTimeoutMs,
    );
  } catch (cause) {
    if (cause instanceof RealtimeRequestTimeoutError) {
      return {
        schemaVersion: 1,
        commandId,
        outcome: 'error',
        code: 'TIMEOUT',
        message: `Remote command timed out after ${effectiveTimeoutMs}ms`,
      };
    }
    if (cause instanceof RealtimeRequestDisconnectedError) {
      return {
        schemaVersion: 1,
        commandId,
        outcome: 'error',
        code: 'DISCONNECTED',
        message: cause.message,
      };
    }
    throw cause;
  }
}
