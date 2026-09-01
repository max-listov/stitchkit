import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { createRealtimeCacheBridge } from '../src/react/cache-bridge';
import type { RealtimeEventHandler } from '../src/realtime/contract';
import type { ValidatedRealtimeSocket } from '../src/realtime/socket';

const NoteSchema = z.object({ id: z.string(), title: z.string() });
const inbound = { noteUpdated: { args: z.tuple([NoteSchema]) } } as const;
type Inbound = typeof inbound;

/**
 * A socket that satisfies the validated contract surface without a transport.
 *
 * The defect this file guards is a TYPE one — every payload inferred as `never` — so the runtime
 * here only has to be real enough to deliver one event and prove the handler that received it is
 * the handler the contract describes.
 */
function fakeRealtimeSocket() {
  const handlers = new Map<string, RealtimeEventHandler<Inbound['noteUpdated']>>();
  const socket = {
    on(event: string, handler: RealtimeEventHandler<Inbound['noteUpdated']>) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    emit: () => true,
    close: () => undefined,
  };
  return { socket, handlers };
}

describe('cache bridge over a validated realtime contract', () => {
  test('the handler receives the contract payload, not never', () => {
    const queryClient = new QueryClient();
    const fake = fakeRealtimeSocket();
    const seen: string[] = [];

    const bridge = createRealtimeCacheBridge<Inbound>({
      socket: fake.socket as unknown as ValidatedRealtimeSocket<Inbound, Inbound>,
      queryClient,
      handlers: {
        noteUpdated: (data) => {
          // The whole defect in one line: this used to be a property access on `never`.
          seen.push(data.id);
          seen.push(data.title);
        },
      },
    });

    bridge.connect();
    fake.handlers.get('noteUpdated')?.({ id: 'n-1', title: 'first' });
    expect(seen).toEqual(['n-1', 'first']);
    bridge.disconnect();
  });

  test('a property the contract does not declare is refused by the compiler', () => {
    const queryClient = new QueryClient();
    const fake = fakeRealtimeSocket();
    createRealtimeCacheBridge<Inbound>({
      socket: fake.socket as unknown as ValidatedRealtimeSocket<Inbound, Inbound>,
      queryClient,
      handlers: {
        noteUpdated: (data) => {
          // @ts-expect-error the payload is the contract's tuple element, so it is checked
          void data.absent;
        },
      },
    });
    expect(true).toBe(true);
  });
});
