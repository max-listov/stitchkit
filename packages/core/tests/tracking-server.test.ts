import { describe, expect, test } from 'bun:test';
import { activeIntervalOf } from '../src/tracking/server/active-interval';
import { isBotUserAgent } from '../src/tracking/server/bot';
import { dispositionTrackingBatch } from '../src/tracking/server/disposition';
import { hashTrackingEvent } from '../src/tracking/server/hash';
import { createPresenceRegistry } from '../src/tracking/server/presence';
import {
  type ActiveVisit,
  issueVisitLease,
  type TrackingVisitStore,
} from '../src/tracking/server/visit-lease';

const LINEAGE = '11111111-1111-4111-8111-111111111111';
const VISIT = '22222222-2222-4222-8222-222222222222';
const OTHER_VISIT = '33333333-3333-4333-8333-333333333333';

const event = (n: number, visitId = VISIT, browserStreamId = LINEAGE) => ({
  eventId: `e${n}`,
  visitId,
  browserStreamId,
  type: 'CLICK',
  page: '/',
  clientTimestamp: n,
});

describe('bot', () => {
  test('crawlers, monitors and a headless agent browser are bots', () => {
    expect(isBotUserAgent('Mozilla/5.0 (compatible; Googlebot/2.1)')).toBe(true);
    expect(isBotUserAgent('HeadlessChrome/120')).toBe(true);
    expect(isBotUserAgent('Mozilla/5.0 (Macintosh) Safari/605')).toBe(false);
    expect(isBotUserAgent(undefined)).toBe(false);
    expect(isBotUserAgent('Safari', /safari/i)).toBe(true);
  });
});

describe('hash', () => {
  test('is sha256 of JSON.stringify of the parsed value, key order kept', () => {
    const a = { x: 1, y: 2 };
    expect(hashTrackingEvent(a)).toBe(
      new Bun.CryptoHasher('sha256').update(JSON.stringify(a)).digest('hex'),
    );
    expect(hashTrackingEvent({ y: 2, x: 1 })).not.toBe(hashTrackingEvent(a));
  });
});

describe('disposition', () => {
  const visits = [
    { id: VISIT, browserStreamId: LINEAGE, ownerId: null },
    { id: OTHER_VISIT, browserStreamId: LINEAGE, ownerId: 'user-1' },
  ];

  test('a bot batch is excluded in full and writes nothing', () => {
    const result = dispositionTrackingBatch({
      events: [event(1), event(2)],
      visits,
      existing: new Map(),
      actorOwnerId: null,
      userAgent: 'Googlebot',
    });
    expect(result.accepted).toEqual([]);
    expect(result.dispositions.map((d) => d.status)).toEqual(['excluded-bot', 'excluded-bot']);
  });

  test('a visit the browser does not own is identity-invalid', () => {
    const result = dispositionTrackingBatch({
      events: [
        event(1, '44444444-4444-4444-8444-444444444444'), // unknown visit
        event(2, VISIT, '55555555-5555-4555-8555-555555555555'), // other lineage
        event(3, OTHER_VISIT), // owned by user-1, caller anonymous
        event(4, OTHER_VISIT), // same, decided per event
      ],
      visits,
      existing: new Map(),
      actorOwnerId: null,
    });
    expect(result.dispositions.map((d) => d.status)).toEqual(
      Array(4).fill('identity-invalid'),
    );
    // The owner may write to their own visit.
    expect(
      dispositionTrackingBatch({
        events: [event(5, OTHER_VISIT)],
        visits,
        existing: new Map(),
        actorOwnerId: 'user-1',
      }).dispositions[0]?.status,
    ).toBe('accepted');
  });

  test('a stored id is a duplicate; a changed payload is also a conflict', () => {
    const stored = event(1);
    const result = dispositionTrackingBatch({
      events: [stored, { ...event(2), page: '/changed' }],
      visits,
      existing: new Map([
        ['e1', hashTrackingEvent(stored)],
        ['e2', hashTrackingEvent(event(2))],
      ]),
      actorOwnerId: null,
    });
    expect(result.dispositions.map((d) => d.status)).toEqual(['duplicate', 'duplicate']);
    expect(result.conflicts).toEqual(['e2']);
    expect(result.accepted).toEqual([]);
  });

  test('the same id twice in one batch is accepted once and a duplicate after', () => {
    const first = event(1);
    const result = dispositionTrackingBatch({
      events: [first, first, { ...first, page: '/changed' }],
      visits,
      existing: new Map(),
      actorOwnerId: null,
    });
    expect(result.dispositions.map((d) => d.status)).toEqual([
      'accepted',
      'duplicate',
      'duplicate',
    ]);
    expect(result.accepted).toHaveLength(1);
    expect(result.conflicts).toEqual(['e1']);
  });

  test('an anonymous visit accepts anyone holding the lineage and is adoptable by an identified caller', () => {
    const anonymous = dispositionTrackingBatch({
      events: [event(1)],
      visits,
      existing: new Map(),
      actorOwnerId: null,
    });
    expect(anonymous.dispositions[0]?.status).toBe('accepted');
    expect(anonymous.adoptable).toEqual([]);
    const identified = dispositionTrackingBatch({
      events: [event(1), event(2)],
      visits,
      existing: new Map(),
      actorOwnerId: 'user-9',
    });
    expect(identified.accepted).toHaveLength(2);
    expect(identified.adoptable).toEqual([VISIT]);
  });
});

describe('active interval', () => {
  const now = new Date('2026-09-06T00:00:10.000Z');
  const id = '66666666-6666-4666-8666-666666666666';

  test('is dated from the server clock and the reported duration', () => {
    const interval = activeIntervalOf(
      {
        type: 'PAGE_LEAVE',
        page: '/x',
        metadata: { activeIntervalId: id, activeDurationMs: 2_500.4, intervalStartedAt: 1 },
      },
      now,
    );
    expect(interval).toEqual({
      intervalId: id,
      page: '/x',
      deltaMs: 2_500,
      startedAt: new Date('2026-09-06T00:00:07.500Z'),
      endedAt: now,
    });
  });

  test('refuses the wrong type, an unshaped id, a non-positive or implausible duration', () => {
    expect(
      activeIntervalOf(
        { type: 'CLICK', page: '/', metadata: { activeIntervalId: id, activeDurationMs: 5 } },
        now,
      ),
    ).toBeNull();
    expect(
      activeIntervalOf(
        {
          type: 'PAGE_LEAVE',
          page: '/',
          metadata: { activeIntervalId: 'x', activeDurationMs: 5 },
        },
        now,
      ),
    ).toBeNull();
    expect(
      activeIntervalOf(
        {
          type: 'PAGE_LEAVE',
          page: '/',
          metadata: { activeIntervalId: id, activeDurationMs: 0 },
        },
        now,
      ),
    ).toBeNull();
    expect(
      activeIntervalOf(
        {
          type: 'PAGE_LEAVE',
          page: '/',
          metadata: { activeIntervalId: id, activeDurationMs: 31 * 60 * 1000 },
        },
        now,
      ),
    ).toBeNull();
    expect(activeIntervalOf({ type: 'PAGE_LEAVE', page: '/' }, now)).toBeNull();
    // 0.4 ms rounds to a zero-length interval; a dashed non-UUID is not an id.
    expect(
      activeIntervalOf(
        {
          type: 'PAGE_LEAVE',
          page: '/',
          metadata: { activeIntervalId: id, activeDurationMs: 0.4 },
        },
        now,
      ),
    ).toBeNull();
    expect(
      activeIntervalOf(
        {
          type: 'PAGE_LEAVE',
          page: '/',
          metadata: {
            activeIntervalId: 'abcdefab-----------------------abcd',
            activeDurationMs: 5,
          },
        },
        now,
      ),
    ).toBeNull();
    expect(
      activeIntervalOf(
        { type: 'CUSTOM', page: '/', metadata: { activeIntervalId: id, activeDurationMs: 5 } },
        now,
        { types: ['CUSTOM'] },
      ),
    ).not.toBeNull();
  });
});

describe('visit lease', () => {
  const entry = {
    browserStreamId: LINEAGE,
    origin: 'https://app.example.com',
    landingPath: '/',
    displayMode: 'browser' as const,
    screenWidth: 1_000,
    screenHeight: 800,
    buildId: 'dev',
    outboxState: 'available' as const,
    outboxQueued: 0,
    outboxDropped: 0,
  };

  function fakeStore(initial: ActiveVisit[]) {
    const calls: string[] = [];
    const active = [...initial];
    let locked = 0;
    const store: TrackingVisitStore<'tx'> = {
      async withLineageLock(_lineage, fn) {
        locked += 1;
        try {
          return await fn('tx');
        } finally {
          locked -= 1;
        }
      },
      async findActive(_tx, query) {
        expect(locked).toBe(1);
        calls.push(`find:${query.previousVisitId ?? '*'}:${query.ownership}`);
        const allowed = active.filter((visit) =>
          query.ownership === 'owned'
            ? visit.ownerId === query.actorOwnerId
            : visit.ownerId === null || visit.ownerId === query.actorOwnerId,
        );
        if (query.previousVisitId)
          return allowed.find((v) => v.id === query.previousVisitId) ?? null;
        return allowed[0] ?? null;
      },
      async touch(_tx, visitId) {
        calls.push(`touch:${visitId}`);
      },
      async adopt(_tx, visit, ownerId) {
        calls.push(`adopt:${visit.id}:${ownerId}`);
        visit.ownerId = ownerId;
      },
      async endOpen() {
        calls.push('endOpen');
        active.length = 0;
      },
      async create(_tx, visit) {
        calls.push(`create:${visit.id}`);
        active.push({
          id: visit.id,
          ownerId: visit.actor.ownerId,
          startedAt: visit.startedAt,
        });
      },
    };
    return { store, calls, active };
  }
  const options = { idleMs: 1_000, now: () => new Date(5_000), randomUUID: () => 'new-visit' };

  test('the visit the browser names is continued when still active', async () => {
    const { store, calls } = fakeStore([
      { id: 'v-old', ownerId: null, startedAt: new Date(0) },
      { id: 'v-named', ownerId: null, startedAt: new Date(0) },
    ]);
    const lease = await issueVisitLease(
      store,
      { ownerId: null },
      { ...entry, previousVisitId: 'v-named' },
      { ...options, ownership: 'adopting' },
    );
    expect(lease).toEqual({
      visitId: 'v-named',
      expiresAt: new Date(6_000).toISOString(),
      outcome: 'continued',
      adopted: null,
    });
    expect(calls).toEqual(['find:v-named:adopting', 'touch:v-named']);
  });

  test('adopting: an identified caller adopts the anonymous visit; owned: never', async () => {
    const adopting = fakeStore([{ id: 'v-anon', ownerId: null, startedAt: new Date(0) }]);
    const lease = await issueVisitLease(adopting.store, { ownerId: 'user-1' }, entry, {
      ...options,
      ownership: 'adopting',
    });
    expect(lease.outcome).toBe('continued');
    expect(lease.adopted?.id).toBe('v-anon');
    expect(adopting.calls).toEqual(['find:*:adopting', 'adopt:v-anon:user-1', 'touch:v-anon']);

    const owned = fakeStore([{ id: 'v-anon', ownerId: null, startedAt: new Date(0) }]);
    const fresh = await issueVisitLease(owned.store, { ownerId: 'user-1' }, entry, {
      ...options,
      ownership: 'owned',
    });
    expect(fresh).toMatchObject({ visitId: 'new-visit', outcome: 'started', adopted: null });
    expect(owned.calls).toEqual(['find:*:owned', 'endOpen', 'create:new-visit']);
  });

  test('a new visit closes whatever was open first', async () => {
    const { store, calls, active } = fakeStore([
      { id: 'v-someone', ownerId: 'user-2', startedAt: new Date(0) },
    ]);
    const lease = await issueVisitLease(store, { ownerId: 'user-1' }, entry, {
      ...options,
      ownership: 'owned',
    });
    expect(lease.outcome).toBe('started');
    expect(calls).toEqual(['find:*:owned', 'endOpen', 'create:new-visit']);
    expect(active.map((v) => v.id)).toEqual(['new-visit']);
  });

  test('a visit the store hands back for the wrong owner is not continued', async () => {
    // A store that overlooked `ownership` answers with someone else's visit.
    const { store, calls } = fakeStore([]);
    const careless: TrackingVisitStore<'tx'> = {
      ...store,
      findActive: async () => ({ id: 'v-other', ownerId: 'user-2', startedAt: new Date(0) }),
    };
    const lease = await issueVisitLease(careless, { ownerId: null }, entry, {
      ...options,
      ownership: 'owned',
    });
    expect(lease.outcome).toBe('started');
    expect(calls).toEqual(['endOpen', 'create:new-visit']);
    // …and an anonymous visit under `owned` is not continued either.
    const anonymous: TrackingVisitStore<'tx'> = {
      ...store,
      findActive: async () => ({ id: 'v-anon', ownerId: null, startedAt: new Date(0) }),
    };
    const owned = await issueVisitLease(anonymous, { ownerId: 'user-1' }, entry, {
      ...options,
      ownership: 'owned',
    });
    expect(owned.outcome).toBe('started');
  });

  test("ownership 'adopting' without store.adopt is refused up front", async () => {
    const { store } = fakeStore([]);
    const { adopt: _adopt, ...withoutAdopt } = store;
    await expect(
      issueVisitLease(withoutAdopt, { ownerId: 'user-1' }, entry, {
        ...options,
        ownership: 'adopting',
      }),
    ).rejects.toThrow('requires store.adopt');
  });

  test('a bot gets a lease that no store ever sees', async () => {
    const { store, calls } = fakeStore([]);
    const lease = await issueVisitLease(
      store,
      { ownerId: null, userAgent: 'Googlebot' },
      entry,
      { ...options, ownership: 'adopting' },
    );
    expect(lease).toEqual({
      visitId: 'new-visit',
      expiresAt: new Date(6_000).toISOString(),
      outcome: 'bot',
      adopted: null,
    });
    expect(calls).toEqual([]);
  });
});

describe('presence', () => {
  test('expires after the TTL and answers the freshest visit of an owner', () => {
    let now = 0;
    const presence = createPresenceRegistry<{ tenant: string }>({
      ttlMs: 45_000,
      now: () => now,
    });
    presence.touch({
      browserStreamId: 'b1',
      visitId: 'v1',
      ownerId: 'u',
      page: '/',
      extra: { tenant: 'a' },
    });
    now = 10_000;
    presence.touch({
      browserStreamId: 'b2',
      visitId: 'v2',
      ownerId: 'u',
      page: '/x',
      extra: { tenant: 'b' },
    });
    expect(presence.presentVisitOf('u')).toBe('v2');
    expect(
      presence.snapshot((entry) => entry.extra.tenant === 'a').map((e) => e.visitId),
    ).toEqual(['v1']);
    now = 46_000;
    expect(presence.snapshot().map((e) => e.visitId)).toEqual(['v2']);
    expect(presence.presentVisitOf('nobody')).toBeNull();
    presence.clear();
    expect(presence.snapshot()).toEqual([]);
  });
});
