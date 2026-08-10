import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { type CacheBridgeSocket, createCacheBridge } from '../src/react/cache-bridge';

interface NoteUpdate {
  id: string;
  text: string;
}
type NoteEvents = { noteUpdated: (data: NoteUpdate) => void };

/**
 * Minimal fake emitter — `createCacheBridge` is transport-agnostic, it needs
 * only `on(event, handler) => unsubscribe`. No real socket required.
 */
function createFakeSocket() {
  const handlers = new Set<(data: NoteUpdate) => void>();
  const socket: CacheBridgeSocket<NoteEvents> = {
    on(_event, handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
  return {
    socket,
    emit(data: NoteUpdate) {
      for (const h of [...handlers]) h(data);
    },
  };
}

describe('createCacheBridge', () => {
  test('socket event updates the query cache via handler', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['note', '1'], { id: '1', text: 'old' });

    const fake = createFakeSocket();
    const bridge = createCacheBridge<NoteEvents>({
      socket: fake.socket,
      queryClient,
      handlers: {
        noteUpdated: (data, ctx) => {
          ctx.queryClient.setQueryData(['note', data.id], data);
        },
      },
    });
    bridge.connect();

    fake.emit({ id: '1', text: 'new' });

    expect(queryClient.getQueryData<NoteUpdate>(['note', '1'])).toEqual({
      id: '1',
      text: 'new',
    });
    bridge.disconnect();
  });

  test('markFresh suppresses a stale socket echo', () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(['note', '2'], { id: '2', text: 'mutated' });

    const fake = createFakeSocket();
    const bridge = createCacheBridge<NoteEvents>({
      socket: fake.socket,
      queryClient,
      handlers: {
        noteUpdated: (data, ctx) => {
          if (ctx.isFresh(['note', data.id])) return;
          ctx.queryClient.setQueryData(['note', data.id], data);
        },
      },
    });
    bridge.connect();

    bridge.markFresh(['note', '2']);
    fake.emit({ id: '2', text: 'stale-echo' });

    expect(queryClient.getQueryData<NoteUpdate>(['note', '2'])).toEqual({
      id: '2',
      text: 'mutated',
    });
    bridge.disconnect();
  });

  test('disconnect stops handler dispatch', () => {
    const queryClient = new QueryClient();
    const fake = createFakeSocket();
    let calls = 0;
    const bridge = createCacheBridge<NoteEvents>({
      socket: fake.socket,
      queryClient,
      handlers: {
        noteUpdated: () => {
          calls++;
        },
      },
    });
    bridge.connect();

    fake.emit({ id: '3', text: 'a' });
    expect(calls).toBe(1);

    bridge.disconnect();
    fake.emit({ id: '3', text: 'b' });
    expect(calls).toBe(1);
  });

  test('freshness expires, can be cleared, and is bounded by oldest-first eviction', async () => {
    const queryClient = new QueryClient();
    const fake = createFakeSocket();
    let context:
      | Parameters<
          NonNullable<
            Parameters<typeof createCacheBridge<NoteEvents>>[0]['handlers']['noteUpdated']
          >
        >[1]
      | undefined;
    const bridge = createCacheBridge<NoteEvents>({
      socket: fake.socket,
      queryClient,
      freshWindow: 20,
      maxFreshKeys: 2,
      handlers: {
        noteUpdated: (_data, ctx) => {
          context = ctx;
        },
      },
    });
    bridge.connect();
    fake.emit({ id: 'seed', text: 'seed' });
    if (!context) throw new Error('test setup: bridge context missing');

    bridge.markFresh(['note', '1']);
    bridge.markFresh(['note', '2']);
    bridge.markFresh(['note', '3']);
    expect(context.isFresh(['note', '1'])).toBe(false);
    expect(context.isFresh(['note', '2'])).toBe(true);
    expect(context.isFresh(['note', '3'])).toBe(true);

    bridge.clearFresh();
    expect(context.isFresh(['note', '2'])).toBe(false);
    bridge.markFresh(['note', '4']);
    await Bun.sleep(30);
    expect(context.isFresh(['note', '4'])).toBe(false);
    bridge.disconnect();
  });

  test('rejects invalid freshness bounds', () => {
    const queryClient = new QueryClient();
    const fake = createFakeSocket();
    expect(() =>
      createCacheBridge<NoteEvents>({
        socket: fake.socket,
        queryClient,
        maxFreshKeys: 0,
        handlers: {},
      }),
    ).toThrow(/maxFreshKeys/);
  });
});
