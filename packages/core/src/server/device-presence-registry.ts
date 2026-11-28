import type {
  DevicePresenceCapabilityMap,
  DevicePresenceCommandRequest,
  DevicePresenceCommandResult,
  DevicePresenceErrorCode,
  DevicePresenceSnapshot,
} from '../realtime/device-presence-contract';
import type {
  PendingCommand,
  PresenceRegistryState,
  PresenceServerConnection,
} from './device-presence-handlers';

export const DEFAULT_MAX_PENDING_COMMANDS = 1_024;
export const DEFAULT_MAX_PENDING_COMMANDS_PER_ACCOUNT = 64;
export const DEFAULT_MAX_COMMAND_TIMEOUT_MS = 60_000;
export const MAX_RETAINED_ACCOUNT_REVISIONS = 4_096;

interface PresenceAuxIndex {
  readonly deviceOwners: Map<string, Set<string>>;
  readonly pendingCountByAccount: Map<string, number>;
}

const registryAuxIndex = new WeakMap<object, PresenceAuxIndex>();

export function getPresenceAuxIndex<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
): PresenceAuxIndex {
  let aux = registryAuxIndex.get(state);
  if (!aux) {
    aux = { deviceOwners: new Map(), pendingCountByAccount: new Map() };
    registryAuxIndex.set(state, aux);
  }
  return aux;
}

export function indexDeviceOwner<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  deviceId: string,
  accountId: string,
): void {
  const owners = getPresenceAuxIndex(state).deviceOwners;
  let set = owners.get(deviceId);
  if (!set) {
    set = new Set();
    owners.set(deviceId, set);
  }
  set.add(accountId);
}

export function unindexDeviceOwner<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  deviceId: string,
  accountId: string,
): void {
  const owners = getPresenceAuxIndex(state).deviceOwners;
  const set = owners.get(deviceId);
  if (!set) return;
  set.delete(accountId);
  if (set.size === 0) owners.delete(deviceId);
}

export function pendingCommandKey(accountId: string, commandId: string): string {
  return `${accountId.length}:${accountId}:${commandId}`;
}

export function removePendingCommand<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  scopedKey: string,
): PendingCommand | undefined {
  const pending = state.pendingCommands.get(scopedKey);
  if (!pending) return undefined;
  state.pendingCommands.delete(scopedKey);
  const counts = getPresenceAuxIndex(state).pendingCountByAccount;
  const next = (counts.get(pending.accountId) ?? 1) - 1;
  if (next <= 0) counts.delete(pending.accountId);
  else counts.set(pending.accountId, next);
  return pending;
}

export function trimRetainedRevisions<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
): void {
  if (state.revisionByAccount.size <= MAX_RETAINED_ACCOUNT_REVISIONS) return;
  for (const accountId of state.revisionByAccount.keys()) {
    if (state.revisionByAccount.size <= MAX_RETAINED_ACCOUNT_REVISIONS) break;
    if (!state.accountSockets.has(accountId) && !state.devicesByAccount.has(accountId)) {
      state.revisionByAccount.delete(accountId);
    }
  }
}

export function cleanupEmptyAccount<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  accountId: string,
): void {
  const members = state.accountSockets.get(accountId);
  const devices = state.devicesByAccount.get(accountId);
  if (members && members.size === 0) state.accountSockets.delete(accountId);
  if (devices && devices.size === 0) state.devicesByAccount.delete(accountId);
  trimRetainedRevisions(state);
}

export function commandError(
  commandId: string,
  code: DevicePresenceErrorCode,
  message: string,
): DevicePresenceCommandResult {
  return { schemaVersion: 1, commandId, outcome: 'error', code, message };
}

export function presenceError(code: DevicePresenceErrorCode, message: string) {
  return { schemaVersion: 1 as const, outcome: 'error' as const, code, message };
}

export function emitRegistrySnapshot<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  accountId: string,
  buildSnapshot: (
    state: PresenceRegistryState<TCaps, TData>,
    accountId: string,
  ) => DevicePresenceSnapshot<TCaps>,
  emitEvent: (
    connection: PresenceServerConnection<TData>,
    event: string,
    payload: unknown,
  ) => void,
): DevicePresenceSnapshot<TCaps> {
  const nextRevision = (state.revisionByAccount.get(accountId) ?? 0) + 1;
  state.revisionByAccount.delete(accountId);
  state.revisionByAccount.set(accountId, nextRevision);
  const snapshot = buildSnapshot(state, accountId);
  const members = state.accountSockets.get(accountId);
  if (members) {
    for (const member of [...members]) {
      if (!member.disconnected) {
        emitEvent(member.connection, state.contract.events.snapshot, snapshot);
      }
    }
  }
  try {
    state.options.onSnapshot?.(snapshot);
  } catch (error) {
    state.options.logger?.warn('DevicePresenceServer onSnapshot threw', { error });
  }
  cleanupEmptyAccount(state, accountId);
  return snapshot;
}

export function failPendingCommandsForSocket<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  socketId: string,
  message: string,
): void {
  for (const [scopedKey, pending] of [...state.pendingCommands]) {
    if (pending.targetSocketId !== socketId) continue;
    removePendingCommand(state, scopedKey);
    clearTimeout(pending.timer);
    pending.settle(commandError(pending.commandId, 'DEVICE_OFFLINE', message));
  }
}

export function validateCommandLimits<TCaps extends DevicePresenceCapabilityMap, TData>(
  state: PresenceRegistryState<TCaps, TData>,
  accountId: string,
  scopedKey: string,
  payload: DevicePresenceCommandRequest<TCaps>,
):
  | { readonly ok: true; readonly timeoutMs: number }
  | { readonly ok: false; readonly error: DevicePresenceCommandResult } {
  if (state.pendingCommands.has(scopedKey)) {
    return {
      ok: false,
      error: commandError(
        payload.commandId,
        'INVALID_COMMAND',
        `Command id "${payload.commandId}" is already in flight`,
      ),
    };
  }
  const aux = getPresenceAuxIndex(state);
  const maxPerAccount = Math.min(
    DEFAULT_MAX_PENDING_COMMANDS,
    DEFAULT_MAX_PENDING_COMMANDS_PER_ACCOUNT,
  );
  if (
    state.pendingCommands.size >= DEFAULT_MAX_PENDING_COMMANDS ||
    (aux.pendingCountByAccount.get(accountId) ?? 0) >= maxPerAccount
  ) {
    return {
      ok: false,
      error: commandError(
        payload.commandId,
        'INVALID_COMMAND',
        'Too many pending remote commands in flight',
      ),
    };
  }
  const maxTimeoutMs = Math.max(DEFAULT_MAX_COMMAND_TIMEOUT_MS, state.defaultCommandTimeoutMs);
  if (payload.timeoutMs !== undefined && payload.timeoutMs > maxTimeoutMs) {
    return {
      ok: false,
      error: commandError(
        payload.commandId,
        'INVALID_COMMAND',
        `Command timeoutMs (${payload.timeoutMs}) exceeds server limit (${maxTimeoutMs}ms)`,
      ),
    };
  }
  return {
    ok: true,
    timeoutMs: payload.timeoutMs ?? Math.min(state.defaultCommandTimeoutMs, maxTimeoutMs),
  };
}
