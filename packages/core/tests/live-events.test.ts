/**
 * `defineEvents` — the declaration, its projection onto the wire, and the
 * delivery modes the declaration chooses.
 *
 * The rule this file is written against: a test that binds one declaration to
 * both ends of a socket measures the two ends' *agreement*, not the projection.
 * A wrong projection would be applied identically by both and stay green. So
 * the projection is measured by injecting a raw frame past the validating
 * wrapper — the sender is the test, not the projection under test.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { bindRealtimeClient } from '../src/browser/socket-io';
import { defineEvents, type EventPayloads, toRealtimeContract } from '../src/live';
import type { RealtimeRejectedEvent } from '../src/realtime';
import { createEventBus } from '../src/server/event-bus';

const events = defineEvents(
  { prefix: 'notes' },
  {
    changed: {
      schema: z.object({ folder: z.string(), revision: z.number() }),
      mode: 'emit',
    },
    reindexed: {
      schema: z.object({ files: z.number() }),
      mode: 'serial',
      listenerTimeoutMs: 50,
    },
    archiving: {
      schema: z.object({ folder: z.string() }),
      mode: 'decision',
      whenAllDefer: 'allow',
      listenerTimeoutMs: 50,
    },
  },
);

type Payloads = EventPayloads<typeof events>;

function bus(onListenerError?: (error: unknown, event: string) => void) {
  return createEventBus<Payloads>({
    topics: events.topics,
    ...(onListenerError && { onListenerError }),
  });
}

describe('the declaration refuses what it could not deliver', () => {
  test('a decision topic without whenAllDefer is refused, naming the topic', () => {
    expect(() =>
      defineEvents(
        {},
        {
          closing: { schema: z.object({}), mode: 'decision', listenerTimeoutMs: 10 },
        },
      ),
    ).toThrow(/topic "closing" has mode 'decision'.*whenAllDefer/s);
  });

  test('a mode that waits must declare how long it waits', () => {
    for (const mode of ['serial', 'decision'] as const) {
      expect(() =>
        defineEvents({}, { t: { schema: z.object({}), mode, whenAllDefer: 'allow' } }),
      ).toThrow(/must declare listenerTimeoutMs/);
    }
  });

  test('an emit topic may not declare options only a waiting mode reads', () => {
    // The failure this refuses is not a typo — it is an option that would be
    // accepted, typechecked, and then read by nothing.
    expect(() =>
      defineEvents({}, { t: { schema: z.object({}), mode: 'emit', whenAllDefer: 'allow' } }),
    ).toThrow(/declares whenAllDefer.*mode is 'emit'/s);
    expect(() =>
      defineEvents({}, { t: { schema: z.object({}), mode: 'emit', listenerTimeoutMs: 10 } }),
    ).toThrow(/mode 'emit' never waits/);
  });

  test('a topic name with whitespace, or none at all, is refused', () => {
    expect(() => defineEvents({}, { 'a b': { schema: z.object({}), mode: 'emit' } })).toThrow(
      /cannot contain whitespace/,
    );
    expect(() => defineEvents({}, { '': { schema: z.object({}), mode: 'emit' } })).toThrow(
      /cannot be empty/,
    );
  });
});

describe('a topic has exactly one name', () => {
  test('the declared keys are the prefixed wire names, and the short key is not one', () => {
    expect(Object.keys(events.topics).sort()).toEqual([
      'notes.archiving',
      'notes.changed',
      'notes.reindexed',
    ]);
    expect(Object.keys(events.topics)).not.toContain('changed');
  });

  test('without a prefix the name is the key itself', () => {
    const bare = defineEvents({}, { ping: { schema: z.object({}), mode: 'emit' } });
    expect(Object.keys(bare.topics)).toEqual(['ping']);
  });
});

describe('the projection onto the realtime contract', () => {
  test('announcements travel one way, keyed by wire topic', () => {
    const contract = toRealtimeContract(events);
    expect(Object.keys(contract.serverToClient).sort()).toEqual([
      'notes.archiving',
      'notes.changed',
      'notes.reindexed',
    ]);
    // A client that could publish a server's topic would make the declared
    // publisher a suggestion.
    expect(contract.clientToServer).toEqual({});
  });

  test('a frame injected past the validating wrapper is refused and names the field', async () => {
    // Measured from outside the projection: the bad frame is written here, by
    // hand, exactly as a peer on another version would put it on the wire. A
    // test that emitted it *through* the same projection would prove only that
    // the projection agrees with itself.
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const rejected: RealtimeRejectedEvent[] = [];
    const transport = {
      connected: true,
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      emit: () => true,
      emitWithAck: async () => undefined,
      onConnectionChange: () => () => undefined,
    };
    const client = bindRealtimeClient(toRealtimeContract(events), transport, {
      onRejected: (event) => {
        rejected.push(event);
      },
    });

    const delivered: unknown[] = [];
    client.on('notes.changed', (payload: unknown) => {
      delivered.push(payload);
    });

    const inbound = handlers.get('notes.changed');
    expect(inbound).toBeDefined();
    // `revision` is declared a number. A peer sending a string is the whole
    // class of drift this declaration exists to make impossible.
    inbound?.({ folder: 'inbox', revision: 'seven' });

    expect(delivered).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBe('invalid-arguments');
    const issues = z
      .object({ issues: z.array(z.object({ path: z.string() })) })
      .parse(rejected[0]?.error.details).issues;
    // The path is `0.revision`, not `revision`: a realtime event's arguments are
    // a tuple, and one payload sits at index 0 of it. Asserted rather than
    // trimmed, because trimming it here would be a second name for the path.
    expect(issues[0]?.path).toBe('0.revision');
  });

  test('a frame that satisfies the declaration is delivered unchanged', async () => {
    // The negative control for the test above: the same door, a good frame. A
    // validator that refused everything would pass that test and fail this one.
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const transport = {
      connected: true,
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      },
      emit: () => true,
      emitWithAck: async () => undefined,
      onConnectionChange: () => () => undefined,
    };
    const client = bindRealtimeClient(toRealtimeContract(events), transport);
    const delivered: unknown[] = [];
    client.on('notes.changed', (payload: unknown) => {
      delivered.push(payload);
    });
    handlers.get('notes.changed')?.({ folder: 'inbox', revision: 7 });
    expect(delivered).toEqual([{ folder: 'inbox', revision: 7 }]);
  });
});

describe('the bus is closed by the declaration', () => {
  test('an undeclared topic is refused rather than delivered to nobody', () => {
    const b = bus();
    // @ts-expect-error — an undeclared topic is not in the payload map either
    expect(() => b.emit('notes.nope', {})).toThrow(/is not a declared topic/);
  });

  test('a topic is delivered by the verb its declaration chose, and no other', () => {
    const b = bus();
    expect(() => b.emit('notes.archiving', { folder: 'a' })).toThrow(
      /declared with mode 'decision'.*decide\(\)/s,
    );
    expect(b.decide('notes.changed', { folder: 'a', revision: 1 })).rejects.toThrow(
      /declared with mode 'emit'.*emit\(\)/s,
    );
  });

  test('without declared topics the waiting verbs refuse rather than guess', async () => {
    const open = createEventBus<{ x: number }>();
    expect(open.decide('x', 1)).rejects.toThrow(/needs declared topics/);
    expect(open.emitSerial('x', 1)).rejects.toThrow(/needs declared topics/);
    // `emit` keeps working on an open bus — this addition takes nothing away.
    expect(() => open.emit('x', 1)).not.toThrow();
  });
});

describe('emit: announce and continue', () => {
  test('a listener that throws is isolated, reported, and does not stop the others', () => {
    const seen: string[] = [];
    const errors: string[] = [];
    const b = bus((error) => errors.push(String(error)));
    b.on('notes.changed', () => {
      throw new Error('first blew up');
    });
    b.on('notes.changed', () => {
      seen.push('second');
    });
    b.emit('notes.changed', { folder: 'a', revision: 1 });
    expect(seen).toEqual(['second']);
    expect(errors[0]).toContain('first blew up');
  });
});

describe('serial: in order, and waited for', () => {
  test('listeners run one at a time in registration order', async () => {
    const order: string[] = [];
    const b = bus();
    b.on('notes.reindexed', async () => {
      await Bun.sleep(5);
      order.push('first');
    });
    b.on('notes.reindexed', () => {
      order.push('second');
    });
    await b.emitSerial('notes.reindexed', { files: 2 });
    expect(order).toEqual(['first', 'second']);
  });

  test('a listener that never settles is reported at its deadline and the next still runs', async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const b = bus((error) => errors.push(String(error)));
    b.on('notes.reindexed', () => new Promise<void>(() => undefined));
    b.on('notes.reindexed', () => {
      order.push('second');
    });
    await b.emitSerial('notes.reindexed', { files: 1 });
    expect(order).toEqual(['second']);
    expect(errors[0]).toContain('did not settle within 50ms');
  });
});

describe('decision: a vote that never arrived is not consent', () => {
  test('the first deny wins and the listeners after it are not consulted', async () => {
    const consulted: string[] = [];
    const b = bus();
    b.on('notes.archiving', () => {
      consulted.push('first');
      return { outcome: 'deny', reason: 'a run is still open' } as const;
    });
    b.on('notes.archiving', () => {
      consulted.push('second');
      return { outcome: 'allow' } as const;
    });
    const decision = await b.decide('notes.archiving', { folder: 'a' });
    expect(decision).toEqual({ outcome: 'deny', reason: 'a run is still open' });
    expect(consulted).toEqual(['first']);
  });

  test.each([
    ['returns nothing at all', () => undefined, /returned no decision/],
    [
      'returns something that is not a decision',
      () => ({ outcome: 'maybe' }),
      /returned no decision/,
    ],
    [
      'throws',
      () => {
        throw new Error('database is down');
      },
      /listener threw: database is down/,
    ],
    ['never settles', () => new Promise(() => undefined), /did not vote within 50ms/],
  ])('a listener that %s denies', async (_name, listener, reason) => {
    const b = bus();
    b.on('notes.archiving', listener);
    const decision = await b.decide('notes.archiving', { folder: 'a' });
    expect(decision.outcome).toBe('deny');
    expect(decision.outcome === 'deny' && decision.reason).toMatch(reason);
  });

  test('when every listener defers, the declared outcome decides', async () => {
    const b = bus();
    b.on('notes.archiving', () => ({ outcome: 'defer' }) as const);
    b.on('notes.archiving', () => ({ outcome: 'defer' }) as const);
    // The declaration says `whenAllDefer: 'allow'`.
    expect(await b.decide('notes.archiving', { folder: 'a' })).toEqual({
      outcome: 'allow',
    });

    const denying = defineEvents(
      {},
      {
        closing: {
          schema: z.object({}),
          mode: 'decision',
          whenAllDefer: 'deny',
          listenerTimeoutMs: 50,
        },
      },
    );
    const strict = createEventBus<{ closing: Record<string, never> }>({
      topics: denying.topics,
    });
    strict.on('closing', () => ({ outcome: 'defer' }) as const);
    expect(await strict.decide('closing', {})).toEqual({
      outcome: 'deny',
      reason: 'no listener claimed this event',
    });
  });

  test('no listeners at all is the same case as everybody deferring', async () => {
    const b = bus();
    expect(await b.decide('notes.archiving', { folder: 'a' })).toEqual({
      outcome: 'allow',
    });
  });

  test('one explicit allow beside a defer settles it as allow', async () => {
    // `defer` means "not my call" — beside a listener that did claim it, a defer
    // has not disagreed. Without this the declared undecided outcome would
    // override a real vote.
    const denying = defineEvents(
      {},
      {
        closing: {
          schema: z.object({}),
          mode: 'decision',
          whenAllDefer: 'deny',
          listenerTimeoutMs: 50,
        },
      },
    );
    const b = createEventBus<{ closing: Record<string, never> }>({ topics: denying.topics });
    b.on('closing', () => ({ outcome: 'defer' }) as const);
    b.on('closing', () => ({ outcome: 'allow' }) as const);
    expect(await b.decide('closing', {})).toEqual({ outcome: 'allow' });
  });

  test('a listener that unsubscribed during the vote does not get to vote', async () => {
    const consulted: string[] = [];
    const b = bus();
    let dropSecond: () => void = () => undefined;
    b.on('notes.archiving', () => {
      consulted.push('first');
      dropSecond();
      return { outcome: 'defer' } as const;
    });
    dropSecond = b.on('notes.archiving', () => {
      consulted.push('second');
      return { outcome: 'deny', reason: 'should never be counted' } as const;
    });
    const decision = await b.decide('notes.archiving', { folder: 'a' });
    expect(consulted).toEqual(['first']);
    expect(decision).toEqual({ outcome: 'allow' });
  });
});
