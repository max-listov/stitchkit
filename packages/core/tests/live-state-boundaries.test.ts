import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createLiveStateController,
  createRealtimeClient,
  type LiveStateEventDecision,
  type LiveStateSource,
  parseNDJSON,
} from '../src';
import { defineRealtimeContract } from '../src/realtime';
import { createServer } from '../src/server/bun';
import { bindRealtimeServer } from '../src/server/realtime';
import { createSocketIOServer } from '../src/server/socket-io';
import { ndjsonRoute } from '../src/server/streaming-route';

const StateSchema = z
  .object({ revision: z.number().int().nonnegative(), values: z.array(z.string()) })
  .strict();
const EventSchema = z
  .object({ revision: z.number().int().positive(), value: z.string() })
  .strict();
type State = z.infer<typeof StateSchema>;
type Event = z.infer<typeof EventSchema>;

const FrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot'), state: StateSchema }).strict(),
  z.object({ type: z.literal('event'), event: EventSchema }).strict(),
]);

const servers: Array<{ shutdown(options: { gracePeriodMs: number }): unknown }> = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.shutdown({ gracePeriodMs: 0 });
});

function applyEvent(state: State, event: Event): LiveStateEventDecision<State> {
  if (event.revision <= state.revision) return { outcome: 'duplicate' };
  if (event.revision !== state.revision + 1) return { outcome: 'gap' };
  return {
    outcome: 'applied',
    state: { revision: event.revision, values: [...state.values, event.value] },
  };
}

function controllerFor(source: LiveStateSource<State, Event>) {
  return createLiveStateController({
    source,
    applyEvent,
    maxBufferedEvents: 8,
    maxBufferedBytes: 1_024,
    sizeOfEvent: (event) => event.value.length + 8,
  });
}

function whenConnected(client: {
  onConnectionChange(listener: (live: boolean) => void): () => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('realtime client did not connect')),
      5_000,
    );
    const off = client.onConnectionChange((live) => {
      if (!live) return;
      clearTimeout(timer);
      off();
      resolve();
    });
  });
}

function sourceFromSingleHTTPStream(url: string): LiveStateSource<State, Event> {
  return {
    async open({ signal, onEvent, onUnavailable }) {
      const request = new AbortController();
      const abort = () => request.abort(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      const response = await fetch(url, { signal: request.signal });
      const frames = parseNDJSON<unknown>(response);
      const first = await frames.next();
      const parsedFirst = first.done ? undefined : FrameSchema.safeParse(first.value);
      if (!parsedFirst?.success || parsedFirst.data.type !== 'snapshot') {
        request.abort();
        throw new TypeError('Live HTTP stream must begin with a valid snapshot frame');
      }

      const completion = (async () => {
        try {
          for await (const value of frames) {
            const frame = FrameSchema.parse(value);
            if (frame.type !== 'event') throw new TypeError('Snapshot may appear only once');
            onEvent(frame.event);
          }
          if (!request.signal.aborted) onUnavailable();
        } catch {
          if (!request.signal.aborted) onUnavailable();
        }
      })();

      return {
        snapshot: parsedFirst.data.state,
        async close() {
          signal.removeEventListener('abort', abort);
          request.abort();
          await frames.return(undefined);
          await completion;
        },
      };
    },
  };
}

describe('live state real transport boundaries', () => {
  test('Socket.IO buffers an event sent after the snapshot point but before its acknowledgement', async () => {
    const contract = defineRealtimeContract({
      serverToClient: { changed: { args: z.tuple([EventSchema]) } },
      clientToServer: { snapshot: { args: z.tuple([]), ack: StateSchema } },
    });
    const socket = await createSocketIOServer({ cors: { origin: '*' } });
    const realtime = bindRealtimeServer(contract, socket);
    realtime.onConnection(({ events }) => {
      events.on('snapshot', (acknowledge) => {
        events.emit('changed', { revision: 2, value: 'during-open' });
        acknowledge({ revision: 1, values: ['snapshot'] });
      });
    });
    const server = createServer({ port: 0, socket });
    servers.push(server);
    const client = createRealtimeClient(contract, {
      url: `http://localhost:${server.port}`,
      transports: ['websocket'],
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    let logicalCloseCalls = 0;
    const source: LiveStateSource<State, Event> = {
      async open({ signal, onEvent, onUnavailable }) {
        const offEvent = client.on('changed', onEvent);
        const offConnection = client.onConnectionChange((live) => {
          if (!live) onUnavailable();
        });
        let closed = false;
        const close = () => {
          if (closed) return;
          closed = true;
          logicalCloseCalls += 1;
          offEvent();
          offConnection();
        };
        signal.addEventListener('abort', close, { once: true });
        try {
          const snapshot = await client.request('snapshot', { timeoutMs: 5_000 });
          return { snapshot, close };
        } catch (error) {
          close();
          throw error;
        }
      },
    };
    const controller = controllerFor(source);

    expect(await controller.start()).toMatchObject({
      phase: 'live',
      value: { revision: 2, values: ['snapshot', 'during-open'] },
      appliedEvents: 1,
    });

    await controller.close();
    expect(logicalCloseCalls).toBe(1);
    client.disconnect();
  });

  test('one NDJSON generation validates a snapshot first and cannot miss its following event', async () => {
    async function* frames(
      _request: Request,
      { signal }: { signal: AbortSignal },
    ): AsyncGenerator<unknown> {
      yield { type: 'snapshot', state: { revision: 1, values: ['snapshot'] } };
      yield { type: 'event', event: { revision: 2, value: 'same-stream' } };
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    const server = createServer({
      port: 0,
      rawRoutes: [ndjsonRoute({ path: '/state', source: frames })],
    });
    servers.push(server);
    const controller = controllerFor(
      sourceFromSingleHTTPStream(`http://localhost:${server.port}/state`),
    );
    await controller.start();

    const deadline = Date.now() + 1_000;
    while (controller.getSnapshot().appliedEvents === 0 && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'live',
      value: { revision: 2, values: ['snapshot', 'same-stream'] },
      appliedEvents: 1,
    });
    await controller.close();
  });

  test('a malformed post-snapshot HTTP frame fails the generation without an unhandled task', async () => {
    async function* frames(): AsyncGenerator<unknown> {
      yield { type: 'snapshot', state: { revision: 1, values: ['snapshot'] } };
      yield { type: 'event', event: { revision: 'invalid', value: 'broken' } };
    }
    const server = createServer({
      port: 0,
      rawRoutes: [ndjsonRoute({ path: '/broken-state', source: frames })],
    });
    servers.push(server);
    const controller = controllerFor(
      sourceFromSingleHTTPStream(`http://localhost:${server.port}/broken-state`),
    );
    await controller.start();

    const deadline = Date.now() + 1_000;
    while (controller.getSnapshot().phase === 'live' && Date.now() < deadline) {
      await Bun.sleep(5);
    }
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'unavailable',
      reason: 'source-unavailable',
      value: { revision: 1 },
    });
    await controller.close();
  });

  test('a separate HTTP snapshot followed by attachment can silently miss the intervening change', async () => {
    let authoritative: State = { revision: 1, values: ['snapshot'] };
    async function* changes(
      _request: Request,
      { signal }: { signal: AbortSignal },
    ): AsyncGenerator<unknown> {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    const server = createServer({
      port: 0,
      rawRoutes: [
        {
          method: 'GET',
          path: '/snapshot',
          handler: () => Response.json(authoritative),
        },
        ndjsonRoute({ path: '/changes', source: changes }),
      ],
    });
    servers.push(server);
    const base = `http://localhost:${server.port}`;

    const snapshot = StateSchema.parse(await (await fetch(`${base}/snapshot`)).json());
    authoritative = { revision: 2, values: ['snapshot', 'missed'] };
    const streamAbort = new AbortController();
    const response = await fetch(`${base}/changes`, { signal: streamAbort.signal });

    expect(snapshot.revision).toBe(1);
    expect(authoritative.revision).toBe(2);
    expect(response.status).toBe(200);
    streamAbort.abort();
  });
});
