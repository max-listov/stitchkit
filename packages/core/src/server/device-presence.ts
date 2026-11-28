import { assertTimerMs } from '../internal/deadline';
import type { StitchLogger } from '../internal/logger';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { transportResult } from '../internal/typed';
import type { RealtimeRejectedEventHook } from '../realtime/contract';
import {
  DEFAULT_DEVICE_PRESENCE_COMMAND_TIMEOUT_MS,
  type DevicePresenceCapabilityMap,
  type DevicePresenceContract,
  type DevicePresenceDevice,
  type DevicePresenceSnapshot,
} from '../realtime/device-presence-contract';
import {
  buildAccountSnapshot,
  detachSocketFromAccount,
  emitServerEvent,
  handleAnnounceRequest,
  handleCommandRequest,
  handleCommandResultFrame,
  handleSetStateRequest,
  type PresenceRegistryState,
  type SocketEntry,
  syncSocketAccount,
} from './device-presence-handlers';
import {
  commandError,
  getPresenceAuxIndex,
  removePendingCommand,
} from './device-presence-registry';
import { bindRealtimeServer, type RealtimeServerHandle } from './realtime';

/** Authorization callback mapping a socket handshake identity to its owning user account id, or `null` to refuse presence. */
export type DevicePresenceAccountResolver<TData = unknown> = (
  identity: TData,
  socketId: string,
) => string | null | Promise<string | null>;

/** Configuration for `bindDevicePresence`. */
export interface DevicePresenceServerOptions<
  TCaps extends DevicePresenceCapabilityMap,
  TData = unknown,
> {
  /** Map the socket's authenticated handshake identity to an account id, or `null` for non-user principals (e.g. shared space keys). */
  readonly accountOf: DevicePresenceAccountResolver<TData>;
  /** Default timeout in ms for targeted remote commands when the request does not override `timeoutMs` (default 10 000). */
  readonly commandTimeoutMs?: number;
  /** Maximum concurrent online devices per account (default 64). */
  readonly maxDevicesPerAccount?: number;
  /** Optional clock for deterministic `connectedAt` timestamps (default `Date.now`). */
  readonly now?: () => number;
  /** Observer called whenever an account's presence snapshot changes. */
  readonly onSnapshot?: (snapshot: DevicePresenceSnapshot<TCaps>) => void;
  /** Hook forwarded to `bindRealtimeServer` for rejected wire frames. */
  readonly onRejected?: RealtimeRejectedEventHook;
  /** Optional logger forwarded to `bindRealtimeServer`. */
  readonly logger?: StitchLogger;
}

const DEFAULT_MAX_DEVICES_PER_ACCOUNT = 64;

/** Diagnostic snapshot of the in-memory device presence registry. */
export interface DevicePresenceServerSnapshot<TCaps extends DevicePresenceCapabilityMap> {
  readonly accounts: Readonly<Record<string, DevicePresenceSnapshot<TCaps>>>;
  readonly activeSockets: number;
  readonly pendingCommands: number;
}

/** Mounted server-side device presence registry and command router. */
export interface DevicePresenceServer<TCaps extends DevicePresenceCapabilityMap> {
  getAccountSnapshot(accountId: string): DevicePresenceSnapshot<TCaps>;
  listDevices(accountId: string): readonly DevicePresenceDevice<TCaps>[];
  snapshot(): DevicePresenceServerSnapshot<TCaps>;
  /** Re-evaluate `accountOf(raw.data)` for one connected socket (e.g. after session refresh or logout) and evict stale presence immediately. */
  readmit(socketId: string): Promise<void>;
  /** Detach listeners from `RealtimeServerHandle`, reject in-flight commands and clear all registry state. */
  unbind(): void;
}

/**
 * Mount account-scoped device presence, live capability states and targeted remote commands onto an
 * existing `RealtimeServerHandle` without opening a second Socket.IO connection.
 */
export function bindDevicePresence<
  const TCaps extends DevicePresenceCapabilityMap,
  TData = unknown,
>(
  contract: DevicePresenceContract<TCaps>,
  handle: RealtimeServerHandle<TData>,
  options: DevicePresenceServerOptions<TCaps, TData>,
): DevicePresenceServer<TCaps> {
  const defaultCommandTimeoutMs =
    options.commandTimeoutMs ?? DEFAULT_DEVICE_PRESENCE_COMMAND_TIMEOUT_MS;
  const maxDevicesPerAccount = options.maxDevicesPerAccount ?? DEFAULT_MAX_DEVICES_PER_ACCOUNT;
  assertTimerMs('DevicePresenceServerOptions.commandTimeoutMs', defaultCommandTimeoutMs);
  assertPositiveSafeInteger(
    'DevicePresenceServerOptions.maxDevicesPerAccount',
    maxDevicesPerAccount,
  );

  const server = bindRealtimeServer(contract.realtime, handle, {
    ...(options.onRejected && { onRejected: options.onRejected }),
    ...(options.logger && { logger: options.logger }),
  });

  const state: PresenceRegistryState<TCaps, TData> = {
    contract,
    options,
    defaultCommandTimeoutMs,
    maxDevicesPerAccount,
    now: options.now ?? (() => Date.now()),
    sockets: new Map(),
    accountSockets: new Map(),
    devicesByAccount: new Map(),
    revisionByAccount: new Map(),
    pendingCommands: new Map(),
    unbound: false,
  };

  const stopConnections = server.onConnection((connection) => {
    if (state.unbound) return;
    const entry: SocketEntry<TData> = {
      socketId: connection.raw.id,
      connection,
      accountId: null,
      deviceId: null,
      disconnected: false,
      cleanups: [],
    };
    state.sockets.set(entry.socketId, entry);

    const onDisconnect = (): void => {
      if (entry.disconnected) return;
      entry.disconnected = true;
      for (const cleanup of entry.cleanups) cleanup();
      entry.cleanups.length = 0;
      state.sockets.delete(entry.socketId);
      detachSocketFromAccount(state, entry);
    };
    connection.raw.on('disconnect', onDisconnect);
    entry.cleanups.push(() => {
      connection.raw.off('disconnect', onDisconnect);
    });

    entry.cleanups.push(
      connection.events.on(contract.events.announce, (payload, ack) => {
        void handleAnnounceRequest(state, entry, payload, transportResult(ack));
      }),
      connection.events.on(contract.events.setState, (payload, ack) => {
        void handleSetStateRequest(state, entry, payload, transportResult(ack));
      }),
      connection.events.on(contract.events.sendCommand, (payload, ack) => {
        void handleCommandRequest(state, entry, payload, transportResult(ack));
      }),
      connection.events.on(contract.events.commandResult, (payload) => {
        handleCommandResultFrame(state, entry, payload);
      }),
    );

    void syncSocketAccount(state, entry).then((accountId) => {
      if (!accountId || state.unbound || entry.disconnected) return;
      emitServerEvent(
        connection,
        contract.events.snapshot,
        buildAccountSnapshot(state, accountId),
      );
    });
  });

  return {
    getAccountSnapshot: (accountId) => buildAccountSnapshot(state, accountId),
    listDevices: (accountId) => buildAccountSnapshot(state, accountId).devices,
    snapshot() {
      const accounts: Record<string, DevicePresenceSnapshot<TCaps>> = {};
      const keys = new Set([...state.accountSockets.keys(), ...state.devicesByAccount.keys()]);
      for (const accountId of [...keys].sort()) {
        accounts[accountId] = buildAccountSnapshot(state, accountId);
      }
      return {
        accounts,
        activeSockets: state.sockets.size,
        pendingCommands: state.pendingCommands.size,
      };
    },
    async readmit(socketId) {
      const entry = state.sockets.get(socketId);
      if (!entry || entry.disconnected || state.unbound) return;
      const previousAccountId = entry.accountId;
      const nextAccountId = await syncSocketAccount(state, entry);
      if (
        nextAccountId &&
        nextAccountId !== previousAccountId &&
        !entry.disconnected &&
        !state.unbound
      ) {
        emitServerEvent(
          entry.connection,
          contract.events.snapshot,
          buildAccountSnapshot(state, nextAccountId),
        );
      }
    },
    unbind() {
      if (state.unbound) return;
      state.unbound = true;
      stopConnections();
      for (const [scopedKey, pending] of [...state.pendingCommands]) {
        removePendingCommand(state, scopedKey);
        clearTimeout(pending.timer);
        pending.settle(
          commandError(
            pending.commandId,
            'DEVICE_OFFLINE',
            'Device presence server unbound before command completed',
          ),
        );
      }
      for (const entry of [...state.sockets.values()]) {
        entry.disconnected = true;
        for (const cleanup of entry.cleanups) cleanup();
        entry.cleanups.length = 0;
      }
      state.sockets.clear();
      state.accountSockets.clear();
      state.devicesByAccount.clear();
      state.revisionByAccount.clear();
      const aux = getPresenceAuxIndex(state);
      aux.deviceOwners.clear();
      aux.pendingCountByAccount.clear();
    },
  };
}
