import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ServerWebSocket, WebSocketHandler } from 'bun';
import { z } from 'zod';
import {
  bindRealtimeClient,
  createRealtimeClient,
  createSocketIOClient,
  type RealtimeClientTransport,
  type SocketIOClientConfig,
} from '../src/browser/socket-io';
import {
  defineRealtimeContract,
  RealtimeRequestDisconnectedError,
  RealtimeRequestInvalidAcknowledgementError,
  type RealtimeRequestPhaseEvent,
  RealtimeRequestPhaseEventSchema,
  RealtimeRequestTimeoutError,
} from '../src/realtime';
import { type BunServer, createServer } from '../src/server/bun';
import { bindRealtimeServer, type RealtimeServerConnection } from '../src/server/realtime';
import { createSocketIOServer, socketIoLane } from '../src/server/socket-io';
import type { SocketIOServerConfig } from '../src/server/socket-io-config';
import type { RawRoute } from '../src/server/types';
import { composeWebSocketHandlers, webSocketLane } from '../src/server/websocket';

interface ServerEvents {
  pong: (data: { n: number }) => void;
}
interface ClientEvents {
  ping: (data: { n: number }) => void;
}

const sock = await createSocketIOServer<ServerEvents, ClientEvents>({ cors: { origin: '*' } });
sock.io.on('connection', (s) => {
  s.on('ping', (data) => s.emit('pong', { n: data.n + 1 }));
});

const server = createServer({
  port: 0,
  socket: sock,
});
const URL = `http://localhost:${server.port}`;

/** Resolve once the client reports a live connection (next `connected` event). */
function whenConnected(client: {
  onConnectionChange(listener: (connected: boolean) => void): () => void;
}): Promise<void> {
  return new Promise((resolve) => {
    const off = client.onConnectionChange((connected) => {
      if (connected) {
        off();
        resolve();
      }
    });
  });
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(1_000).then(() => {
      throw new Error(`${label} timed out`);
    }),
  ]);
}

function makeClient() {
  return createSocketIOClient<ServerEvents, ClientEvents>({
    url: URL,
    transports: ['websocket'],
  });
}

describe('Socket.IO wrappers', () => {
  afterAll(() => {
    return server.shutdown({ gracePeriodMs: 0 });
  });

  test('server handle exposes a ready named /socket.io/*socketPath route', () => {
    expect(sock.route.method).toBe('ALL');
    expect(sock.route.path).toBe('/socket.io/*socketPath');
  });

  test('route fails loud when mounted without a Bun server', () => {
    expect(() => sock.route.handler(new Request(`${URL}/socket.io/`), { params: {} })).toThrow(
      /needs a running Bun server/,
    );
  });

  test('client round-trip — emit ping, receive typed pong', async () => {
    const client = makeClient();
    const pong = new Promise<{ n: number }>((resolve) => {
      client.on('pong', resolve);
    });

    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 41 });

    expect(await pong).toEqual({ n: 42 });
    client.disconnect();
  });

  test('subscription is durable across a disconnect/connect cycle', async () => {
    const client = makeClient();
    const received: number[] = [];
    client.on('pong', (data) => received.push(data.n));

    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 1 });
    await Bun.sleep(100);

    client.disconnect();
    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 10 });
    await Bun.sleep(100);

    client.disconnect();
    expect(received).toEqual([2, 11]);
  });

  test('emit while disconnected drops observably — false plus the onDroppedEmit hook', () => {
    const dropped: Array<{ event: string; args: unknown[] }> = [];
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: URL,
      transports: ['websocket'],
      onDroppedEmit: (drop) => dropped.push(drop),
    });
    expect(client.emit('ping', { n: 0 })).toBe(false);
    expect(client.connected).toBe(false);
    expect(dropped).toEqual([{ event: 'ping', args: [{ n: 0 }] }]);
  });

  test('emit in the lazy-load window right after connect() drops observably', async () => {
    const dropped: string[] = [];
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: URL,
      transports: ['websocket'],
      onDroppedEmit: (drop) => dropped.push(drop.event),
    });
    client.connect();
    // The peer loads asynchronously — this synchronous emit has no socket yet.
    expect(client.emit('ping', { n: 1 })).toBe(false);
    expect(dropped).toEqual(['ping']);

    await whenConnected(client);
    expect(client.emit('ping', { n: 2 })).toBe(true);
    client.disconnect();
    expect(client.emit('ping', { n: 3 })).toBe(false);
    expect(dropped).toEqual(['ping', 'ping']);
  });

  test('the validated realtime client reports drops and acceptance the same way', async () => {
    const dropped: Array<{ event: string; args: unknown[] }> = [];
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onDroppedEmit: (drop) => dropped.push(drop),
    });
    // Disconnected: valid payload → validated, then dropped at the transport.
    expect(client.emit('ready')).toBe(false);
    expect(dropped).toEqual([{ event: 'ready', args: [] }]);

    const connected = whenConnected(client);
    client.connect();
    await connected;
    expect(client.emit('ready')).toBe(true);
    client.disconnect();
    expect(client.emit('ready')).toBe(false);
    expect(dropped.length).toBe(2);
  });

  test('the reconnect window after a server kick drops observably until the recycle lands', async () => {
    const dropped: string[] = [];
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: 200,
      onDroppedEmit: (drop) => dropped.push(drop.event),
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;
    expect(client.emit('ping', { n: 1 })).toBe(true);

    // Server-initiated kick: the socket stays non-null but disconnected until
    // the recycle timer reconnects — the non-null half of the emit guard.
    const dropWindow = new Promise<void>((resolve) => {
      const off = client.onConnectionChange((isConnected) => {
        if (!isConnected) {
          off();
          resolve();
        }
      });
    });
    const reconnected = new Promise<void>((resolve) => {
      const off = client.onConnectionChange((isConnected) => {
        if (isConnected) {
          off();
          resolve();
        }
      });
    });
    for (const [, s] of sock.io.of('/').sockets) s.disconnect();
    await within(dropWindow, 'kick disconnect');
    expect(client.emit('ping', { n: 2 })).toBe(false);
    expect(dropped).toEqual(['ping']);
    await within(reconnected, 'recycle reconnect');
    expect(client.emit('ping', { n: 3 })).toBe(true);
    client.disconnect();
  });

  test('a void-returning mock no longer satisfies the client emit signature', () => {
    type ClientHandle = ReturnType<typeof makeClient>;
    const mock: Pick<ClientHandle, 'emit'> = {
      emit: () => true,
    };
    expect(mock.emit('ping', { n: 0 })).toBe(true);
    // @ts-expect-error — emit now reports acceptance; a void mock is a type error
    const broken: Pick<ClientHandle, 'emit'> = { emit: (): void => undefined };
    void broken;
  });
});

const realtimeContract = defineRealtimeContract({
  serverToClient: {
    pong: { args: z.tuple([z.object({ n: z.number() })]) },
    blob: { args: z.tuple([z.instanceof(Uint8Array)]) },
  },
  clientToServer: {
    ping: {
      args: z.tuple([z.object({ n: z.number() })]),
      ack: z.object({ accepted: z.boolean() }),
    },
    slow: {
      args: z.tuple([]),
      ack: z.object({ accepted: z.boolean() }),
    },
    lateAck: {
      args: z.tuple([]),
      ack: z.object({ accepted: z.boolean() }),
    },
    sum: {
      args: z.tuple([z.number(), z.number()]),
      ack: z.number(),
    },
    delayed: {
      args: z.tuple([z.number(), z.string()]),
      ack: z.string(),
    },
    inspect: {
      args: z.tuple([z.number()]),
      ack: z.object({ ok: z.literal(true) }),
    },
    disconnectBeforeAck: {
      args: z.tuple([]),
      ack: z.object({ accepted: z.boolean() }),
    },
    disconnectAfter: {
      args: z.tuple([z.number()]),
      ack: z.object({ accepted: z.boolean() }),
    },
    invalidAck: {
      args: z.tuple([]),
      ack: z.object({ accepted: z.boolean() }),
    },
    ready: { args: z.tuple([]) },
  },
});

const rejectedRealtimeEvents: string[] = [];
const readyRealtimeEvents: boolean[] = [];
let handledRealtimePings = 0;
const realtimeConnection =
  Promise.withResolvers<
    RealtimeServerConnection<
      typeof realtimeContract.serverToClient,
      typeof realtimeContract.clientToServer
    >
  >();
const realtimeHandle = await createSocketIOServer({ cors: { origin: '*' } });
const realtime = bindRealtimeServer(realtimeContract, realtimeHandle, {
  onRejected: ({ event, phase }) => {
    rejectedRealtimeEvents.push(`${event}:${phase}`);
  },
});
realtime.onConnection((connection) => {
  const { events, raw } = connection;
  raw.join('test-room');
  realtimeConnection.resolve(connection);
  events.on('ping', ({ n }, acknowledge) => {
    handledRealtimePings += 1;
    acknowledge({ accepted: true });
    events.emit('pong', { n: n + 1 });
    events.emit('blob', Buffer.from([1, 2, 3]));
  });
  events.on('slow', () => {
    // Deliberately never acknowledge: the client must use Socket.IO's native
    // acknowledgement timeout and translate it to a stable framework error.
  });
  events.on('lateAck', (acknowledge) => {
    setTimeout(() => acknowledge({ accepted: true }), 40);
  });
  events.on('sum', (left, right, acknowledge) => {
    acknowledge(left + right);
  });
  events.on('delayed', (delayMs, value, acknowledge) => {
    setTimeout(() => acknowledge(value), delayMs);
  });
  events.on('inspect', (delayMs, acknowledge) => {
    setTimeout(() => acknowledge({ ok: true }), delayMs);
  });
  events.on('disconnectBeforeAck', () => {
    raw.disconnect(true);
  });
  events.on('disconnectAfter', (delayMs) => {
    setTimeout(() => raw.disconnect(true), delayMs);
  });
  raw.on('invalidAck', (acknowledge: (value: unknown) => void) => {
    acknowledge({ accepted: 'not-a-boolean' });
  });
  events.on('ready', () => {
    readyRealtimeEvents.push(true);
  });
});
const realtimeServer = createServer({
  port: 0,
  socket: realtimeHandle,
});
const REALTIME_URL = `http://localhost:${realtimeServer.port}`;

describe('Zod-first realtime contracts', () => {
  afterAll(() => {
    return realtimeServer.shutdown({ gracePeriodMs: 0 });
  });

  test('binds validation to an existing transport without owning its lifecycle', async () => {
    const transport = createSocketIOClient({
      url: REALTIME_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false,
    });
    const rejections: string[] = [];
    const bound = bindRealtimeClient(realtimeContract, transport, {
      onRejected: ({ event, phase }) => {
        rejections.push(`${event}:${phase}`);
      },
    });

    expect(bound.connected).toBe(false);
    expect('connect' in bound).toBe(false);
    await expect(bound.request('ping', { n: 1 }, { timeoutMs: 100 })).rejects.toBeInstanceOf(
      RealtimeRequestDisconnectedError,
    );

    const connected = whenConnected(bound);
    transport.connect();
    await connected;
    expect(await bound.request('sum', 2, 3, { timeoutMs: 500 })).toBe(5);
    await expect(bound.request('slow', { timeoutMs: 20 })).rejects.toBeInstanceOf(
      RealtimeRequestTimeoutError,
    );
    await expect(bound.request('invalidAck', { timeoutMs: 500 })).rejects.toBeInstanceOf(
      RealtimeRequestInvalidAcknowledgementError,
    );
    expect(rejections).toContain('invalidAck:acknowledgement');
    expect(() => Reflect.apply(bound.emit, bound, ['ready', 'unexpected'])).toThrow();

    let inboundHandled = false;
    bound.on('pong', () => {
      inboundHandled = true;
    });
    realtimeHandle.io.emit('pong', { n: 'wrong' });
    await Bun.sleep(20);
    expect(rejections).toContain('pong:arguments');
    expect(inboundHandled).toBeFalse();

    await expect(
      bound.request('disconnectBeforeAck', { timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(RealtimeRequestDisconnectedError);
    expect(bound.connected).toBeFalse();
    transport.disconnect();
  });

  test('rejects an incomplete existing transport at bind time', () => {
    expect(() =>
      Reflect.apply(bindRealtimeClient, undefined, [realtimeContract, { connected: false }]),
    ).toThrow('does not implement on()');
  });

  test('preserves the existing transport receiver for connection subscriptions', () => {
    const listeners = new Set<(connected: boolean, reason?: string) => void>();
    const transport = {
      connected: false,
      on: (_event: string, _handler: (...args: unknown[]) => void) => () => undefined,
      emit: (_event: string, ..._args: unknown[]) => true,
      emitWithAck: async (_event: string, _args: unknown[]) => undefined,
      onConnectionChange(this: RealtimeClientTransport, listener) {
        expect(this).toBe(transport);
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } satisfies RealtimeClientTransport;

    const bound = bindRealtimeClient(realtimeContract, transport);
    const observed: boolean[] = [];
    const unsubscribe = bound.onConnectionChange((connected) => observed.push(connected));
    for (const listener of listeners) listener(true);
    unsubscribe();

    expect(observed).toEqual([true]);
    expect(listeners.size).toBe(0);
  });

  test('validates tuples, acknowledgements, no-payload and binary events', async () => {
    const clientRejection = Promise.withResolvers<string>();
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRejected: ({ event, phase }) => clientRejection.resolve(`${event}:${phase}`),
    });
    const pong = new Promise<{ n: number }>((resolve) => client.on('pong', resolve));
    const binary = new Promise<Uint8Array>((resolve) => client.on('blob', resolve));
    const acknowledgement = Promise.withResolvers<{ accepted: boolean }>();
    const connected = whenConnected(client);
    client.connect();
    await connected;
    client.emit('ping', { n: 4 }, acknowledgement.resolve);
    client.emit('ready');

    expect(await within(acknowledgement.promise, 'acknowledgement')).toEqual({
      accepted: true,
    });
    expect(await within(pong, 'pong')).toEqual({ n: 5 });
    const binaryOrRejection = await within(
      Promise.race([
        binary.then((value) => ({ value })),
        clientRejection.promise.then((rejection) => ({ rejection })),
      ]),
      'binary',
    );
    expect(binaryOrRejection).toEqual({ value: new Uint8Array([1, 2, 3]) });
    await Bun.sleep(20);
    expect(readyRealtimeEvents).toContain(true);
    client.disconnect();
  });

  test('request resolves a validated native acknowledgement', async () => {
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    const acknowledgement = await client.request('ping', { n: 8 }, { timeoutMs: 500 });
    expect(acknowledgement).toEqual({ accepted: true });
    expect(await client.request('sum', 20, 22, { timeoutMs: 500 })).toBe(42);

    const requestTypeAssertions = (candidate: typeof client): void => {
      // @ts-expect-error — request is available only for events with an ack schema
      void candidate.request('ready', { timeoutMs: 100 });
      // @ts-expect-error — request arguments are inferred from the event tuple
      void candidate.request('ping', { n: 'wrong' }, { timeoutMs: 100 });
      const typed: Promise<{ accepted: boolean }> = candidate.request(
        'ping',
        { n: 1 },
        { timeoutMs: 100 },
      );
      void typed;
    };
    void requestTypeAssertions;
    client.disconnect();
  });

  test('request phases distinguish Engine.IO receipt from validated settlement', async () => {
    const observations: RealtimeRequestPhaseEvent[] = [];
    let userPromiseSettled = false;
    let ackObservedBeforeUserSettlement = false;
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRequestPhase: (observation) => {
        observations.push(observation);
        expect(RealtimeRequestPhaseEventSchema.parse(observation)).toEqual(observation);
        expect(Object.keys(observation).sort()).toEqual([
          'elapsedMs',
          'event',
          'phase',
          'requestId',
        ]);
        if (observation.phase === 'engine-ack-received') {
          ackObservedBeforeUserSettlement = !userPromiseSettled;
        }
        // Every observer invocation throws; request truth must remain unchanged.
        throw new Error('observer failure');
      },
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    const pending = client.request('ping', { n: 8 }, { timeoutMs: 500 }).then((value) => {
      userPromiseSettled = true;
      return value;
    });
    expect(await pending).toEqual({ accepted: true });

    expect(ackObservedBeforeUserSettlement).toBeTrue();
    expect(observations.map(({ phase }) => phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);
    expect(new Set(observations.map(({ requestId }) => requestId)).size).toBe(1);
    expect(observations.every(({ event }) => event === 'ping')).toBeTrue();
    expect(observations.map(({ elapsedMs }) => elapsedMs)).toEqual(
      [...observations.map(({ elapsedMs }) => elapsedMs)].sort((left, right) => left - right),
    );
    client.disconnect();
  });

  test('concurrent reordered and timed-out requests retain exact phase identities', async () => {
    const observations: RealtimeRequestPhaseEvent[] = [];
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRequestPhase: (observation) => {
        observations.push(observation);
      },
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    const slow = client.request('delayed', 40, 'slow', { timeoutMs: 500 });
    const fast = client.request('delayed', 5, 'fast', { timeoutMs: 500 });
    const timeout = client
      .request('delayed', 60, 'late', { timeoutMs: 10 })
      .catch((error) => error);
    expect(await fast).toBe('fast');
    expect(await slow).toBe('slow');
    expect(await timeout).toBeInstanceOf(RealtimeRequestTimeoutError);
    await Bun.sleep(40);

    const byId = Map.groupBy(observations, ({ requestId }) => requestId);
    expect(byId.size).toBe(3);
    const sequences = [...byId.values()].map((events) => events.map(({ phase }) => phase));
    expect(
      sequences.filter(
        (phases) => phases.join(',') === 'engine-handoff,engine-ack-received,settled',
      ).length,
    ).toBe(2);
    expect(
      sequences.filter((phases) => phases.join(',') === 'engine-handoff,timeout').length,
    ).toBe(1);
    const handoffOrder = observations
      .filter(({ phase }) => phase === 'engine-handoff')
      .map(({ requestId }) => requestId);
    const settledOrder = observations
      .filter(({ phase }) => phase === 'settled')
      .map(({ requestId }) => requestId);
    expect(settledOrder).toEqual(handoffOrder.slice(0, 2).reverse());
    client.disconnect();
  });

  test('request-scoped phase hooks correlate reordered identical acknowledgements locally', async () => {
    const all: RealtimeRequestPhaseEvent[] = [];
    const slow: RealtimeRequestPhaseEvent[] = [];
    const fast: RealtimeRequestPhaseEvent[] = [];
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRequestPhase: (observation) => {
        all.push(observation);
      },
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    const slowResult = client.request('inspect', 40, {
      timeoutMs: 500,
      onPhase: (observation) => {
        slow.push(observation);
      },
    });
    const fastResult = client.request('inspect', 5, {
      timeoutMs: 500,
      onPhase: (observation) => {
        fast.push(observation);
      },
    });
    expect(await fastResult).toEqual({ ok: true });
    expect(await slowResult).toEqual({ ok: true });

    expect(slow.map(({ phase }) => phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);
    expect(fast.map(({ phase }) => phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);
    expect(new Set(slow.map(({ requestId }) => requestId)).size).toBe(1);
    expect(new Set(fast.map(({ requestId }) => requestId)).size).toBe(1);
    const [slowFirst] = slow;
    const [fastFirst] = fast;
    if (!slowFirst || !fastFirst) throw new Error('request phase hooks did not run');
    expect(slowFirst.requestId).not.toBe(fastFirst.requestId);
    expect(
      all.filter(({ phase }) => phase === 'settled').map(({ requestId }) => requestId),
    ).toEqual([fastFirst.requestId, slowFirst.requestId]);
    expect(Object.keys(slowFirst).sort()).toEqual([
      'elapsedMs',
      'event',
      'phase',
      'requestId',
    ]);
    client.disconnect();
  });

  test('request-scoped hooks survive reentrancy and close every terminal path once', async () => {
    const shared: RealtimeRequestPhaseEvent[] = [];
    const nested: RealtimeRequestPhaseEvent[] = [];
    const invalid: RealtimeRequestPhaseEvent[] = [];
    const late: RealtimeRequestPhaseEvent[] = [];
    const nestedResult = Promise.withResolvers<{ accepted: boolean }>();
    let nestedStarted = false;
    const sharedHook = (observation: RealtimeRequestPhaseEvent): void => {
      shared.push(observation);
      if (observation.phase === 'engine-handoff' && !nestedStarted) {
        nestedStarted = true;
        void client
          .request(
            'ping',
            { n: 2 },
            {
              timeoutMs: 500,
              onPhase: (phase) => {
                nested.push(phase);
              },
            },
          )
          .then(nestedResult.resolve, nestedResult.reject);
      }
      throw new Error('request observer failure');
    };
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRequestPhase: sharedHook,
      onRejected: () => undefined,
    });
    const disconnected: RealtimeRequestPhaseEvent[] = [];
    await expect(
      client.request(
        'ping',
        { n: 1 },
        {
          timeoutMs: 500,
          onPhase: (phase) => {
            disconnected.push(phase);
          },
        },
      ),
    ).rejects.toBeInstanceOf(RealtimeRequestDisconnectedError);
    expect(disconnected.map(({ phase }) => phase)).toEqual(['disconnected']);

    const connected = whenConnected(client);
    client.connect();
    await connected;
    expect(
      await client.request('ping', { n: 1 }, { timeoutMs: 500, onPhase: sharedHook }),
    ).toEqual({ accepted: true });
    expect(await within(nestedResult.promise, 'nested request')).toEqual({ accepted: true });
    const sharedByRequest = Map.groupBy(shared, ({ requestId }) => requestId);
    expect(sharedByRequest.size).toBe(3);
    expect(
      [...sharedByRequest.values()].map((events) => events.map(({ phase }) => phase)),
    ).toContainEqual(['disconnected']);
    expect(
      [...sharedByRequest.values()].filter(
        (events) =>
          events.map(({ phase }) => phase).join(',') ===
          'engine-handoff,engine-ack-received,settled',
      ).length,
    ).toBe(2);
    expect(nested.map(({ phase }) => phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);

    await expect(
      client.request('invalidAck', {
        timeoutMs: 500,
        onPhase: (phase) => {
          invalid.push(phase);
        },
      }),
    ).rejects.toBeInstanceOf(RealtimeRequestInvalidAcknowledgementError);
    expect(invalid.map(({ phase }) => phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);

    await expect(
      client.request('lateAck', {
        timeoutMs: 10,
        onPhase: (phase) => {
          late.push(phase);
        },
      }),
    ).rejects.toBeInstanceOf(RealtimeRequestTimeoutError);
    await Bun.sleep(60);
    expect(late.map(({ phase }) => phase)).toEqual(['engine-handoff', 'timeout']);
    client.disconnect();
  });

  test('request rejects immediately while disconnected', async () => {
    const client = createRealtimeClient(realtimeContract, { url: REALTIME_URL });
    const error = await client
      .request('ping', { n: 1 }, { timeoutMs: 500 })
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(RealtimeRequestDisconnectedError);
    expect(error.code).toBe('REALTIME_REQUEST_DISCONNECTED');
  });

  test('request timeout and in-flight disconnect are distinct', async () => {
    const timeoutClient = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
    });
    let connected = whenConnected(timeoutClient);
    timeoutClient.connect();
    await connected;
    const timeout = await timeoutClient
      .request('slow', { timeoutMs: 20 })
      .catch((cause) => cause);
    expect(timeout).toBeInstanceOf(RealtimeRequestTimeoutError);
    expect(timeout.code).toBe('REALTIME_REQUEST_TIMEOUT');
    timeoutClient.disconnect();

    const disconnectClient = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false,
    });
    connected = whenConnected(disconnectClient);
    disconnectClient.connect();
    await connected;
    const disconnected = await disconnectClient
      .request('disconnectBeforeAck', { timeoutMs: 500 })
      .catch((cause) => cause);
    expect(disconnected).toBeInstanceOf(RealtimeRequestDisconnectedError);
    expect(disconnected.code).toBe('REALTIME_REQUEST_DISCONNECTED');
    disconnectClient.disconnect();
  });

  test('disconnect reports one terminal request phase and late work cannot revive it', async () => {
    const observations: RealtimeRequestPhaseEvent[] = [];
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false,
      onRequestPhase: (observation) => {
        observations.push(observation);
      },
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    await expect(
      client.request('disconnectBeforeAck', { timeoutMs: 500 }),
    ).rejects.toBeInstanceOf(RealtimeRequestDisconnectedError);
    await Bun.sleep(40);
    expect(observations.map(({ phase }) => phase)).toEqual(['engine-handoff', 'disconnected']);
    expect(new Set(observations.map(({ requestId }) => requestId)).size).toBe(1);
    client.disconnect();
  });

  test('concurrent success and disconnect outcomes keep independent identities', async () => {
    const observations: RealtimeRequestPhaseEvent[] = [];
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false,
      onRequestPhase: (observation) => {
        observations.push(observation);
      },
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    const success = client.request('delayed', 5, 'fast', { timeoutMs: 500 });
    const interrupted = client
      .request('delayed', 60, 'slow', { timeoutMs: 500 })
      .catch((error) => error);
    const disconnecting = client
      .request('disconnectAfter', 20, { timeoutMs: 500 })
      .catch((error) => error);
    expect(await success).toBe('fast');
    expect(await interrupted).toBeInstanceOf(RealtimeRequestDisconnectedError);
    expect(await disconnecting).toBeInstanceOf(RealtimeRequestDisconnectedError);
    await Bun.sleep(60);

    const byId = Map.groupBy(observations, ({ requestId }) => requestId);
    expect(byId.size).toBe(3);
    const sequences = [...byId.values()].map((events) => events.map(({ phase }) => phase));
    expect(
      sequences.filter(
        (phases) => phases.join(',') === 'engine-handoff,engine-ack-received,settled',
      ).length,
    ).toBe(1);
    expect(
      sequences.filter((phases) => phases.join(',') === 'engine-handoff,disconnected').length,
    ).toBe(2);
    client.disconnect();
  });

  test('a late acknowledgement cannot settle a timed-out request twice', async () => {
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;
    let settlements = 0;
    await client.request('lateAck', { timeoutMs: 10 }).then(
      () => {
        settlements += 1;
      },
      (error) => {
        settlements += 1;
        expect(error).toBeInstanceOf(RealtimeRequestTimeoutError);
      },
    );
    await Bun.sleep(60);
    expect(settlements).toBe(1);
    client.disconnect();
  });

  test('invalid request acknowledgement reports onRejected and rejects', async () => {
    const rejection = Promise.withResolvers<string>();
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRejected: ({ event, phase }) => rejection.resolve(`${event}:${phase}`),
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;

    const invalid = await client
      .request('invalidAck', { timeoutMs: 500 })
      .catch((cause) => cause);
    expect(invalid).toBeInstanceOf(RealtimeRequestInvalidAcknowledgementError);
    expect(invalid.code).toBe('REALTIME_REQUEST_INVALID_ACKNOWLEDGEMENT');
    expect(await within(rejection.promise, 'invalid ack rejection')).toBe(
      'invalidAck:acknowledgement',
    );
    client.disconnect();
  });

  test('emits validated events through server and connection room targets', async () => {
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
    });
    const values: number[] = [];
    const received = Promise.withResolvers<void>();
    client.on('pong', ({ n }) => {
      values.push(n);
      if (values.length === 2) received.resolve();
    });
    const connected = whenConnected(client);
    client.connect();
    await connected;
    const connection = await realtimeConnection.promise;
    // Server-side emits report "accepted" — always true, an empty room included.
    expect(realtime.to('test-room').emit('pong', { n: 1 })).toBe(true);
    expect(connection.to('test-room').emit('pong', { n: 2 })).toBe(true);
    expect(realtime.to('nobody-here').emit('pong', { n: 3 })).toBe(true);
    await within(received.promise, 'room events');
    expect(values).toEqual([1, 2]);
    expect(() =>
      // @ts-expect-error — the runtime guard is the behavior under test.
      realtime.to('test-room').emit('pong', { n: 'bad' }),
    ).toThrow();
    client.disconnect();
  });

  test('rejects malformed inbound arguments before the application handler', async () => {
    const raw = createSocketIOClient<ServerEvents, { ping: (value: unknown) => void }>({
      url: REALTIME_URL,
      transports: ['websocket'],
    });
    raw.connect();
    await whenConnected(raw);
    raw.emit('ping', { n: 'wrong' });
    await Bun.sleep(20);
    expect(rejectedRealtimeEvents).toContain('ping:arguments');
    raw.disconnect();
  });

  test('requires a declared acknowledgement before the application handler', async () => {
    const raw = createSocketIOClient<ServerEvents, { ping: (value: unknown) => void }>({
      url: REALTIME_URL,
      transports: ['websocket'],
    });
    const handledBefore = handledRealtimePings;
    raw.connect();
    await whenConnected(raw);
    raw.emit('ping', { n: 7 });
    await Bun.sleep(20);
    expect(rejectedRealtimeEvents).toContain('ping:acknowledgement');
    expect(handledRealtimePings).toBe(handledBefore);
    raw.disconnect();
  });

  test('rejects malformed server events before a client handler', async () => {
    let handled = false;
    const rejection = Promise.withResolvers<string>();
    const client = createRealtimeClient(realtimeContract, {
      url: REALTIME_URL,
      transports: ['websocket'],
      onRejected: ({ event, phase }) => rejection.resolve(`${event}:${phase}`),
    });
    client.on('pong', () => {
      handled = true;
    });
    client.connect();
    await whenConnected(client);
    realtimeHandle.io.emit('pong', { n: 'wrong' });
    expect(await within(rejection.promise, 'client rejection')).toBe('pong:arguments');
    expect(handled).toBeFalse();
    client.disconnect();
  });

  test('fails synchronously before publishing malformed outbound values', () => {
    const client = createRealtimeClient(realtimeContract, { url: REALTIME_URL });
    expect(() => Reflect.apply(client.emit, client, ['ready', 'unexpected'])).toThrow();
  });
});

// ─── ServerOptions passthrough (maxHttpBufferSize → the Bun engine) ──────────

describe('Socket.IO ServerOptions passthrough', () => {
  test('maxHttpBufferSize reaches the Bun engine (websocket.maxPayloadLength)', async () => {
    const big = 5 * 1024 * 1024;
    const handle = await createSocketIOServer<ServerEvents, ClientEvents>({
      cors: { origin: '*' },
      serverOptions: { maxHttpBufferSize: big },
    });
    // On Bun the engine's maxPayloadLength is its maxHttpBufferSize — so a value
    // over the 1 MB default proves the option was forwarded, not dropped.
    expect(handle.websocket.maxPayloadLength).toBe(big);
    await handle.close();
  });

  test('default maxHttpBufferSize is the 1 MB engine default when omitted', async () => {
    const handle = await createSocketIOServer<ServerEvents, ClientEvents>({
      cors: { origin: '*' },
    });
    expect(handle.websocket.maxPayloadLength).toBe(1e6);
    await handle.close();
  });
});

// ─── CORS is optional (same-origin needs no allow-list) ─────────────────────

describe('Socket.IO CORS', () => {
  async function handshake(config: SocketIOServerConfig): Promise<Headers> {
    const handle = await createSocketIOServer<ServerEvents, ClientEvents>(config);
    const server = createServer({ port: 0, socket: handle });
    const response = await fetch(
      `http://localhost:${server.port}/socket.io/?EIO=4&transport=polling`,
      { headers: { origin: 'https://app.example' } },
    );
    await response.arrayBuffer();
    await handle.close();
    await server.shutdown();
    return response.headers;
  }

  test('omitting cors emits no allow-list at all — same-origin only', async () => {
    // A repository reached on its own origin cannot name a foreign one without
    // knowing where it will run. Absent must mean "no CORS headers", not "an
    // empty allow-list" — a browser elsewhere is refused, one here is not.
    const headers = await handshake({});
    expect(headers.get('access-control-allow-origin')).toBeNull();
    expect(headers.get('access-control-allow-credentials')).toBeNull();
  });

  test('a supplied origin is still allowed, with credentials defaulted on', async () => {
    const headers = await handshake({ cors: { origin: 'https://app.example' } });
    expect(headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(headers.get('access-control-allow-credentials')).toBe('true');
  });
});

// ─── Handshake auth (token / query / headers) ───────────────────────────────

interface Identity {
  token: string;
  room: string | null;
  tenant: string | null;
}
interface AuthServerEvents {
  identity: (info: Identity) => void;
}
interface AuthClientEvents {
  who: () => void;
}

const authSock = await createSocketIOServer<AuthServerEvents, AuthClientEvents>({
  cors: { origin: '*' },
});
// Handshake gate — accept the initial token and the rotated one, reject the rest.
authSock.io.use((s, next) => {
  const token = s.handshake.auth.token;
  if (token === 'good' || token === 'rotated-2') next();
  else next(new Error('unauthorized'));
});
authSock.io.on('connection', (s) => {
  s.on('who', () =>
    s.emit('identity', {
      token: String(s.handshake.auth.token),
      room: s.handshake.query.room ? String(s.handshake.query.room) : null,
      tenant: s.handshake.headers['x-tenant'] ? String(s.handshake.headers['x-tenant']) : null,
    }),
  );
});
const authServer = createServer({
  port: 0,
  socket: authSock,
});
const AUTH_URL = `http://localhost:${authServer.port}`;

function makeAuthClient(config: Partial<SocketIOClientConfig<AuthServerEvents>> = {}) {
  return createSocketIOClient<AuthServerEvents, AuthClientEvents>({
    url: AUTH_URL,
    transports: ['websocket'],
    ...config,
  });
}

describe('Socket.IO handshake auth', () => {
  afterAll(() => {
    return authServer.shutdown({ gracePeriodMs: 0 });
  });

  test('object auth — a valid token connects and reaches handshake.auth', async () => {
    const client = makeAuthClient({ auth: { token: 'good' } });
    const identity = new Promise<Identity>((resolve) => client.on('identity', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('who');

    expect((await identity).token).toBe('good');
    client.disconnect();
  });

  test('object auth — an invalid token is refused (never connects)', async () => {
    const client = makeAuthClient({ auth: { token: 'nope' }, reconnectionDelay: 50 });
    let everConnected = false;
    client.onConnectionChange((connected) => {
      if (connected) everConnected = true;
    });

    client.connect();
    await Bun.sleep(300);

    expect(everConnected).toBe(false);
    expect(client.connected).toBe(false);
    client.disconnect();
  });

  test('function auth is re-read on every (re)connect — a rotated token is picked up', async () => {
    let token = 'good';
    const client = makeAuthClient({ auth: () => ({ token }) });
    const seen: string[] = [];
    // A durable subscription — it must survive the reconnect cycle below.
    client.on('identity', (info) => seen.push(info.token));

    client.connect();
    await whenConnected(client);
    client.emit('who');
    await Bun.sleep(100);

    // Rotate the token, then reconnect through the wrapper. The durable handler
    // survives and the auth function is re-read, so the new token is sent — no
    // client recreation, no lost subscription.
    client.disconnect();
    token = 'rotated-2';
    client.connect();
    await whenConnected(client);
    client.emit('who');
    await Bun.sleep(100);

    expect(seen).toEqual(['good', 'rotated-2']);
    client.disconnect();
  });

  test('async function auth resolves before the handshake', async () => {
    const client = makeAuthClient({
      auth: async () => {
        await Bun.sleep(10);
        return { token: 'good' };
      },
    });
    const identity = new Promise<Identity>((resolve) => client.on('identity', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('who');

    expect((await identity).token).toBe('good');
    client.disconnect();
  });

  test('a failing function auth does not leave the handshake hanging', async () => {
    const client = makeAuthClient({
      auth: async () => {
        throw new Error('token unavailable');
      },
      reconnectionDelay: 50,
    });
    let everConnected = false;
    client.onConnectionChange((connected) => {
      if (connected) everConnected = true;
    });

    client.connect();
    await Bun.sleep(300);

    expect(everConnected).toBe(false);
    expect(client.connected).toBe(false);
    client.disconnect();
  });

  test('query and extraHeaders pass through to the handshake', async () => {
    const client = makeAuthClient({
      auth: { token: 'good' },
      query: { room: 'lobby' },
      extraHeaders: { 'x-tenant': 'acme' },
    });
    const identity = new Promise<Identity>((resolve) => client.on('identity', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('who');

    const info = await identity;
    expect(info.room).toBe('lobby');
    expect(info.tenant).toBe('acme');
    client.disconnect();
  });
});

// ─── Raw binary lane composed beside Socket.IO (Bun) ─────────────────────────

interface EchoData {
  lane: 'echo';
}
function isEchoSocket(ws: ServerWebSocket<unknown>): ws is ServerWebSocket<EchoData> {
  const data = ws.data;
  return typeof data === 'object' && data !== null && 'lane' in data && data.lane === 'echo';
}

const composeSock = await createSocketIOServer<ServerEvents, ClientEvents>({
  cors: { origin: '*' },
});
composeSock.io.on('connection', (s) => {
  s.on('ping', (data) => s.emit('pong', { n: data.n + 1 }));
});

// Raw lane: a separate upgrade route stamps the discriminator onto ws.data.
const echoUpgradeRoute: RawRoute<BunServer> = {
  method: 'GET',
  path: '/ws/echo',
  handler: (req, ctx) => {
    if (!ctx.server) throw new Error('[stitchkit] needs a running Bun server');
    const ok = ctx.server.upgrade(req, { data: { lane: 'echo' } });
    return ok ? new Response(null) : new Response(null, { status: 400 });
  },
};
const echoHandlers: WebSocketHandler<EchoData> = {
  open(ws) {
    // Prove ws.data is typed EchoData here — cast-free.
    ws.send(`open:${ws.data.lane}`);
  },
  message(ws, message) {
    ws.send(message);
  },
};

const composedWebSocket = composeWebSocketHandlers(
  [
    webSocketLane({ match: isEchoSocket, handlers: echoHandlers }),
    socketIoLane(composeSock.websocket),
  ],
  { maxPayloadLength: 4 * 1024 * 1024 },
);
const composeServer = createServer({
  port: 0,
  socket: composeSock,
  websocket: composedWebSocket,
  rawRoutes: [echoUpgradeRoute],
});
const COMPOSE_URL = `http://localhost:${composeServer.port}`;

/** Open a native WebSocket to the raw lane, collect `count` messages. */
function rawRoundTrip(payload: string, count: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${composeServer.port}/ws/echo`);
    const messages: string[] = [];
    const timer = setTimeout(() => reject(new Error('raw ws timed out')), 3000);
    ws.addEventListener('message', (event) => {
      messages.push(String(event.data));
      if (messages.length >= count) {
        clearTimeout(timer);
        ws.close();
        resolve(messages);
      }
    });
    ws.addEventListener('open', () => ws.send(payload));
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('raw ws error'));
    });
  });
}

describe('composed WebSocket lanes (Socket.IO + raw)', () => {
  afterAll(() => {
    return composeServer.shutdown({ gracePeriodMs: 0 });
  });

  test('the raw lane handles its own sockets', async () => {
    const messages = await rawRoundTrip('hello', 2);
    expect(messages).toEqual(['open:echo', 'hello']);
  });

  test('Socket.IO still round-trips through the same composed handler', async () => {
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: COMPOSE_URL,
      transports: ['websocket'],
    });
    const pong = new Promise<{ n: number }>((resolve) => client.on('pong', resolve));

    client.connect();
    await whenConnected(client);
    client.emit('ping', { n: 7 });

    expect(await pong).toEqual({ n: 8 });
    client.disconnect();
  });

  test('both lanes work on the same server, concurrently', async () => {
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: COMPOSE_URL,
      transports: ['websocket'],
    });
    const pong = new Promise<{ n: number }>((resolve) => client.on('pong', resolve));
    client.connect();
    await whenConnected(client);

    const [raw, _ignore] = await Promise.all([
      rawRoundTrip('concurrent', 2),
      (async () => {
        client.emit('ping', { n: 100 });
        return await pong;
      })(),
    ]);

    expect(raw).toEqual(['open:echo', 'concurrent']);
    expect(await pong).toEqual({ n: 101 });
    client.disconnect();
  });
});

// ─── Server-initiated disconnect (reason + recycle) ──────────────────────────

interface KickServerEvents {
  hi: () => void;
}
interface KickClientEvents {
  kick: () => void;
}

const kickSock = await createSocketIOServer<KickServerEvents, KickClientEvents>({
  cors: { origin: '*' },
});
// On `kick`, drop the socket server-side → the client sees reason
// `io server disconnect`, which halts Socket.IO's built-in reconnection.
kickSock.io.on('connection', (s) => {
  s.on('kick', () => s.disconnect(true));
});
const kickServer = createServer({
  port: 0,
  socket: kickSock,
});
const KICK_URL = `http://localhost:${kickServer.port}`;

describe('Socket.IO server-initiated disconnect', () => {
  afterAll(() => {
    return kickServer.shutdown({ gracePeriodMs: 0 });
  });

  test('onConnectionChange reports the disconnect reason', async () => {
    const client = createSocketIOClient<KickServerEvents, KickClientEvents>({
      url: KICK_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false, // isolate: just observe the reason
    });
    const reasons: Array<string | undefined> = [];
    client.onConnectionChange((connected, reason) => {
      if (!connected) reasons.push(reason);
    });

    client.connect();
    await whenConnected(client);
    client.emit('kick');
    await Bun.sleep(200);

    expect(reasons).toContain('io server disconnect');
    expect(client.connected).toBe(false);
    client.disconnect();
  });

  test('reconnectOnServerDisconnect recycles the client back to life', async () => {
    const client = createSocketIOClient<KickServerEvents, KickClientEvents>({
      url: KICK_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: 100,
    });
    const connects: boolean[] = [];
    client.onConnectionChange((connected) => connects.push(connected));

    client.connect();
    await whenConnected(client);
    client.emit('kick');
    // Disconnect fires, then the recycle reconnects after ~100 ms.
    await Bun.sleep(500);

    expect(client.connected).toBe(true);
    // Two ups (initial + recycled) with a down between them.
    expect(connects.filter(Boolean).length).toBeGreaterThanOrEqual(2);
    expect(connects).toContain(false);
    client.disconnect();
  });

  test('reconnectOnServerDisconnect: false stays down after a server kick', async () => {
    const client = createSocketIOClient<KickServerEvents, KickClientEvents>({
      url: KICK_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false,
    });
    client.connect();
    await whenConnected(client);
    client.emit('kick');
    await Bun.sleep(400);

    expect(client.connected).toBe(false);
    client.disconnect();
  });

  test('an explicit disconnect() cancels a pending recycle', async () => {
    const client = createSocketIOClient<KickServerEvents, KickClientEvents>({
      url: KICK_URL,
      transports: ['websocket'],
      reconnectOnServerDisconnect: 200,
    });
    client.connect();
    await whenConnected(client);
    client.emit('kick');
    await Bun.sleep(50); // recycle is queued but hasn't fired yet
    client.disconnect(); // must cancel it

    await Bun.sleep(400);
    expect(client.connected).toBe(false);
  });
});

// ─── Sticky events (retained last value) ─────────────────────────────────────

interface StateServerEvents {
  state: (data: { value: number }) => void;
}
interface StateClientEvents {
  noop: () => void;
}

const stickySock = await createSocketIOServer<StateServerEvents, StateClientEvents>({
  cors: { origin: '*' },
});
// Publish the current state once, on connect — a subscriber that arrives later
// would miss it without retention.
stickySock.io.on('connection', (s) => {
  s.emit('state', { value: 7 });
});
const stickyServer = createServer({
  port: 0,
  socket: stickySock,
});
const STICKY_URL = `http://localhost:${stickyServer.port}`;

describe('Socket.IO sticky events (retain)', () => {
  afterAll(() => {
    return stickyServer.shutdown({ gracePeriodMs: 0 });
  });

  test('a handler subscribed after the event still gets the last value', async () => {
    const client = createSocketIOClient<StateServerEvents, StateClientEvents>({
      url: STICKY_URL,
      transports: ['websocket'],
      retain: ['state'],
    });
    client.connect();
    await whenConnected(client);
    // Let the connect-time `state` emission arrive and be recorded.
    await Bun.sleep(100);

    // Subscribe *after* the event — the retained value is replayed synchronously.
    const late: Array<{ value: number }> = [];
    client.on('state', (data) => {
      late.push(data);
    });
    expect(late).toEqual([{ value: 7 }]);
    client.disconnect();
  });

  test('the retained value survives a disconnect/connect cycle', async () => {
    const client = createSocketIOClient<StateServerEvents, StateClientEvents>({
      url: STICKY_URL,
      transports: ['websocket'],
      retain: ['state'],
    });
    client.connect();
    await whenConnected(client);
    await Bun.sleep(100);
    client.disconnect();

    // Still replays while disconnected — the store lives outside the socket.
    const afterDisconnect: Array<{ value: number }> = [];
    client.on('state', (data) => {
      afterDisconnect.push(data);
    });
    expect(afterDisconnect).toEqual([{ value: 7 }]);
  });

  test('a non-retained event is not replayed to a late subscriber', async () => {
    const client = createSocketIOClient<StateServerEvents, StateClientEvents>({
      url: STICKY_URL,
      transports: ['websocket'],
      // no `retain` → no stickiness
    });
    client.connect();
    await whenConnected(client);
    await Bun.sleep(100);

    const late: Array<{ value: number }> = [];
    client.on('state', (data) => {
      late.push(data);
    });
    expect(late).toEqual([]);
    client.disconnect();
  });
});

describe('the client half of peer injection', () => {
  /**
   * The mirror of the server block below, and the same argument.
   *
   * `socket.io-client` is resolved through a variable specifier, so no bundler
   * can follow it BY CONSTRUCTION. A consumer shipping one self-contained
   * artifact — a CLI, an agent, a daemon that DIALS a socket rather than
   * accepting connections — therefore could not get the package into the file,
   * and learned about it at the first `connect()`. The server got a way back in
   * 0.60.0; without this the same consumer still had to patch stitchkit's built
   * `dist`, which is the dead end that release closed.
   */
  // A server of its own: the shared one above is shut down by its describe's
  // `afterAll`, which has already run by the time this block starts.
  let peerServer: ReturnType<typeof createServer>;
  let peerUrl = '';
  beforeAll(async () => {
    const handle = await createSocketIOServer<ServerEvents, ClientEvents>({
      cors: { origin: '*' },
    });
    handle.io.on('connection', (connection) => {
      connection.on('ping', (data) => connection.emit('pong', { n: data.n + 1 }));
    });
    peerServer = createServer({ port: 0, socket: handle });
    peerUrl = `http://localhost:${peerServer.port}`;
  });
  afterAll(() => peerServer.shutdown({ gracePeriodMs: 0 }));

  test('an injected loader is the one that is used, and it really connects', async () => {
    let calls = 0;
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: peerUrl,
      transports: ['websocket'],
      peers: {
        client: async () => {
          calls += 1;
          return await import('socket.io-client');
        },
      },
    });
    const connected = whenConnected(client);
    client.connect();
    await within(connected, 'injected-loader connect');
    // Not merely "the loader ran": the socket built from what it returned
    // completes a round trip. A loader that resolved to the wrong module would
    // pass a call-count assertion and fail here.
    const pong = new Promise<{ n: number }>((resolve) => {
      client.on('pong', resolve);
    });
    client.emit('ping', { n: 41 });
    expect(await within(pong, 'injected-loader pong')).toEqual({ n: 42 });
    expect(calls).toBe(1);
    client.disconnect();
  });

  test('a loader whose package is absent from the artifact reaches onConnectError', async () => {
    // Two things at once, and the second is why this is a fix and not only a
    // feature. The advice differs from the default path's, because the fixes
    // differ — telling someone to install a package on the machine is the wrong
    // answer for an artifact that was supposed to carry it. And the failure
    // ARRIVES somewhere: it used to be an unhandled rejection that took the
    // process down, leaving the caller nothing to catch, retry or report.
    const errors: { message: string; terminal: boolean }[] = [];
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: peerUrl,
      peers: {
        client: () => Promise.reject(new Error("Cannot find package 'socket.io-client'")),
      },
      onConnectError: (error) =>
        errors.push({ message: error.message, terminal: error.terminal }),
    });
    client.connect();
    await Bun.sleep(50);

    expect(errors).toHaveLength(1);
    expect(errors[0]?.terminal).toBe(true);
    expect(errors[0]?.message).toContain('through the loader passed in `peers`');
    expect(errors[0]?.message).toContain('the artifact does not contain it');
    expect(errors[0]?.message).not.toContain('bun add');
    // The attempt is over, so a later connect() may start a fresh one rather
    // than finding a client that believes it is already connecting.
    expect(client.connected).toBe(false);
  });

  test('a loader that returns the wrong module is refused by name', async () => {
    const errors: string[] = [];
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: peerUrl,
      // The likely slip: handing back a default export or a namespace with no
      // `io`. Without this it fails much later as `io is not a function`.
      peers: { client: () => Promise.resolve({ io: undefined as never }) },
      onConnectError: (error) => errors.push(error.message),
    });
    client.connect();
    await Bun.sleep(50);
    expect(errors[0]).toContain('did not return the "socket.io-client" module');
  });

  test('an error that is not a missing module is passed through untouched', async () => {
    // A loader that throws for its own reasons must not be reported as a
    // packaging problem — that would send the reader after the wrong thing.
    const errors: string[] = [];
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: peerUrl,
      peers: { client: () => Promise.reject(new Error('the loader itself is broken')) },
      onConnectError: (error) => errors.push(error.message),
    });
    client.connect();
    await Bun.sleep(50);
    expect(errors).toEqual(['the loader itself is broken']);
  });

  test('omitting peers changes nothing — the lazy default still connects', async () => {
    // The additive half of the promise: a project that never heard of `peers`
    // behaves exactly as it did, and one that never opens a socket still never
    // loads the package.
    const client = createSocketIOClient<ServerEvents, ClientEvents>({
      url: peerUrl,
      transports: ['websocket'],
    });
    const connected = whenConnected(client);
    client.connect();
    await within(connected, 'default-path connect');
    expect(client.connected).toBe(true);
    client.disconnect();
  });
});

describe('optional peers can be handed to the adapter', () => {
  /**
   * The escape hatch, and what it costs to get wrong.
   *
   * Peers are resolved through a VARIABLE so a consumer bundling an unrelated
   * `stitchkit/server` export never resolves them — which also means no bundler
   * can follow them, so a consumer shipping one self-contained file had no way
   * to get them into the artifact. The loaders are that way back. The lane
   * proves the artifact really starts without `node_modules`; these prove the
   * adapter honours what it was handed, and says something useful when it was
   * handed nonsense.
   */
  test('an injected loader is the one that is used', async () => {
    let calls = 0;
    const handle = await createSocketIOServer({
      cors: { origin: '*' },
      peers: {
        server: async () => {
          calls += 1;
          return await import('socket.io');
        },
      },
    });
    expect(calls).toBe(1);
    expect(typeof handle.io.emit).toBe('function');
    await handle.close();
  });

  test('a loader whose package is absent from the artifact gets the right advice', async () => {
    // The two failures have DIFFERENT fixes, which is why the message differs.
    // Telling someone to install a package on the machine is the wrong answer
    // for an artifact that was supposed to carry it, and it sends them looking
    // in the wrong place. (The default path's own message is exercised where it
    // can be — the consumer lane's missing-peer fixture, with nothing installed.)
    const failure = await createSocketIOServer({
      cors: { origin: '*' },
      peers: { server: () => Promise.reject(new Error("Cannot find package 'socket.io'")) },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : '';
    expect(message).toContain('through the loader passed in `peers`');
    expect(message).toContain('the artifact does not contain it');
    expect(message).not.toContain('bun add');
  });

  test('an error that is not a missing module is passed through untouched', async () => {
    // A loader that throws for its own reasons must not be reported as a
    // packaging problem — that would send the reader after the wrong thing.
    await expect(
      createSocketIOServer({
        cors: { origin: '*' },
        peers: { server: () => Promise.reject(new Error('the loader itself is broken')) },
      }),
    ).rejects.toThrow('the loader itself is broken');
  });
});
