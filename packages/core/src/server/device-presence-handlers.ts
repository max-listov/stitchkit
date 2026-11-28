import { transportResult } from '../internal/typed';
import type { RealtimeEventRegistry } from '../realtime/contract';
import type {
  DevicePresenceAnnounceAck,
  DevicePresenceAnnouncePayload,
  DevicePresenceCapabilityKey,
  DevicePresenceCapabilityMap,
  DevicePresenceCommandDelivery,
  DevicePresenceCommandRequest,
  DevicePresenceCommandResult,
  DevicePresenceContract,
  DevicePresenceDevice,
  DevicePresenceSnapshot,
  DevicePresenceStates,
  DevicePresenceStateUpdateAck,
  DevicePresenceStateUpdatePayload,
} from '../realtime/device-presence-contract';
import type { DevicePresenceServerOptions } from './device-presence';
import {
  cleanupEmptyAccount,
  commandError,
  emitRegistrySnapshot,
  failPendingCommandsForSocket,
  getPresenceAuxIndex,
  indexDeviceOwner,
  pendingCommandKey,
  presenceError,
  removePendingCommand,
  unindexDeviceOwner,
  validateCommandLimits,
} from './device-presence-registry';
import type { RealtimeServerConnection } from './realtime';

export type PresenceServerConnection<TData> = RealtimeServerConnection<
  RealtimeEventRegistry,
  RealtimeEventRegistry,
  TData
>;

export interface SocketEntry<TData> {
  readonly socketId: string;
  readonly connection: PresenceServerConnection<TData>;
  accountId: string | null;
  deviceId: string | null;
  disconnected: boolean;
  readonly cleanups: Array<() => void>;
}

export interface LiveDeviceRecord<TCaps extends DevicePresenceCapabilityMap> {
  readonly accountId: string;
  readonly deviceId: string;
  readonly socketId: string;
  readonly name: string;
  readonly platform: string;
  readonly connectedAt: string;
  readonly capabilities: readonly DevicePresenceCapabilityKey<TCaps>[];
  readonly states: Record<string, unknown>;
}

export interface PendingCommand {
  readonly accountId: string;
  readonly commandId: string;
  readonly capability: string;
  readonly targetSocketId: string;
  readonly timer: ReturnType<typeof setTimeout>;
  settle(result: DevicePresenceCommandResult): void;
}

export interface PresenceRegistryState<TCaps extends DevicePresenceCapabilityMap, TData> {
  readonly contract: DevicePresenceContract<TCaps>;
  readonly options: DevicePresenceServerOptions<TCaps, TData>;
  readonly defaultCommandTimeoutMs: number;
  readonly maxDevicesPerAccount: number;
  readonly now: () => number;
  readonly sockets: Map<string, SocketEntry<TData>>;
  readonly accountSockets: Map<string, Set<SocketEntry<TData>>>;
  readonly devicesByAccount: Map<string, Map<string, LiveDeviceRecord<TCaps>>>;
  readonly revisionByAccount: Map<string, number>;
  readonly pendingCommands: Map<string, PendingCommand>;
  unbound: boolean;
}

export function buildAccountSnapshot<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  accountId: string,
): DevicePresenceSnapshot<TCaps> {
  const devices = state.devicesByAccount.get(accountId);
  const sorted: DevicePresenceDevice<TCaps>[] = devices
    ? [...devices.values()]
        .sort((a, b) => a.deviceId.localeCompare(b.deviceId))
        .map((record) => ({
          deviceId: record.deviceId,
          name: record.name,
          platform: record.platform,
          connectedAt: record.connectedAt,
          capabilities: [...record.capabilities],
          states: transportResult<DevicePresenceStates<TCaps>>({ ...record.states }),
        }))
    : [];
  return {
    schemaVersion: 1,
    accountId,
    revision: state.revisionByAccount.get(accountId) ?? 0,
    devices: sorted,
  };
}

export function emitServerEvent<TData>(
  connection: PresenceServerConnection<TData>,
  event: string,
  payload: unknown,
): void {
  Reflect.apply(connection.events.emit, connection.events, [event, payload]);
}

export function emitAccountSnapshot<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  accountId: string,
): DevicePresenceSnapshot<TCaps> {
  return emitRegistrySnapshot(state, accountId, buildAccountSnapshot, emitServerEvent);
}

export function detachSocketFromAccount<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  entry: SocketEntry<TData>,
): void {
  const previousAccountId = entry.accountId;
  const previousDeviceId = entry.deviceId;
  entry.accountId = null;
  entry.deviceId = null;
  if (!previousAccountId) return;

  const members = state.accountSockets.get(previousAccountId);
  if (members) {
    members.delete(entry);
    if (members.size === 0) state.accountSockets.delete(previousAccountId);
  }

  let deviceRemoved = false;
  if (previousDeviceId) {
    const devices = state.devicesByAccount.get(previousAccountId);
    const active = devices?.get(previousDeviceId);
    // Stale-socket guard: only remove the device if this socket is still its active owner.
    if (active && active.socketId === entry.socketId) {
      devices?.delete(previousDeviceId);
      unindexDeviceOwner(state, previousDeviceId, previousAccountId);
      if (devices && devices.size === 0) state.devicesByAccount.delete(previousAccountId);
      deviceRemoved = true;
    }
  }

  failPendingCommandsForSocket(
    state,
    entry.socketId,
    'Target device disconnected before responding',
  );
  if (deviceRemoved) emitAccountSnapshot(state, previousAccountId);
  else cleanupEmptyAccount(state, previousAccountId);
}

export async function syncSocketAccount<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  entry: SocketEntry<TData>,
): Promise<string | null> {
  let resolved: string | null = null;
  try {
    const candidate = await state.options.accountOf(entry.connection.raw.data, entry.socketId);
    resolved = typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : null;
  } catch (error) {
    state.options.logger?.warn('DevicePresenceServer accountOf threw', { error });
    resolved = null;
  }
  if (state.unbound || entry.disconnected) {
    detachSocketFromAccount(state, entry);
    return null;
  }
  if (entry.accountId !== resolved) {
    detachSocketFromAccount(state, entry);
    if (resolved !== null) {
      entry.accountId = resolved;
      let members = state.accountSockets.get(resolved);
      if (!members) {
        members = new Set();
        state.accountSockets.set(resolved, members);
      }
      members.add(entry);
    }
  }
  return resolved;
}

export async function handleAnnounceRequest<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  entry: SocketEntry<TData>,
  rawPayload: unknown,
  ack: (reply: DevicePresenceAnnounceAck<TCaps>) => void,
): Promise<void> {
  const accountId = await syncSocketAccount(state, entry);
  if (state.unbound || entry.disconnected) return;
  if (!accountId) {
    ack(
      presenceError('FORBIDDEN', 'Connection is not authorized for account device presence'),
    );
    return;
  }

  const payload = transportResult<DevicePresenceAnnouncePayload<TCaps>>(rawPayload);
  let devices = state.devicesByAccount.get(accountId);
  if (!devices) {
    devices = new Map();
    state.devicesByAccount.set(accountId, devices);
  }

  if (entry.deviceId && entry.deviceId !== payload.deviceId) {
    const prev = devices.get(entry.deviceId);
    if (prev && prev.socketId === entry.socketId) {
      devices.delete(entry.deviceId);
      unindexDeviceOwner(state, entry.deviceId, accountId);
      failPendingCommandsForSocket(
        state,
        entry.socketId,
        'Target device changed its announced identity',
      );
    }
  }

  const existing = devices.get(payload.deviceId);
  if (!existing && devices.size >= state.maxDevicesPerAccount) {
    ack(
      presenceError(
        'INVALID_COMMAND',
        `Account reached maximum online devices (${state.maxDevicesPerAccount})`,
      ),
    );
    return;
  }

  // Reconnect handoff: supersede the stale socket so its later disconnect cannot erase this device.
  if (existing && existing.socketId !== entry.socketId) {
    const previousSocket = state.sockets.get(existing.socketId);
    if (previousSocket && previousSocket.deviceId === payload.deviceId) {
      previousSocket.deviceId = null;
    }
    failPendingCommandsForSocket(
      state,
      existing.socketId,
      'Target device reconnected on a newer socket before responding',
    );
  }

  const nextStates: Record<string, unknown> = payload.states
    ? { ...payload.states }
    : existing && existing.socketId === entry.socketId
      ? { ...existing.states }
      : {};

  devices.set(payload.deviceId, {
    accountId,
    deviceId: payload.deviceId,
    socketId: entry.socketId,
    name: payload.name,
    platform: payload.platform,
    connectedAt: new Date(state.now()).toISOString(),
    capabilities: payload.capabilities ? [...new Set(payload.capabilities)] : [],
    states: nextStates,
  });
  indexDeviceOwner(state, payload.deviceId, accountId);
  entry.deviceId = payload.deviceId;
  const snapshot = emitAccountSnapshot(state, accountId);
  ack({ schemaVersion: 1, outcome: 'ok', snapshot });
}

export async function handleSetStateRequest<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  entry: SocketEntry<TData>,
  rawPayload: unknown,
  ack: (reply: DevicePresenceStateUpdateAck) => void,
): Promise<void> {
  const accountId = await syncSocketAccount(state, entry);
  if (state.unbound || entry.disconnected) return;
  if (!accountId) {
    ack(
      presenceError('FORBIDDEN', 'Connection is not authorized for account device presence'),
    );
    return;
  }
  if (!entry.deviceId) {
    ack(
      presenceError(
        'DEVICE_OFFLINE',
        'Device must announce before publishing capability state',
      ),
    );
    return;
  }
  const active = state.devicesByAccount.get(accountId)?.get(entry.deviceId);
  if (!active || active.socketId !== entry.socketId) {
    ack(
      presenceError(
        'DEVICE_OFFLINE',
        'Device socket is no longer the active registration for this deviceId',
      ),
    );
    return;
  }

  const payload = transportResult<DevicePresenceStateUpdatePayload<TCaps>>(rawPayload);
  if (payload.state === null) delete active.states[payload.capability];
  else active.states[payload.capability] = payload.state;
  const snapshot = emitAccountSnapshot(state, accountId);
  ack({ schemaVersion: 1, outcome: 'ok', revision: snapshot.revision });
}

export async function handleCommandRequest<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  entry: SocketEntry<TData>,
  rawPayload: unknown,
  ack: (reply: DevicePresenceCommandResult) => void,
): Promise<void> {
  const payload = transportResult<DevicePresenceCommandRequest<TCaps>>(rawPayload);
  const accountId = await syncSocketAccount(state, entry);
  if (state.unbound || entry.disconnected) return;
  if (!accountId) {
    ack(
      commandError(
        payload.commandId,
        'FORBIDDEN',
        'Connection is not authorized for account device presence',
      ),
    );
    return;
  }

  const scopedKey = pendingCommandKey(accountId, payload.commandId);
  const limitCheck = validateCommandLimits(state, accountId, scopedKey, payload);
  if (!limitCheck.ok) {
    ack(limitCheck.error);
    return;
  }

  const aux = getPresenceAuxIndex(state);
  const targetRecord = state.devicesByAccount.get(accountId)?.get(payload.targetDeviceId);
  if (!targetRecord) {
    const owners = aux.deviceOwners.get(payload.targetDeviceId);
    const foreignOwner = owners !== undefined && owners.size > 0;
    ack(
      commandError(
        payload.commandId,
        foreignOwner ? 'FORBIDDEN' : 'DEVICE_OFFLINE',
        foreignOwner
          ? 'Caller is not authorized to send commands to this device'
          : `Target device "${payload.targetDeviceId}" is offline`,
      ),
    );
    return;
  }

  const targetSocket = state.sockets.get(targetRecord.socketId);
  if (!targetSocket || targetSocket.disconnected) {
    ack(
      commandError(
        payload.commandId,
        'DEVICE_OFFLINE',
        `Target device "${payload.targetDeviceId}" is offline`,
      ),
    );
    return;
  }

  const timeoutMs = limitCheck.timeoutMs;
  let settled = false;
  const settle = (result: DevicePresenceCommandResult): void => {
    if (settled) return;
    settled = true;
    ack({ ...result, commandId: payload.commandId });
  };

  const timer = setTimeout(() => {
    removePendingCommand(state, scopedKey);
    settle(
      commandError(
        payload.commandId,
        'TIMEOUT',
        `Target device "${payload.targetDeviceId}" did not respond within ${timeoutMs}ms`,
      ),
    );
  }, timeoutMs);
  timer.unref?.();

  state.pendingCommands.set(scopedKey, {
    accountId,
    commandId: payload.commandId,
    capability: payload.capability,
    targetSocketId: targetSocket.socketId,
    timer,
    settle,
  });
  aux.pendingCountByAccount.set(
    accountId,
    (aux.pendingCountByAccount.get(accountId) ?? 0) + 1,
  );

  const delivery = transportResult<DevicePresenceCommandDelivery<TCaps>>({
    schemaVersion: 1,
    commandId: payload.commandId,
    fromDeviceId: entry.deviceId ?? entry.socketId,
    capability: payload.capability,
    command: payload.command,
  });
  emitServerEvent(targetSocket.connection, state.contract.events.commandDeliver, delivery);
}

export function handleCommandResultFrame<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  entry: SocketEntry<TData>,
  rawPayload: unknown,
): void {
  if (!entry.accountId) return;
  const result = transportResult<DevicePresenceCommandResult>(rawPayload);
  const scopedKey = pendingCommandKey(entry.accountId, result.commandId);
  const existing = state.pendingCommands.get(scopedKey);
  if (!existing || existing.targetSocketId !== entry.socketId) return;
  const pending = removePendingCommand(state, scopedKey);
  if (!pending) return;
  clearTimeout(pending.timer);

  if (result.outcome === 'ok') {
    const capDef = state.contract.capabilities[pending.capability];
    if (capDef?.result) {
      const parsed = capDef.result.safeParse(result.result);
      if (!parsed.success) {
        pending.settle(
          commandError(
            result.commandId,
            'HANDLER_ERROR',
            `Target device returned invalid result for capability "${pending.capability}"`,
          ),
        );
        return;
      }
      pending.settle({
        schemaVersion: 1,
        commandId: result.commandId,
        outcome: 'ok',
        result: parsed.data,
      });
      return;
    }
  }
  pending.settle(result);
}
