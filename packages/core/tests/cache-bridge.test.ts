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
});
