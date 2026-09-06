import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineRealtimeContract } from '../src/realtime/contract';
import { bindSocketRegistry } from '../src/realtime/registry';
import type { RealtimeServer } from '../src/server/realtime';

const contract = defineRealtimeContract({
  serverToClient: {
    state: { args: z.tuple([z.string()]) },
    delta: { args: z.tuple([z.number()]) },
  },
  clientToServer: {},
});
type Outbound = typeof contract.serverToClient;
type Identity = { userId: string };

function acceptsExistingServer(
  server: RealtimeServer<Outbound, Record<never, never>, Identity>,
) {
  return bindSocketRegistry(server, { rooms: ({ userId }) => [`user:${userId}`] });
}
void acceptsExistingServer;

function fakeServer() {
  const listeners = new Set<(connection: any) => void | Promise<void>>();
  return {
    onConnection(handler: (connection: any) => void | Promise<void>) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    async connect(connection: any) {
      await Promise.all([...listeners].map((listener) => listener(connection)));
    },
    count: () => listeners.size,
  };
}

function fakeConnection(id: string, identity: Identity) {
  const disconnect = new Set<() => void>();
  const emitted: unknown[][] = [];
  const joined = new Set<string>();
  return {
    raw: {
      id,
      data: identity,
      join: (room: string) => joined.add(room),
      leave: (room: string): void | Promise<void> => {
        joined.delete(room);
      },
      on: (_event: 'disconnect', handler: () => void) => disconnect.add(handler),
      off: (_event: 'disconnect', handler: () => void) => disconnect.delete(handler),
    },
    events: {
      emit: (event: string, ...args: unknown[]) => {
        emitted.push([event, ...args]);
        return true;
      },
    },
    emitted,
    joined,
    disconnectListeners: () => disconnect.size,
    disconnect: () => {
      for (const handler of disconnect) handler();
    },
  };
}

describe('authenticated socket registry', () => {
  test('keeps multi-tab membership, immutable snapshots, and disconnect cleanup', async () => {
    const server = fakeServer();
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
    });
    const first = fakeConnection('a', { userId: 'u1' });
    const second = fakeConnection('b', { userId: 'u1' });
    await server.connect(first);
    await server.connect(second);

    const room = registry.room('user:u1');
    expect(registry.emitTo(room, 'state', 'live')).toBe(2);
    expect(first.emitted).toEqual([['state', 'live']]);
    expect(second.emitted).toEqual([['state', 'live']]);
    const snapshot = registry.snapshot();
    expect(snapshot.rooms['user:u1']).toEqual(['a', 'b']);
    expect(Object.isFrozen(snapshot.connections)).toBe(true);

    first.disconnect();
    await Bun.sleep(0);
    expect(registry.snapshot().rooms['user:u1']).toEqual(['b']);
    await registry.unbind();
    expect(server.count()).toBe(0);
    expect(second.joined.size).toBe(0);
  });

  test('captures a stable replay and buffers live frames across a revision retry', async () => {
    const server = fakeServer();
    let applicationRevision = 0;
    let attempts = 0;
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
      revision: () => applicationRevision,
      replay: () => {
        attempts += 1;
        if (attempts === 1) {
          registry.emitTo(registry.room('user:u1'), 'delta', 1);
          applicationRevision += 1;
        }
        return [{ event: 'state', args: [`snapshot-${applicationRevision}`] }];
      },
    });
    const connection = fakeConnection('a', { userId: 'u1' });
    await server.connect(connection);
    expect(attempts).toBe(2);
    expect(connection.emitted).toEqual([['state', 'snapshot-1']]);
  });

  test('coalesces overlapping resync and preserves snapshot-before-live ordering', async () => {
    const server = fakeServer();
    const replayStarted = Promise.withResolvers<void>();
    const releaseReplay = Promise.withResolvers<void>();
    let replayCalls = 0;
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
      replay: async () => {
        replayCalls += 1;
        replayStarted.resolve();
        await releaseReplay.promise;
        return [{ event: 'state', args: ['snapshot'] }];
      },
    });
    const connection = fakeConnection('a', { userId: 'u1' });
    const connected = server.connect(connection);
    await replayStarted.promise;
    const overlapping = registry.resync('a');
    registry.emitTo(registry.room('user:u1'), 'delta', 1);
    releaseReplay.resolve();
    await Promise.all([connected, overlapping]);
    expect(replayCalls).toBe(1);
    expect(connection.emitted).toEqual([
      ['state', 'snapshot'],
      ['delta', 1],
    ]);
  });

  test('unbind waits for connection setup and leaves no late member behind', async () => {
    const server = fakeServer();
    const roomsStarted = Promise.withResolvers<void>();
    const releaseRooms = Promise.withResolvers<void>();
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: async ({ userId }) => {
        roomsStarted.resolve();
        await releaseRooms.promise;
        return [`user:${userId}`];
      },
    });
    const connection = fakeConnection('late', { userId: 'u1' });
    const connected = server.connect(connection);
    await roomsStarted.promise;
    const unbound = registry.unbind();
    releaseRooms.resolve();
    await Promise.all([connected, unbound]);
    expect(registry.snapshot().connections).toEqual([]);
    expect(connection.joined.size).toBe(0);
    expect(connection.disconnectListeners()).toBe(0);
    expect(server.count()).toBe(0);
  });
  test('an empty room is an emit target with zero recipients, not an error', async () => {
    const server = fakeServer();
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
    });
    // Nobody has joined `project:p1` yet — a job finishing for a project with
    // no open tab must still be a plain broadcast.
    expect(registry.emitTo(registry.room('project:p1'), 'state', 'done')).toBe(0);
    const connection = fakeConnection('a', { userId: 'u1' });
    await server.connect(connection);
    await expect(registry.join('a', registry.room('project:p1'))).rejects.toThrow(
      'not authorized',
    );
  });

  test('a replay whose live buffer overflows asks for a resync instead of a history with a hole', async () => {
    const server = fakeServer();
    const resyncs: string[] = [];
    let release = Promise.withResolvers<void>();
    let started = Promise.withResolvers<void>();
    let replays = 0;
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
      maxBufferedFrames: 2,
      replayAttempts: 2,
      onResyncRequired: (socketId) => {
        resyncs.push(socketId);
      },
      replay: async () => {
        replays += 1;
        started.resolve();
        await release.promise;
        return [{ event: 'state', args: [`snapshot-${replays}`] }];
      },
    });
    const connection = fakeConnection('a', { userId: 'u1' });
    const connected = server.connect(connection);
    await started.promise;
    // Three live frames against a bound of two: the first attempt is abandoned.
    for (const value of [1, 2, 3]) registry.emitTo(registry.room('user:u1'), 'delta', value);
    started = Promise.withResolvers<void>();
    const firstRelease = release;
    release = Promise.withResolvers<void>();
    firstRelease.resolve();
    // The retry opens a fresh snapshot; one frame arrives within the bound.
    await started.promise;
    registry.emitTo(registry.room('user:u1'), 'delta', 4);
    release.resolve();
    await connected;
    expect(replays).toBe(2);
    expect(resyncs).toEqual([]);
    expect(connection.emitted).toEqual([
      ['state', 'snapshot-2'],
      ['delta', 4],
    ]);
  });

  test('overflow on every attempt ends in onResyncRequired with nothing half-delivered', async () => {
    const server = fakeServer();
    const resyncs: string[] = [];
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
      maxBufferedFrames: 1,
      replayAttempts: 2,
      onResyncRequired: (socketId) => {
        resyncs.push(socketId);
      },
      replay: () => {
        registry.emitTo(registry.room('user:u1'), 'delta', 1);
        registry.emitTo(registry.room('user:u1'), 'delta', 2);
        return [{ event: 'state', args: ['snapshot'] }];
      },
    });
    const connection = fakeConnection('a', { userId: 'u1' });
    await server.connect(connection);
    expect(resyncs).toEqual(['a']);
    expect(connection.emitted).toEqual([]);
    expect(registry.snapshot().connections[0]?.replaying).toBe(false);
  });
  test('a socket that disconnects while rooms() is pending leaves no member behind', async () => {
    const server = fakeServer();
    const release = Promise.withResolvers<void>();
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: async ({ userId }) => {
        await release.promise;
        return [`user:${userId}`];
      },
    });
    const connection = fakeConnection('gone', { userId: 'u1' });
    const connected = server.connect(connection);
    // socket.io emits `disconnect` once — here, before the lookup answers.
    connection.disconnect();
    release.resolve();
    await connected;
    expect(registry.snapshot().connections).toEqual([]);
    expect(registry.emitTo(registry.room('user:u1'), 'state', 'x')).toBe(0);
    expect(connection.joined.size).toBe(0);
  });

  test('an adapter that cannot leave a room on disconnect does not reject into the process', async () => {
    const server = fakeServer();
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
    });
    const connection = fakeConnection('flaky', { userId: 'u1' });
    connection.raw.leave = () => Promise.reject(new Error('adapter down'));
    await server.connect(connection);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      connection.disconnect();
      await Bun.sleep(5);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    expect(rejections).toEqual([]);
    expect(registry.snapshot().connections).toEqual([]);
  });

  test('room tokens are not retained by name after their members leave', async () => {
    const server = fakeServer();
    const registry = bindSocketRegistry<Outbound, Identity>(server, {
      rooms: ({ userId }) => [`user:${userId}`],
    });
    for (let index = 0; index < 50; index += 1) {
      const connection = fakeConnection(`s${index}`, { userId: `u${index}` });
      await server.connect(connection);
      connection.disconnect();
    }
    await Bun.sleep(0);
    expect(Object.keys(registry.snapshot().rooms)).toEqual([]);
    // A token the application kept stays valid; a foreign object does not.
    const kept = registry.room('user:u0');
    expect(registry.emitTo(kept, 'state', 'x')).toBe(0);
    expect(() => registry.emitTo({ name: 'user:u0' } as never, 'state', 'x')).toThrow(
      'not authorized',
    );
  });
});
