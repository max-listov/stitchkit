import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createRealtimeClient,
  defineRealtimeContract,
  RealtimeRequestDisconnectedError,
  type RealtimeRequestPhaseEvent,
  RealtimeRequestTimeoutError,
} from '../src';
import { bindRealtimeServer, createServer, createSocketIOServer } from '../src/server';

const NumberSchema = z.number();
const ArgsSchema = z.tuple([NumberSchema]);
const EmptyArgsSchema = z.tuple([]);
const contract = defineRealtimeContract({
  serverToClient: {},
  clientToServer: {
    echo: { args: ArgsSchema, ack: NumberSchema },
    late: { args: EmptyArgsSchema, ack: NumberSchema },
    drop: { args: EmptyArgsSchema, ack: NumberSchema },
  },
});

test('request observation succeeds without randomUUID after an unobserved control', async () => {
  const socket = await createSocketIOServer({});
  const binding = bindRealtimeServer(contract, socket);
  binding.onConnection((peer) => {
    peer.events.on('echo', (value, ack) => ack(value));
  });
  const server = createServer({ port: 0, socket });
  const client = createRealtimeClient(contract, {
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
    reconnectOnServerDisconnect: false,
  });
  const ready = Promise.withResolvers<void>();
  client.onConnectionChange((connected) => {
    if (connected) ready.resolve();
  });
  client.connect();
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  try {
    await Promise.race([
      ready.promise,
      Bun.sleep(1000).then(() => {
        throw new Error('connect timeout');
      }),
    ]);
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    expect(await client.request('echo', 1, { timeoutMs: 500 })).toBe(1);
    const phases: RealtimeRequestPhaseEvent[] = [];
    expect(
      await client.request('echo', 2, {
        timeoutMs: 500,
        onPhase: (phase) => {
          phases.push(phase);
        },
      }),
    ).toBe(2);
    expect(phases.map((phase) => phase.phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else Reflect.deleteProperty(crypto, 'randomUUID');
    client.disconnect();
    await server.shutdown({ gracePeriodMs: 0 });
  }
});

for (const scope of ['client', 'request']) {
  test(`${scope} observation without randomUUID preserves terminal identity across timeout, disconnect and reconnect`, async () => {
    const socket = await createSocketIOServer({});
    const binding = bindRealtimeServer(contract, socket);
    const lateDone = Promise.withResolvers<void>();
    binding.onConnection(({ events, raw }) => {
      events.on('echo', (value, ack) => ack(value));
      events.on('late', (ack) => {
        setTimeout(() => {
          ack(7);
          lateDone.resolve();
        }, 40);
      });
      events.on('drop', () => raw.disconnect(true));
    });
    const server = createServer({ port: 0, socket });
    const phases: RealtimeRequestPhaseEvent[] = [];
    const observe = (phase: RealtimeRequestPhaseEvent) => {
      phases.push(phase);
    };
    const client = createRealtimeClient(contract, {
      url: `http://localhost:${server.port}`,
      transports: ['websocket'],
      reconnectOnServerDisconnect: false,
      onRequestPhase: scope === 'client' ? observe : undefined,
    });
    const ready = () =>
      new Promise<void>((resolve) => {
        const off = client.onConnectionChange((connected) => {
          if (connected) {
            off();
            resolve();
          }
        });
        client.connect();
      });
    const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    const restore = () => {
      if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
      else Reflect.deleteProperty(crypto, 'randomUUID');
    };
    const options = { timeoutMs: 500, onPhase: scope === 'request' ? observe : undefined };
    try {
      await ready();
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
      expect(
        await Promise.all([
          client.request('echo', 1, options),
          client.request('echo', 2, options),
        ]),
      ).toEqual([1, 2]);
      await expect(
        client.request('late', { ...options, timeoutMs: 5 }),
      ).rejects.toBeInstanceOf(RealtimeRequestTimeoutError);
      const afterTimeout = phases.length;
      await lateDone.promise;
      await Bun.sleep(20);
      expect(phases).toHaveLength(afterTimeout);
      await expect(client.request('drop', options)).rejects.toBeInstanceOf(
        RealtimeRequestDisconnectedError,
      );
      await expect(client.request('echo', 3, options)).rejects.toBeInstanceOf(
        RealtimeRequestDisconnectedError,
      );
      restore();
      client.disconnect();
      await ready();
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
      expect(await client.request('echo', 4, options)).toBe(4);
      const byId = Map.groupBy(phases, (phase) => phase.requestId);
      expect(byId.size).toBe(6);
      for (const entries of byId.values()) {
        expect(
          entries.filter((entry) =>
            ['settled', 'timeout', 'disconnected'].includes(entry.phase),
          ),
        ).toHaveLength(1);
        expect(entries.at(-1)?.phase).toMatch(/^(settled|timeout|disconnected)$/);
      }
    } finally {
      restore();
      client.disconnect();
      await server.shutdown({ gracePeriodMs: 0 });
    }
  });
}
