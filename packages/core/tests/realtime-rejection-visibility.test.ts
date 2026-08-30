import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createRealtimeClient, createSocketIOClient } from '../src/browser/socket-io';
import { AppError } from '../src/contract/errors';
import {
  defineRealtimeContract,
  type RealtimeRejectedEventHook,
  RealtimeRequestRejectedError,
} from '../src/realtime';
import {
  asRealtimeRejection,
  MAX_REJECTION_ISSUES,
  REALTIME_REJECTION_KEY,
} from '../src/realtime/rejected-frame';
import { parseRealtimeRequestArguments } from '../src/realtime/socket';
import { createServer } from '../src/server/bun';
import { bindRealtimeServer } from '../src/server/realtime';
import { createSocketIOServer } from '../src/server/socket-io';
import {
  createRealtimeProbeDriver,
  defineRealtimeProbe,
  runSurfaceProbes,
} from '../src/testing';

/**
 * Two peers that disagree about the contract — the shape a protocol generation
 * is supposed to catch.
 *
 * The server's copy demands `v: 2`. The client sends `v: 1`, exactly as a
 * half-rolled-out deployment would. Before this, the frame was dropped where it
 * landed: the server reported `onRejected` and the CLIENT learned nothing at
 * all, waiting out its deadline and reporting a timeout. Healthy machines,
 * unexplained timeouts, symmetrically, on every plane at once — a shape that
 * reads as a network fault, which is why one consumer abandoned the convention
 * after living through three of them.
 */

const SERVER_GENERATION = 2;

const serverContract = defineRealtimeContract({
  serverToClient: {},
  clientToServer: {
    replicate: {
      args: z.tuple([z.object({ v: z.literal(SERVER_GENERATION), id: z.string() })]),
      ack: z.object({ stored: z.boolean() }),
    },
    // The receiver's copy of this event has NO acknowledgement — the older half
    // of a sender-first rollout, where a newer peer has already added one.
    announce: { args: z.tuple([z.object({ id: z.string() })]) },
    // Many issues from one frame: the size of a refusal is chosen by whoever
    // sent the bad frame, which is why the cap has to be on the sending side.
    bulk: {
      args: z.tuple([z.array(z.object({ n: z.number() }))]),
      ack: z.object({ stored: z.boolean() }),
    },
  },
});

/** The older peer: same event, same ack, one generation behind. */
function clientContractAtGeneration(generation: number) {
  return defineRealtimeContract({
    serverToClient: {},
    clientToServer: {
      replicate: {
        args: z.tuple([z.object({ v: z.literal(generation), id: z.string() })]),
        ack: z.object({ stored: z.boolean() }),
      },
    },
  });
}

let url = '';
let stop: () => Promise<unknown>;
let replicateHandlerCalls = 0;

beforeAll(async () => {
  const handle = await createSocketIOServer({ cors: { origin: '*' } });
  const realtime = bindRealtimeServer(serverContract, handle, {
    // Silences the default console warning; the assertions are on the client.
    onRejected: () => undefined,
  });
  realtime.onConnection(({ events }) => {
    events.on('replicate', (payload, acknowledge) => {
      replicateHandlerCalls += 1;
      acknowledge({ stored: payload.id.length > 0 });
    });
    events.on('announce', () => undefined);
    events.on('bulk', (rows, acknowledge) => {
      acknowledge({ stored: rows.length > 0 });
    });
  });
  const server = createServer({ port: 0, socket: handle });
  url = `http://localhost:${server.port}`;
  stop = () => server.shutdown({ gracePeriodMs: 0 });
});

afterAll(() => stop());

async function connect(
  generation: number,
  onRejected: RealtimeRejectedEventHook = () => undefined,
) {
  const client = createRealtimeClient(clientContractAtGeneration(generation), {
    url,
    transports: ['websocket'],
    onRejected,
  });
  const live = new Promise<void>((resolve, reject) => {
    const off = client.onConnectionChange((connected) => {
      if (!connected) return;
      off();
      resolve();
    });
    setTimeout(() => reject(new Error('client never connected')), 5_000);
  });
  client.connect();
  await live;
  return client;
}

describe('a schema rejection is visible to the sender', () => {
  test('retains exact local outcomes for unknown events and missing acknowledgements', () => {
    const registry = defineRealtimeContract({
      serverToClient: {},
      clientToServer: {
        notice: { args: z.tuple([z.string()]) },
      },
    }).clientToServer;
    const outcomes = [
      () => parseRealtimeRequestArguments(registry, 'missing', 'client-outbound', []),
      () => parseRealtimeRequestArguments(registry, 'notice', 'client-outbound', ['ready']),
    ];

    for (const [index, invoke] of outcomes.entries()) {
      let failure: unknown;
      try {
        invoke?.();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AppError);
      if (!(failure instanceof AppError)) throw new Error(`Missing rejection ${index}`);
      expect(failure.details).toMatchObject(
        index === 0
          ? {
              event: 'missing',
              direction: 'client-outbound',
              phase: 'arguments',
              reason: 'unknown-event',
              fault: 'local',
            }
          : {
              event: 'notice',
              direction: 'client-outbound',
              phase: 'acknowledgement',
              reason: 'missing-acknowledgement',
              fault: 'local',
            },
      );
    }
  });

  test('an in-generation request still gets its acknowledgement', async () => {
    // The control. Without it, an implementation that answered EVERY frame with
    // a refusal would pass every assertion below.
    const client = await connect(SERVER_GENERATION);
    try {
      const ack = await client.request('replicate', { v: 2, id: 'one' }, { timeoutMs: 5_000 });
      expect(ack).toEqual({ stored: true });
    } finally {
      client.disconnect();
    }
  });

  test('an out-of-generation request is refused, not timed out', async () => {
    const client = await connect(1);
    try {
      const failure = await client
        .request('replicate', { v: 1, id: 'one' }, { timeoutMs: 5_000 })
        .then(
          () => null,
          (error: unknown) => error,
        );

      expect(failure).toBeInstanceOf(RealtimeRequestRejectedError);
      const rejection = failure instanceof RealtimeRequestRejectedError ? failure : null;
      expect(rejection?.reason).toBe('invalid-arguments');
      expect(rejection?.event).toBe('replicate');
      // The peer's own issues travel with it, already flattened by Stitchkit's
      // normaliser: `path: "0.v"` says "the first payload's generation field"
      // outright. That is what replaces the documented recipe of inspecting a
      // `ZodError`'s internals — three conditions about somebody else's object
      // shape, for a fact that is binary.
      expect(rejection?.issues).toEqual([
        { path: '0.v', code: 'invalid_value', message: 'Invalid input: expected 2' },
      ]);
    } finally {
      client.disconnect();
    }
  });

  test('a real peer refusal is normalized by the realtime conformance driver', async () => {
    let observeRejection: RealtimeRejectedEventHook = () => undefined;
    const client = await connect(1, (event) => observeRejection(event));
    const driver = createRealtimeProbeDriver<string>({
      bind: (onRejected) => {
        observeRejection = onRejected;
        return {
          connected: () => client.connected,
          invoke: () =>
            client.request('replicate', { v: 1, id: 'probe' }, { timeoutMs: 5_000 }),
          dispose: () => client.disconnect(),
        };
      },
      handlerCalls: () => replicateHandlerCalls,
    });

    await runSurfaceProbes({
      probes: [
        defineRealtimeProbe({
          name: 'real peer refusal',
          scenario: 'peer_rejection',
          fixture: 'generation-skew',
          expected: {
            outcome: 'realtime_rejected',
            code: 'REALTIME_CONTRACT_VIOLATION',
            rejection: {
              direction: 'client-inbound',
              phase: 'arguments',
              reason: 'rejected-by-peer',
              fault: 'local',
            },
            handlerCalls: 0,
          },
        }),
      ],
      drivers: { REALTIME: driver },
    });
  });

  test('the refusal arrives well inside a deadline it would otherwise have consumed', async () => {
    // The measurable half of the claim. A refusal that merely arrives is not
    // the fix: what makes a version skew diagnosable is that it arrives at once
    // instead of at the deadline.
    const client = await connect(1);
    try {
      const started = performance.now();
      await client
        .request('replicate', { v: 1, id: 'one' }, { timeoutMs: 5_000 })
        .catch(() => undefined);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      client.disconnect();
    }
  });

  /** A contract-blind client, so the raw acknowledgement value can be seen. */
  async function rawClient() {
    const client = createSocketIOClient({ url, transports: ['websocket'] });
    const live = new Promise<void>((resolve, reject) => {
      const off = client.onConnectionChange((connected) => {
        if (!connected) return;
        off();
        resolve();
      });
      setTimeout(() => reject(new Error('raw client never connected')), 5_000);
    });
    client.connect();
    await live;
    return client;
  }

  test('what an older peer actually receives, observed on the wire', async () => {
    // The previous version of this asserted `z.object(...).safeParse(envelope)`
    // against an envelope built by hand — a fact about Zod that would have
    // passed with the whole feature deleted. This reads the value the SERVER
    // really sent, through a contract-blind client, and then asks the two
    // questions that matter about it.
    const client = await rawClient();
    try {
      const raw = await client.emitWithAck('replicate', [{ v: 1, id: 'one' }], {
        timeoutMs: 5_000,
      });

      // An older peer parses this with its own `ack` schema. A contract-first
      // acknowledgement rejects it, so that peer raises an invalid-acknowledgement
      // error at once instead of waiting out its deadline.
      expect(z.object({ stored: z.boolean() }).safeParse(raw).success).toBe(false);
      // A current peer recognises it before any schema is consulted.
      expect(asRealtimeRejection(raw)?.event).toBe('replicate');
    } finally {
      client.disconnect();
    }
  });

  test('a permissive acknowledgement schema WOULD swallow a refusal — the documented hazard', async () => {
    // The honest other half, and the one pairing where this change is a step
    // sideways: an older peer whose acknowledgement validates nothing reads the
    // refusal as a value, where it previously read a timeout. It needs an old
    // peer AND a schema that checks nothing — the opposite of what a
    // contract-first acknowledgement is for — but it is real, so it is named
    // here and in ADR 0106 rather than left to be discovered.
    const client = await rawClient();
    try {
      const raw = await client.emitWithAck('replicate', [{ v: 1, id: 'one' }], {
        timeoutMs: 5_000,
      });
      expect(z.unknown().safeParse(raw).success).toBe(true);
    } finally {
      client.disconnect();
    }
  });

  test('a sender-first rollout is answered, not timed out', async () => {
    // The third skew, and the most ordinary one: the sender's contract has
    // gained an acknowledgement and the receiver's copy has not. The callback is
    // physically on the wire; reading it only through the RECEIVER's definition
    // meant the refusal had nowhere to go, and the sender waited out its
    // deadline — the exact failure this mechanism exists to remove, arriving
    // through the exact door it was built for.
    const newerSender = defineRealtimeContract({
      serverToClient: {},
      clientToServer: {
        announce: {
          args: z.tuple([z.object({ id: z.string() })]),
          ack: z.object({ seen: z.boolean() }),
        },
      },
    });
    const client = createRealtimeClient(newerSender, {
      url,
      transports: ['websocket'],
      onRejected: () => undefined,
    });
    const live = new Promise<void>((resolve, reject) => {
      const off = client.onConnectionChange((connected) => {
        if (!connected) return;
        off();
        resolve();
      });
      setTimeout(() => reject(new Error('newer sender never connected')), 5_000);
    });
    client.connect();
    await live;
    try {
      const started = performance.now();
      const failure = await client
        .request('announce', { id: 'one' }, { timeoutMs: 5_000 })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(RealtimeRequestRejectedError);
      expect(performance.now() - started).toBeLessThan(2_000);
    } finally {
      client.disconnect();
    }
  });

  test('a refusal is capped where it is built, not only where it is read', async () => {
    // The size of a refusal is chosen by whoever sent the bad frame. The cap
    // existed only in the reader, so fifty malformed rows produced fifty issues
    // on the wire — an amplification with the peer holding the dial.
    const client = await rawClient();
    try {
      const rows = Array.from({ length: 50 }, () => ({ n: 'not a number' }));
      const raw = await client.emitWithAck('bulk', [rows], { timeoutMs: 5_000 });
      expect(asRealtimeRejection(raw)).not.toBeNull();

      // Read off the WIRE, not through the recogniser. The reader caps too, so
      // asking the parsed value how many issues it has answers twenty whether
      // or not the sender ever bounded what it sent — which is precisely how
      // this defect stayed invisible.
      const envelope = typeof raw === 'object' && raw !== null ? raw : {};
      const report = Reflect.get(envelope, REALTIME_REJECTION_KEY);
      const issues =
        typeof report === 'object' && report !== null
          ? Reflect.get(report, 'issues')
          : undefined;
      expect(Array.isArray(issues)).toBe(true);
      expect(Array.isArray(issues) ? issues.length : -1).toBe(MAX_REJECTION_ISSUES);
    } finally {
      client.disconnect();
    }
  });

  test('a reason this version has never heard of is still a refusal', () => {
    // A versioning mechanism that cannot version itself forward is a trap: a
    // closed union would fail recognition on a later peer's new reason, fall
    // through to the application's acknowledgement schema, and surface as "the
    // peer answered with something invalid" — the precise mischaracterisation
    // this envelope exists to prevent.
    const future = asRealtimeRejection({
      [REALTIME_REJECTION_KEY]: {
        event: 'replicate',
        reason: 'a-reason-from-a-later-release',
        message: 'refused',
      },
    });
    expect(future?.reason).toBe('a-reason-from-a-later-release');
    // An empty reason is not a reason.
    expect(
      asRealtimeRejection({
        [REALTIME_REJECTION_KEY]: { event: 'x', reason: '', message: 'm' },
      }),
    ).toBeNull();
  });

  test('a valid acknowledgement that merely looks like one is not mistaken for a refusal', () => {
    // The envelope travels on the application's own acknowledgement channel, so
    // "is this a refusal" must be answerable without ambiguity.
    expect(asRealtimeRejection({ stored: true })).toBeNull();
    expect(asRealtimeRejection({ [REALTIME_REJECTION_KEY]: 'not a report' })).toBeNull();
    expect(asRealtimeRejection({ [REALTIME_REJECTION_KEY]: { event: 'x' } })).toBeNull();
    // A made-up reason IS accepted now, deliberately — see "a reason this
    // version has never heard of". What must never be accepted is a payload
    // that is not a report at all.
    expect(
      asRealtimeRejection({
        [REALTIME_REJECTION_KEY]: { event: 'x', reason: 42, message: 'm' },
      }),
    ).toBeNull();
    expect(
      asRealtimeRejection({
        [REALTIME_REJECTION_KEY]: { event: 'x', reason: 'invalid-arguments', message: 'm' },
      }),
    ).toEqual({ event: 'x', reason: 'invalid-arguments', message: 'm' });
  });
});
