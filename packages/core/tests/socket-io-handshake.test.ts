import { afterAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createSocketIOClient } from '../src/browser/socket-io';
import { defineRealtimeContract } from '../src/realtime';
import { createServer } from '../src/server/bun';
import { bindRealtimeServer } from '../src/server/realtime';
import { createSocketIOServer } from '../src/server/socket-io';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface NodeIdentity {
  nodeId: string;
  role: 'edge' | 'hub';
}

interface HsServerEvents {
  whoami: (identity: NodeIdentity) => void;
}
interface HsClientEvents {
  who: () => void;
}

const contract = defineRealtimeContract({
  serverToClient: {
    tick: { args: z.tuple([z.object({ n: z.number() })]) },
  },
  clientToServer: {},
});

const sock = await createSocketIOServer({
  cors: { origin: '*' },
  handshake: {
    schema: z.object({ token: z.string(), node: z.string() }),
    verify: async (parsed) => {
      await Bun.sleep(5);
      if (parsed.token === 'boom') throw new Error('verifier exploded');
      if (parsed.token === 'null') return null;
      if (parsed.token !== 'good') return null;
      const identity: NodeIdentity = { nodeId: parsed.node, role: 'edge' };
      return identity;
    },
  },
});
// The realtime lane — the exact consumer request: typed identity at onConnection.
const realtime = bindRealtimeServer(contract, sock);
const seenIdentities: NodeIdentity[] = [];
realtime.onConnection(({ raw }) => {
  // Compile-time pin: raw.data is exactly NodeIdentity, not any/unknown.
  const pinned: Equal<typeof raw.data, NodeIdentity> = true;
  void pinned;
  seenIdentities.push(raw.data);
});
// An app middleware registered AFTER the gate sees the typed identity in place.
const appMiddlewareSaw: unknown[] = [];
sock.io.use((socket, next) => {
  appMiddlewareSaw.push(socket.data);
  next();
});

const rejections: Array<{ direction: string; reason: string }> = [];
bindRealtimeServer(contract, sock, {
  onRejected: (event) => {
    rejections.push({ direction: event.direction, reason: event.reason });
  },
});

const server = createServer({ port: 0, socket: sock });
const URL = `http://localhost:${server.port}`;

type ConnectError = { message: string; data?: unknown; terminal: boolean };

function makeClient(
  auth: Record<string, unknown> | (() => Record<string, unknown>),
  onConnectError?: (error: ConnectError) => void,
) {
  return createSocketIOClient<HsServerEvents, HsClientEvents>({
    url: URL,
    transports: ['websocket'],
    auth,
    onConnectError,
  });
}

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

describe('Socket.IO typed handshake gate', () => {
  afterAll(() => server.shutdown({ gracePeriodMs: 0 }));

  test('a valid handshake delivers the typed identity to onConnection and app middleware', async () => {
    const client = makeClient({ token: 'good', node: 'n-1' });
    client.connect();
    await whenConnected(client);
    client.disconnect();

    expect(seenIdentities.at(-1)).toEqual({ nodeId: 'n-1', role: 'edge' });
    expect(appMiddlewareSaw.at(-1)).toEqual({ nodeId: 'n-1', role: 'edge' });
  });

  test('a schema-invalid handshake is rejected terminally with a deterministic code', async () => {
    const errors: ConnectError[] = [];
    const client = makeClient({ wrong: true }, (error) => errors.push(error));
    client.connect();
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (errors.length > 0) {
          clearInterval(probe);
          resolve();
        }
      }, 10);
    });

    expect(errors[0]?.message).toBe('handshake auth failed validation');
    expect(errors[0]?.data).toEqual({ code: 'handshake_rejected' });
    expect(errors[0]?.terminal).toBe(true);
    expect(client.connected).toBe(false);
  });

  test('a throwing async verify rejects generically — raw error text never reaches the peer', async () => {
    const errors: ConnectError[] = [];
    const client = makeClient({ token: 'boom', node: 'n-2' }, (error) => errors.push(error));
    client.connect();
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (errors.length > 0) {
          clearInterval(probe);
          resolve();
        }
      }, 10);
    });

    expect(errors[0]?.message).toBe('handshake rejected');
    expect(errors[0]?.message).not.toContain('verifier exploded');
    expect(errors[0]?.terminal).toBe(true);
  });

  test('verify returning null rejects', async () => {
    const errors: ConnectError[] = [];
    const client = makeClient({ token: 'null', node: 'n-3' }, (error) => errors.push(error));
    client.connect();
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (errors.length > 0) {
          clearInterval(probe);
          resolve();
        }
      }, 10);
    });

    expect(errors[0]?.message).toBe('handshake rejected');
  });

  test('recovery: rejected handshake → rotate token → connect() re-reads auth and succeeds', async () => {
    let token = 'null';
    const errors: ConnectError[] = [];
    const client = makeClient(
      () => ({ token, node: 'n-4' }),
      (error) => errors.push(error),
    );

    client.connect();
    await new Promise<void>((resolve) => {
      const probe = setInterval(() => {
        if (errors.length > 0) {
          clearInterval(probe);
          resolve();
        }
      }, 10);
    });
    expect(errors[0]?.terminal).toBe(true);
    expect(client.connected).toBe(false);

    // The terminal error reset the connection intent — a plain connect() works
    // again and the function-form auth is re-read with the rotated token.
    token = 'good';
    client.connect();
    await whenConnected(client);
    expect(client.connected).toBe(true);
    expect(seenIdentities.at(-1)).toEqual({ nodeId: 'n-4', role: 'edge' });
    client.disconnect();
  });

  test('handshake rejection never reaches the realtime onRejected hook', () => {
    // Every rejected handshake above happened before any connection existed —
    // the event-validation layer is unreachable by construction.
    expect(rejections).toEqual([]);
  });

  test('without verify, the schema output itself is the typed identity', async () => {
    const plain = await createSocketIOServer({
      cors: { origin: '*' },
      handshake: { schema: z.object({ team: z.string() }) },
    });
    const seen: Array<{ team: string }> = [];
    plain.io.on('connection', (socket) => {
      const pinned: Equal<typeof socket.data, { team: string }> = true;
      void pinned;
      seen.push(socket.data);
    });
    const plainServer = createServer({ port: 0, socket: plain });
    const client = createSocketIOClient<HsServerEvents, HsClientEvents>({
      url: `http://localhost:${plainServer.port}`,
      transports: ['websocket'],
      auth: { team: 'wire' },
    });
    client.connect();
    await whenConnected(client);
    client.disconnect();
    await plainServer.shutdown({ gracePeriodMs: 0 });

    expect(seen.at(-1)).toEqual({ team: 'wire' });
  });
});
