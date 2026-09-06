import type { RealtimeServer } from '../server/realtime';
import type { RealtimeEmitArguments, RealtimeEventRegistry } from './contract';

const authorizedRoom = Symbol('stitchkit.authorized-room');

/**
 * A room reference minted by the registry. The token proves the name went
 * through *this* registry — a string from elsewhere cannot be emitted to by
 * accident. Whether a given socket may be in the room is decided per socket
 * by `rooms(identity)` at connect time and checked again on `join`.
 */
export interface AuthorizedSocketRoom {
  readonly name: string;
  readonly [authorizedRoom]: true;
}

export interface SocketRegistryConnection<TOutbound extends RealtimeEventRegistry, TIdentity> {
  readonly raw: {
    readonly id: string;
    readonly data: TIdentity;
    join(room: string): void | Promise<void>;
    leave(room: string): void | Promise<void>;
    on(event: 'disconnect', handler: () => void): unknown;
    off?(event: 'disconnect', handler: () => void): unknown;
  };
  readonly events: {
    emit<TEvent extends keyof TOutbound & string>(
      event: TEvent,
      ...args: RealtimeEmitArguments<TOutbound[TEvent]>
    ): boolean;
  };
}

export interface SocketRegistryServer<TOutbound extends RealtimeEventRegistry, TIdentity> {
  onConnection(
    handler: (
      connection: SocketRegistryConnection<TOutbound, TIdentity>,
    ) => void | Promise<void>,
  ): () => void;
}

export type SocketReplayFrame<TOutbound extends RealtimeEventRegistry> = {
  [TEvent in keyof TOutbound & string]: {
    readonly event: TEvent;
    readonly args: RealtimeEmitArguments<TOutbound[TEvent]>;
  };
}[keyof TOutbound & string];

export interface SocketRegistrySnapshot<TIdentity> {
  readonly revision: number;
  readonly connections: readonly {
    readonly socketId: string;
    readonly identity: TIdentity;
    readonly rooms: readonly string[];
    readonly replaying: boolean;
  }[];
  readonly rooms: Readonly<Record<string, readonly string[]>>;
}

export interface SocketRegistryOptions<TOutbound extends RealtimeEventRegistry, TIdentity> {
  /** Rooms this already-authenticated identity may join. */
  rooms(identity: TIdentity): Iterable<string> | Promise<Iterable<string>>;
  /**
   * Produce a coherent replay generation. Frames are captured before any are
   * emitted; live frames are buffered until the generation is complete.
   */
  replay?(context: {
    readonly identity: TIdentity;
    readonly rooms: readonly AuthorizedSocketRoom[];
    readonly revision: unknown;
  }):
    | readonly SocketReplayFrame<TOutbound>[]
    | Promise<readonly SocketReplayFrame<TOutbound>[]>;
  /** Stable application revision surrounding replay generation. */
  revision?(): unknown | Promise<unknown>;
  /**
   * Called when a coherent replay could not be delivered: the revision kept
   * moving for `replayAttempts` tries, or more than `maxBufferedFrames` live
   * frames arrived while one snapshot was open. The socket is still a member
   * of its rooms; the application decides what a resync means for it.
   */
  onResyncRequired?(socketId: string, identity: TIdentity): void | Promise<void>;
  replayAttempts?: number;
  /**
   * Live frames held per socket while its replay snapshot is open. Beyond
   * this the attempt is abandoned rather than delivering a history with a
   * hole — the buffer never grows without bound. Default `1_000`.
   */
  maxBufferedFrames?: number;
}

export interface SocketRegistry<TOutbound extends RealtimeEventRegistry, TIdentity> {
  /** The token for a room name; an empty room is a valid `emitTo` target (0 recipients). */
  room(name: string): AuthorizedSocketRoom;
  join(socketId: string, room: AuthorizedSocketRoom): Promise<void>;
  leave(socketId: string, room: AuthorizedSocketRoom): Promise<void>;
  emitTo<TEvent extends keyof TOutbound & string>(
    room: AuthorizedSocketRoom,
    event: TEvent,
    ...args: RealtimeEmitArguments<TOutbound[TEvent]>
  ): number;
  resync(socketId: string): Promise<boolean>;
  snapshot(): SocketRegistrySnapshot<TIdentity>;
  unbind(): Promise<void>;
}

interface Member<TOutbound extends RealtimeEventRegistry, TIdentity> {
  connection: SocketRegistryConnection<TOutbound, TIdentity>;
  identity: TIdentity;
  authorized: Set<string>;
  joined: Set<string>;
  /** Deferred live emits while a replay snapshot is open; `null` = pass-through. */
  buffer: Array<() => void> | null;
  overflow: boolean;
  replayPromise?: Promise<boolean>;
  disconnected: boolean;
  disconnect: () => void;
}

function freezeRoom(name: string): AuthorizedSocketRoom {
  return Object.freeze({ name, [authorizedRoom]: true as const });
}

/**
 * Add authorized membership and coherent replay to an existing authenticated
 * realtime server. Validation and transport emission stay owned by the
 * connection supplied by `bindRealtimeServer`.
 */
export function bindSocketRegistry<
  TOutbound extends RealtimeEventRegistry,
  TInbound extends RealtimeEventRegistry,
  TIdentity,
>(
  server: RealtimeServer<TOutbound, TInbound, TIdentity>,
  options: SocketRegistryOptions<TOutbound, TIdentity>,
): SocketRegistry<TOutbound, TIdentity>;
export function bindSocketRegistry<TOutbound extends RealtimeEventRegistry, TIdentity>(
  server: SocketRegistryServer<TOutbound, TIdentity>,
  options: SocketRegistryOptions<TOutbound, TIdentity>,
): SocketRegistry<TOutbound, TIdentity>;
export function bindSocketRegistry<TOutbound extends RealtimeEventRegistry, TIdentity>(
  server: SocketRegistryServer<TOutbound, TIdentity>,
  options: SocketRegistryOptions<TOutbound, TIdentity>,
): SocketRegistry<TOutbound, TIdentity> {
  const members = new Map<string, Member<TOutbound, TIdentity>>();
  // Tokens are recognised by membership in this set, not looked up by name, so
  // a name seen once does not live on in a map: a token the application drops
  // is collected with it, and one it caches stays valid.
  const minted = new WeakSet<AuthorizedSocketRoom>();
  let revision = 0;
  let closed = false;
  const setups = new Set<Promise<void>>();
  const maxBufferedFrames = Math.max(1, options.maxBufferedFrames ?? 1_000);

  const token = (name: string): AuthorizedSocketRoom => {
    const created = freezeRoom(name);
    minted.add(created);
    return created;
  };
  const assertToken = (room: AuthorizedSocketRoom): string => {
    if (!minted.has(room)) throw new Error('Room was not authorized by this registry');
    return room.name;
  };
  const leaveQuietly = async (
    member: Member<TOutbound, TIdentity>,
    room: string,
  ): Promise<void> => {
    // The socket is going away; an adapter that cannot leave a room for it
    // has nothing left to protect, and must not take the process down.
    try {
      await member.connection.raw.leave(room);
    } catch {
      // ignored on purpose
    }
  };
  const remove = async (member: Member<TOutbound, TIdentity>): Promise<void> => {
    if (member.disconnected) return;
    member.disconnected = true;
    member.connection.raw.off?.('disconnect', member.disconnect);
    members.delete(member.connection.raw.id);
    for (const room of member.joined) await leaveQuietly(member, room);
    member.joined.clear();
    member.buffer = null;
    revision += 1;
  };
  const replayMember = async (member: Member<TOutbound, TIdentity>): Promise<boolean> => {
    if (!options.replay || member.disconnected || closed)
      return !member.disconnected && !closed;
    const attempts = Math.max(1, options.replayAttempts ?? 3);
    for (
      let attempt = 0;
      attempt < attempts && !member.disconnected && !closed;
      attempt += 1
    ) {
      // A retry snapshot supersedes frames captured for the rejected snapshot.
      // The surrounding revision guarantees that the next stable snapshot
      // already contains them.
      member.buffer = [];
      member.overflow = false;
      const before = await options.revision?.();
      if (member.disconnected || closed) break;
      const frames = await options.replay({
        identity: member.identity,
        rooms: Object.freeze([...member.joined].map(token)),
        revision: before,
      });
      const after = await options.revision?.();
      if (member.disconnected || closed) break;
      if (options.revision && !Object.is(before, after)) continue;
      // Frames dropped past the buffer bound would leave a hole between the
      // snapshot and live traffic — retry instead of delivering that history.
      if (member.overflow) continue;
      for (const frame of frames) member.connection.events.emit(frame.event, ...frame.args);
      const buffered = member.buffer;
      member.buffer = null;
      for (const deferred of buffered ?? []) deferred();
      return !member.disconnected && !closed;
    }
    member.buffer = null;
    member.overflow = false;
    if (!member.disconnected)
      await options.onResyncRequired?.(member.connection.raw.id, member.identity);
    return false;
  };
  const resyncMember = (member: Member<TOutbound, TIdentity>): Promise<boolean> => {
    if (member.replayPromise) return member.replayPromise;
    const active = replayMember(member).finally(() => {
      if (member.replayPromise === active) member.replayPromise = undefined;
    });
    member.replayPromise = active;
    return active;
  };

  const setupConnection = async (
    connection: SocketRegistryConnection<TOutbound, TIdentity>,
  ): Promise<void> => {
    if (closed) return;
    const member: Member<TOutbound, TIdentity> = {
      connection,
      identity: connection.raw.data,
      authorized: new Set(),
      joined: new Set(),
      buffer: null,
      overflow: false,
      disconnected: false,
      disconnect: () => undefined,
    };
    // The disconnect listener goes on before anything is awaited: a socket
    // that drops while `rooms()` is still looking up its permissions emits
    // `disconnect` exactly once, and a listener attached afterwards would
    // leave a dead member counted by `emitTo` until `unbind`.
    member.disconnect = () => void remove(member);
    connection.raw.on('disconnect', member.disconnect);
    members.set(connection.raw.id, member);
    try {
      const authorized = new Set(await options.rooms(connection.raw.data));
      if (member.disconnected || closed) {
        await remove(member);
        return;
      }
      member.authorized = authorized;
      for (const name of authorized) {
        await connection.raw.join(name);
        if (member.disconnected || closed) {
          await leaveQuietly(member, name);
          await remove(member);
          return;
        }
        member.joined.add(name);
      }
      if (closed) {
        await remove(member);
        return;
      }
      revision += 1;
      await resyncMember(member);
    } catch {
      await remove(member);
    }
  };

  const stopListening = server.onConnection((connection) => {
    let setup: Promise<void>;
    setup = setupConnection(connection).finally(() => setups.delete(setup));
    setups.add(setup);
    return setup;
  });

  return {
    room: token,
    async join(socketId, room) {
      const name = assertToken(room);
      const member = members.get(socketId);
      if (!member) throw new Error(`Unknown socket: ${socketId}`);
      if (!member.authorized.has(name))
        throw new Error(`Socket is not authorized for room: ${name}`);
      if (member.joined.has(name)) return;
      await member.connection.raw.join(name);
      if (!member.disconnected) member.joined.add(name);
      revision += 1;
    },
    async leave(socketId, room) {
      const name = assertToken(room);
      const member = members.get(socketId);
      if (!member?.joined.has(name)) return;
      await member.connection.raw.leave(name);
      member.joined.delete(name);
      revision += 1;
    },
    emitTo(room, event, ...args) {
      const name = assertToken(room);
      let recipients = 0;
      for (const member of members.values()) {
        if (!member.joined.has(name) || member.disconnected) continue;
        recipients += 1;
        if (!member.buffer) {
          member.connection.events.emit(event, ...args);
        } else if (member.buffer.length >= maxBufferedFrames) {
          member.overflow = true;
        } else {
          member.buffer.push(() => member.connection.events.emit(event, ...args));
        }
      }
      return recipients;
    },
    resync: async (socketId) => {
      const member = members.get(socketId);
      return member ? resyncMember(member) : false;
    },
    snapshot() {
      const connections = [...members.values()].map((member) =>
        Object.freeze({
          socketId: member.connection.raw.id,
          identity: member.identity,
          rooms: Object.freeze([...member.joined].sort()),
          replaying: member.buffer !== null,
        }),
      );
      const roomMap: Record<string, readonly string[]> = {};
      for (const entry of connections) {
        for (const name of entry.rooms) {
          roomMap[name] = Object.freeze([...(roomMap[name] ?? []), entry.socketId]);
        }
      }
      return Object.freeze({
        revision,
        connections: Object.freeze(connections),
        rooms: Object.freeze(roomMap),
      });
    },
    async unbind() {
      if (closed) return;
      closed = true;
      stopListening();
      await Promise.allSettled([...setups]);
      const active = [...members.values()];
      for (const member of active) await remove(member);
    },
  };
}
