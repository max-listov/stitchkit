import * as realtime from 'stitchkit/realtime';
import { z } from 'zod';

const contract = realtime.defineRealtimeContract({
  serverToClient: { changed: { args: z.tuple([z.object({ version: z.number() })]) } },
  clientToServer: {
    watch: {
      args: z.tuple([z.object({ topic: z.string() })]),
      ack: z.object({ accepted: z.boolean() }),
    },
  },
});

/**
 * Bind the contract to a socket the app already holds, as a phone app shares one
 * connection between watched reads and an agent controller. The transport has the
 * Socket.IO client shape `bindRealtimeClient` requires.
 */
export async function bindSharedSocket() {
  const handlers = new Map();
  const emitted = [];
  const transport = {
    connected: true,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    emit(event, ...args) {
      emitted.push([event, args]);
      return true;
    },
    emitWithAck(event, args, options) {
      emitted.push([event, args, options.timeoutMs]);
      return Promise.resolve({ accepted: true });
    },
    onConnectionChange() {
      return () => undefined;
    },
  };
  const rejected = [];
  const bound = realtime.bindRealtimeClient(contract, transport, {
    onRejected: ({ event, phase }) => rejected.push(`${event}:${phase}`),
  });
  const received = [];
  bound.on('changed', (value) => received.push(value));
  handlers.get('changed')({ version: 2 });
  handlers.get('changed')({ version: 'two' });
  const acknowledgement = await bound.request('watch', { topic: 'tasks' }, { timeoutMs: 500 });
  let outboundRefused = false;
  try {
    bound.emit('watch', { topic: 3 });
  } catch {
    outboundRefused = true;
  }
  return { received, rejected, acknowledgement, emitted, outboundRefused };
}

/** The outcome `bindSharedSocket` must produce, as one comparable string. */
export const expectedBinding = JSON.stringify({
  received: [{ version: 2 }],
  rejected: ['changed:arguments'],
  acknowledgement: { accepted: true },
  emitted: [['watch', [{ topic: 'tasks' }], 500]],
  outboundRefused: true,
});

// Metro retains a barrel's exports. Keep the entire realtime surface in the proof.
globalThis.realtimeSurface = Object.keys(realtime);
