/**
 * The outbox policy of an offline-first client, on the cases a consuming app
 * ships and on the rules its tests leave implicit: pages carry the decision
 * over, rows that wait on the keys they share, a set-aside row that holds its
 * chain unless the app releases it, exact message bytes, and when to look again.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  acknowledgeableOutboxIds,
  coveredOutboxIds,
  decideOutboxBatch,
  type OutboxPolicy,
  type OutboxRow,
  replaceableOutboxRow,
} from '../src/sync/outbox';

interface Row extends OutboxRow {
  readonly action: string;
}
const Change = z.object({
  id: z.string(),
  entity: z.string(),
  entityId: z.string(),
  action: z.enum(['create', 'update', 'delete']),
  payload: z.record(z.string(), z.unknown()),
});
const envelope = (changes: unknown[]) => JSON.stringify({ type: 'sync_push', changes });
const policy = (patch: Partial<OutboxPolicy<Row, z.infer<typeof Change>>> = {}) => ({
  toChange: (row: Row, payload: unknown) => {
    const parsed = Change.safeParse({ ...row, payload });
    return parsed.success ? parsed.data : undefined;
  },
  emptyEnvelopeBytes: new TextEncoder().encode(envelope([])).byteLength,
  maxBytes: 64 * 1024,
  maxChanges: 50,
  retryAfterMs: 30_000,
  ...patch,
});
function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'a',
    entity: 'task',
    entityId: 'a',
    action: 'update',
    payloadJson: '{"text":"hello"}',
    status: 'pending',
    sentAt: null,
    attempts: 0,
    ...overrides,
  };
}

describe('the consuming app’s cases', () => {
  test('a missing or damaged sent timestamp cannot strand an attempted row forever', () => {
    for (const sentAt of [null, 'invalid']) {
      const decision = decideOutboxBatch([row({ status: 'sent', attempts: 1, sentAt })], {
        now: 0,
        policy: policy(),
      });
      expect(decision.send.map((change) => change.id)).toEqual(['a']);
      expect(decision.sent[0]?.attempts).toBe(2);
    }
    expect(
      decideOutboxBatch([row({ status: 'sent', sentAt: new Date(0).toISOString() })], {
        now: 1,
        policy: policy(),
      }).send,
    ).toHaveLength(0);
  });

  test('message bytes include the envelope, separators and UTF-8 at the exact boundary', () => {
    const rows = [row(), row({ id: 'b', entityId: 'b', payloadJson: '{"text":"я"}' })];
    const all = decideOutboxBatch(rows, { now: 0, policy: policy() });
    const exact = new TextEncoder().encode(envelope(all.send)).byteLength;
    expect(all.bytes).toBe(exact);
    expect(
      decideOutboxBatch(rows, { now: 0, policy: policy({ maxBytes: exact }) }).send,
    ).toHaveLength(2);
    expect(
      decideOutboxBatch(rows, { now: 0, policy: policy({ maxBytes: exact - 1 }) }).send,
    ).toHaveLength(1);
    expect(
      decideOutboxBatch([row({ status: 'unexpected' })], { now: 0, policy: policy() })
        .quarantine,
    ).toEqual([{ id: 'a', reason: 'invalid_change' }]);
  });
});

describe('the rules', () => {
  test('one in-flight batch per entity: a later row of it waits, another entity goes', () => {
    const decision = decideOutboxBatch(
      [row({ id: '1' }), row({ id: '2' }), row({ id: '3', entityId: 'b' })],
      { now: 0, policy: policy() },
    );
    expect(decision.send.map((change) => change.id)).toEqual(['1', '3']);
  });

  test('a decision carries over between pages, so an entity blocked on one stays blocked on the next', () => {
    const first = decideOutboxBatch([row({ id: '1' })], { now: 0, policy: policy() });
    const second = decideOutboxBatch([row({ id: '2' }), row({ id: '3', entityId: 'b' })], {
      now: 0,
      policy: policy(),
      previous: first,
    });
    expect(second.send.map((change) => change.id)).toEqual(['1', '3']);
  });

  test('released, a quarantined row does not block its entity', () => {
    const decision = decideOutboxBatch(
      [
        row({ id: '1', payloadJson: '{not json' }),
        row({ id: '2', status: 'quarantined' }),
        row({ id: '3' }),
      ],
      { now: 0, policy: policy({ setAside: 'releases-keys' }) },
    );
    expect(decision.quarantine).toEqual([{ id: '1', reason: 'invalid_json' }]);
    expect(decision.send.map((change) => change.id)).toEqual(['3']);
  });

  test('a change larger than a whole batch is quarantined, not retried forever', () => {
    const decision = decideOutboxBatch(
      [row({ payloadJson: JSON.stringify({ text: 'x'.repeat(200) }) })],
      { now: 0, policy: policy({ maxBytes: 100 }) },
    );
    expect(decision.quarantine).toEqual([{ id: 'a', reason: 'payload_too_large' }]);
  });

  test('a full batch asks to be read again at once; otherwise the next wake is the nearest retry', () => {
    const full = decideOutboxBatch([row({ id: '1' }), row({ id: '2', entityId: 'b' })], {
      now: 0,
      policy: policy({ maxChanges: 1 }),
    });
    expect(full).toMatchObject({ full: true, nextWakeMs: 0 });
    const waiting = decideOutboxBatch(
      [row({ status: 'sent', attempts: 1, sentAt: new Date(10_000).toISOString() })],
      { now: 25_000, policy: policy() },
    );
    expect(waiting).toMatchObject({ full: false, nextWakeMs: 15_000, send: [] });
  });

  test('a custom key blocks what the app says one batch covers', () => {
    const decision = decideOutboxBatch([row({ id: '1' }), row({ id: '2', entity: 'note' })], {
      now: 0,
      policy: policy({ keysOf: (candidate) => [candidate.entityId] }),
    });
    expect(decision.send.map((change) => change.id)).toEqual(['1']);
  });

  test('only attempted, unquarantined rows are acknowledgeable', () => {
    expect(
      acknowledgeableOutboxIds([
        { id: 'sent', status: 'sent', attempts: 1 },
        { id: 'late', status: 'pending', attempts: 2 },
        { id: 'never', status: 'pending', attempts: 0 },
        { id: 'bad', status: 'quarantined', attempts: 1 },
      ]),
    ).toEqual(['sent', 'late']);
  });
});

describe('what a decision waits for and carries over', () => {
  const sentAgo = (ms: number, now: number) => new Date(now - ms).toISOString();

  test('a row waiting for its retry blocks the later rows of its entity', () => {
    const now = 100_000;
    const decision = decideOutboxBatch(
      [
        row({ id: '1', status: 'sent', attempts: 1, sentAt: sentAgo(1_000, now) }),
        row({ id: '2' }),
      ],
      { now, policy: policy() },
    );
    expect(decision.send).toEqual([]);
    expect(decision.nextWakeMs).toBe(29_000);
  });

  test('the next wake is the nearest of every wait, and a sent row waits its whole retry', () => {
    const now = 100_000;
    const waiting = decideOutboxBatch(
      [
        row({
          id: 'far',
          entityId: 'a',
          status: 'sent',
          attempts: 1,
          sentAt: sentAgo(1_000, now),
        }),
        row({
          id: 'near',
          entityId: 'b',
          status: 'sent',
          attempts: 1,
          sentAt: sentAgo(25_000, now),
        }),
      ],
      { now, policy: policy() },
    );
    expect(waiting.nextWakeMs).toBe(5_000);
    const sent = decideOutboxBatch([row()], { now, policy: policy() });
    expect(sent.nextWakeMs).toBe(30_000);
    expect(sent.sent).toEqual([{ id: 'a', sentAt: new Date(now).toISOString(), attempts: 1 }]);
  });

  test('a change too large is measured with the envelope around it', () => {
    const one = decideOutboxBatch([row()], { now: 0, policy: policy() });
    const alone = one.bytes - policy().emptyEnvelopeBytes;
    const decision = decideOutboxBatch([row()], {
      now: 0,
      policy: policy({ maxBytes: alone + policy().emptyEnvelopeBytes - 1 }),
    });
    expect(decision.quarantine).toEqual([{ id: 'a', reason: 'payload_too_large' }]);
  });

  test('a full batch stays full on the next page, and bytes and wake carry over', () => {
    const full = decideOutboxBatch([row({ id: '1' }), row({ id: '2', entityId: 'b' })], {
      now: 0,
      policy: policy({ maxChanges: 1 }),
    });
    const next = decideOutboxBatch([row({ id: '3', entityId: 'c' })], {
      now: 0,
      policy: policy({ maxChanges: 1 }),
      previous: full,
    });
    expect(next.send.map((change) => change.id)).toEqual(['1']);
    expect(next).toMatchObject({ full: true, nextWakeMs: 0 });
    const first = decideOutboxBatch([row({ id: '1' })], { now: 0, policy: policy() });
    const second = decideOutboxBatch([row({ id: '2', entityId: 'b' })], {
      now: 0,
      policy: policy(),
      previous: first,
    });
    expect(second.bytes).toBe(new TextEncoder().encode(envelope(second.send)).byteLength);
    expect(second.nextWakeMs).toBe(30_000);
  });

  test('released, a held row is skipped, blocks nothing and is not acknowledgeable', () => {
    const decision = decideOutboxBatch(
      [row({ id: 'h', status: 'held', attempts: 3 }), row({ id: '2' })],
      {
        now: 0,
        policy: policy({ setAside: 'releases-keys' }),
      },
    );
    expect(decision.send.map((change) => change.id)).toEqual(['2']);
    expect(decision.quarantine).toEqual([]);
    expect(acknowledgeableOutboxIds([{ id: 'h', status: 'held', attempts: 3 }])).toEqual([]);
  });
});

describe('the keys a row depends on', () => {
  interface Keyed extends Row {
    readonly keys: readonly string[];
  }
  const keyed = (id: string, keys: string[], patch: Partial<Row> = {}): Keyed => ({
    ...row({ id, entityId: id, ...patch }),
    keys,
  });
  const keyedPolicy = (patch: Partial<OutboxPolicy<Keyed, z.infer<typeof Change>>> = {}) => ({
    ...policy(),
    keysOf: (candidate: Keyed) => candidate.keys,
    ...patch,
  });

  test('a row is ripe when no earlier unresolved row shares any of its keys', () => {
    // A folder, a page in it, and a move of an old page into the folder: each waits for the
    // folder; an edit of another record shares nothing and goes alongside.
    const decision = decideOutboxBatch(
      [
        keyed('folder', ['F']),
        keyed('page', ['P', 'F']),
        keyed('move', ['X', 'F', 'old']),
        keyed('other', ['Y']),
      ],
      { now: 0, policy: keyedPolicy() },
    );
    expect(decision.send.map((change) => change.id)).toEqual(['folder', 'other']);
    expect([...decision.blockedKeys].toSorted()).toEqual(['F', 'P', 'X', 'Y', 'old']);
  });

  test('a row waiting on one key holds its other keys too, so nothing behind it overtakes it', () => {
    // `move` waits for `folder` (key F); `purge` shares only `old` with `move` and must wait
    // for it, though nothing in flight carries `old`.
    const decision = decideOutboxBatch(
      [keyed('folder', ['F']), keyed('move', ['X', 'F', 'old']), keyed('purge', ['old'])],
      { now: 0, policy: keyedPolicy() },
    );
    expect(decision.send.map((change) => change.id)).toEqual(['folder']);
  });

  test('every key carries over between pages', () => {
    const first = decideOutboxBatch([keyed('move', ['X', 'F', 'old'])], {
      now: 0,
      policy: keyedPolicy(),
    });
    const second = decideOutboxBatch([keyed('purge', ['old']), keyed('free', ['Z'])], {
      now: 0,
      policy: keyedPolicy(),
      previous: first,
    });
    expect(second.send.map((change) => change.id)).toEqual(['move', 'free']);
  });

  test('a row with no keys depends on nothing', () => {
    const decision = decideOutboxBatch([keyed('a', ['K']), keyed('b', [])], {
      now: 0,
      policy: keyedPolicy(),
    });
    expect(decision.send.map((change) => change.id)).toEqual(['a', 'b']);
  });
});

describe('what a queue must never do: let a row go without the row it was made on', () => {
  // A row E1 edits a block with the revision it saw; E2 edits the same block on top of E1 and
  // carries no revision for it — it was to take E1's number. E1 is refused for good.
  const chain = (status: string) => [
    row({ id: 'E1', status, attempts: 1, sentAt: new Date(0).toISOString() }),
    row({ id: 'E2' }),
    row({ id: 'other', entityId: 'b' }),
  ];

  test('a quarantined row holds the later rows of its keys; other keys go on', () => {
    const decision = decideOutboxBatch(chain('quarantined'), { now: 0, policy: policy() });
    expect(decision.send.map((change) => change.id)).toEqual(['other']);
    expect(decision.blockedKeys.has(JSON.stringify(['task', 'a']))).toBe(true);
  });

  test('a held row holds them the same way', () => {
    const decision = decideOutboxBatch(chain('held'), { now: 0, policy: policy() });
    expect(decision.send.map((change) => change.id)).toEqual(['other']);
  });

  test('a row quarantined in this very decision holds its keys at once', () => {
    const decision = decideOutboxBatch(
      [row({ id: 'E1', payloadJson: '{not json' }), row({ id: 'E2' })],
      { now: 0, policy: policy() },
    );
    expect(decision.quarantine).toEqual([{ id: 'E1', reason: 'invalid_json' }]);
    expect(decision.send).toEqual([]);
  });

  test('released by a person: retried, the chain goes in order; discarded, the next row goes', () => {
    const retried = decideOutboxBatch(
      [row({ id: 'E1', attempts: 1, sentAt: null }), row({ id: 'E2' })],
      { now: 0, policy: policy() },
    );
    expect(retried.send.map((change) => change.id)).toEqual(['E1']);
    const discarded = decideOutboxBatch([row({ id: 'E2' })], { now: 0, policy: policy() });
    expect(discarded.send.map((change) => change.id)).toEqual(['E2']);
  });

  test('an app whose rows stand alone lets a set-aside row release its keys', () => {
    const decision = decideOutboxBatch(chain('quarantined'), {
      now: 0,
      policy: policy({ setAside: 'releases-keys' }),
    });
    expect(decision.send.map((change) => change.id)).toEqual(['E2', 'other']);
  });

  test('a set-aside mode the policy does not know is refused', () => {
    expect(() =>
      decideOutboxBatch([row()], {
        now: 0,
        // @ts-expect-error — the mode is one of two names.
        policy: policy({ setAside: 'sometimes' }),
      }),
    ).toThrow(RangeError);
  });
});

describe('what a row may still become', () => {
  test('only a row that never left may be replaced; the sent mark of a decision ends that', () => {
    const fresh = row();
    expect(replaceableOutboxRow(fresh)).toBe(true);
    const decision = decideOutboxBatch([fresh], { now: 0, policy: policy() });
    const mark = decision.sent[0];
    if (!mark) throw new Error('the row was not sent');
    // The mark the app commits before the send survives a restart that puts the row back.
    const restarted = {
      ...fresh,
      status: 'pending',
      sentAt: mark.sentAt,
      attempts: mark.attempts,
    };
    expect(replaceableOutboxRow(restarted)).toBe(false);
    expect(replaceableOutboxRow({ ...fresh, attempts: 1 })).toBe(false);
    expect(replaceableOutboxRow({ ...fresh, sentAt: 'invalid' })).toBe(false);
    for (const status of ['sent', 'quarantined', 'held', 'confirmed'])
      expect(replaceableOutboxRow({ ...fresh, status })).toBe(false);
  });

  test('a confirmed row is not sent again, holds nothing and is not acknowledged twice', () => {
    const decision = decideOutboxBatch(
      [row({ id: 'c', status: 'confirmed', attempts: 1 }), row({ id: '2' })],
      { now: 0, policy: policy() },
    );
    expect(decision.send.map((change) => change.id)).toEqual(['2']);
    expect(decision.quarantine).toEqual([]);
    expect(acknowledgeableOutboxIds([{ id: 'c', status: 'confirmed', attempts: 1 }])).toEqual(
      [],
    );
  });

  test('a confirmed row leaves once the cursor covers its version; one without a version at once', () => {
    const rows = [
      { id: 'covered', status: 'confirmed', confirmedVersion: 7 },
      { id: 'ahead', status: 'confirmed', confirmedVersion: 8 },
      { id: 'unnumbered', status: 'confirmed', confirmedVersion: null },
      { id: 'pending', status: 'pending', confirmedVersion: null },
    ];
    expect(coveredOutboxIds(rows, 7)).toEqual(['covered', 'unnumbered']);
    expect(coveredOutboxIds(rows, null)).toEqual(['unnumbered']);
    expect(coveredOutboxIds(rows, 8)).toEqual(['covered', 'ahead', 'unnumbered']);
  });
});
