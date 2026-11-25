import { expect, test } from 'bun:test';
import { closeOrphanedSpend, reconcilePendingSpend } from '../src/entrypoints/spend';
import { memorySpendLedger } from './support/spend-ledger';

const attempt = (
  attemptId: string,
  gateway = 'models',
  startedAt = '2026-11-24T00:00:00.000Z',
) => ({
  attemptId,
  gateway,
  startedAt,
  attribution: { purpose: 'live' },
  request: { method: 'POST', origin: 'https://models.example', path: '/v1' },
});

async function seeded() {
  const ledger = memorySpendLedger();
  for (const [id, gateway] of [
    ['priced', 'models'],
    ['later', 'models'],
    ['broken', 'models'],
    ['foreign', 'other'],
  ] as const) {
    await ledger.store.begin(attempt(id, gateway));
    await ledger.store.settle({
      attemptId: id,
      rank: 1,
      at: '2026-11-24T00:00:01.000Z',
      outcome: 'succeeded',
      facts: { costStatus: 'pending', inputTokens: 7 },
    });
  }
  return ledger;
}

test('a pass settles what the provider now knows, leaves the rest pending, and counts failures', async () => {
  const ledger = await seeded();
  const errors: { attemptId: string; message: string }[] = [];
  const result = await reconcilePendingSpend({
    store: ledger.store,
    reconcilers: {
      models: async (record) => {
        if (record.attempt.attemptId === 'priced')
          return { costStatus: 'reported', costUsd: 0.25 };
        if (record.attempt.attemptId === 'broken') throw new Error('provider down');
        return undefined;
      },
    },
    now: () => new Date('2026-11-24T00:01:00.000Z'),
    onError: ({ record, error }) =>
      errors.push({
        attemptId: record.attempt.attemptId,
        message: String(error instanceof Error && error.message),
      }),
  });
  expect(result).toEqual({ checked: 4, reconciled: 1, stillPending: 2, failed: 1 });
  expect(errors).toEqual([{ attemptId: 'broken', message: 'provider down' }]);
  expect(ledger.receipts.get('priced')).toMatchObject({
    rank: 3,
    outcome: 'succeeded',
    facts: { costStatus: 'reported', costUsd: 0.25, inputTokens: 7 },
  });
  expect(ledger.receipts.get('later')?.facts.costStatus).toBe('pending');
});

test('a store without pendingCosts or openAttempts is refused, not silently skipped', async () => {
  const store = { begin: async () => undefined, settle: async () => undefined };
  await expect(reconcilePendingSpend({ store, reconcilers: {} })).rejects.toThrow(TypeError);
  await expect(closeOrphanedSpend({ store, olderThanMs: 1 })).rejects.toThrow(TypeError);
});

test('an attempt nobody closed becomes orphaned with an unknown cost, never zero', async () => {
  const ledger = memorySpendLedger();
  await ledger.store.begin(attempt('old', 'models', '2026-11-23T23:30:00.000Z'));
  await ledger.store.begin(attempt('fresh', 'models', '2026-11-24T00:59:30.000Z'));
  const closed = await closeOrphanedSpend({
    store: ledger.store,
    olderThanMs: 60 * 60 * 1000,
    now: () => new Date('2026-11-24T01:00:00.000Z'),
  });
  expect(closed).toBe(1);
  expect(ledger.receipts.get('old')).toMatchObject({
    outcome: 'orphaned',
    facts: { costStatus: 'unknown', failureCode: 'orphaned' },
  });
  expect(ledger.receipts.get('old')?.facts.costUsd).toBeUndefined();
  expect(ledger.receipts.has('fresh')).toBe(false);
});

test('limit bounds one pass, and now stamps the reconciled receipt', async () => {
  const ledger = await seeded();
  const seen: string[] = [];
  const result = await reconcilePendingSpend({
    store: ledger.store,
    reconcilers: {
      models: async (record) => {
        seen.push(record.attempt.attemptId);
        return { costStatus: 'reported', costUsd: 0.1 };
      },
    },
    limit: 1,
    now: () => new Date('2026-11-24T05:00:00.000Z'),
  });
  expect(result.checked).toBe(1);
  expect(seen).toEqual(['priced']);
  expect(ledger.receipts.get('priced')?.at).toBe('2026-11-24T05:00:00.000Z');
});

test('invalid reconciler facts and corrupt receipt merges route to onError without stopping the pass', async () => {
  const cases: { name: string; answer: () => Record<string, unknown> }[] = [
    { name: 'negative-cost', answer: () => ({ costStatus: 'reported', costUsd: -1 }) },
    {
      name: 'unknown-key',
      answer: () => JSON.parse('{"costStatus":"reported","costUsd":0.1,"extraKey":true}'),
    },
    { name: 'invalid-status', answer: () => JSON.parse('{"costStatus":"bogus"}') },
    { name: 'null-status', answer: () => JSON.parse('{"costStatus":null}') },
    { name: 'non-object', answer: () => JSON.parse('42') },
  ];

  for (const testCase of cases) {
    for (const withHandler of [true, false]) {
      const ledger = memorySpendLedger();
      for (const id of ['bad', 'good']) {
        await ledger.store.begin(attempt(id, 'models'));
        await ledger.store.settle({
          attemptId: id,
          rank: 1,
          at: '2026-11-24T00:00:01.000Z',
          outcome: 'succeeded',
          facts: { costStatus: 'pending', inputTokens: 7 },
        });
      }
      const errors: { attemptId: string; error: unknown }[] = [];
      const result = await reconcilePendingSpend({
        store: ledger.store,
        reconcilers: {
          models: async (record) =>
            record.attempt.attemptId === 'bad'
              ? testCase.answer()
              : { costStatus: 'reported', costUsd: 0.3 },
        },
        now: () => new Date('2026-11-24T00:02:00.000Z'),
        ...(withHandler && {
          onError: ({ record, error }) =>
            errors.push({ attemptId: record.attempt.attemptId, error }),
        }),
      });
      expect(result, `${testCase.name} (onError=${String(withHandler)})`).toEqual({
        checked: 2,
        reconciled: 1,
        stillPending: 0,
        failed: 1,
      });
      if (withHandler) {
        expect(errors).toHaveLength(1);
        expect(errors[0]?.attemptId).toBe('bad');
        expect(errors[0]?.error).toBeInstanceOf(Error);
      }
      expect(ledger.receipts.get('bad')?.facts.costStatus).toBe('pending');
      expect(ledger.receipts.get('good')).toMatchObject({
        rank: 3,
        facts: { costStatus: 'reported', costUsd: 0.3, inputTokens: 7 },
      });
    }
  }

  // Corrupt pending record whose receipt belongs to a different attemptId fails in mergeSpendReceipt.
  for (const withHandler of [true, false]) {
    const ledger = memorySpendLedger();
    await ledger.store.begin(attempt('good', 'models'));
    await ledger.store.settle({
      attemptId: 'good',
      rank: 1,
      at: '2026-11-24T00:00:01.000Z',
      outcome: 'succeeded',
      facts: { costStatus: 'pending', inputTokens: 7 },
    });
    const corruptStore = {
      ...ledger.store,
      pendingCosts: async () => [
        {
          attempt: attempt('corrupt', 'models'),
          receipt: {
            attemptId: 'other-attempt',
            rank: 1 as const,
            at: '2026-11-24T00:00:01.000Z',
            outcome: 'succeeded' as const,
            facts: { costStatus: 'pending' as const },
          },
        },
        ...((await ledger.store.pendingCosts?.({ limit: 10 })) ?? []),
      ],
    };
    const errors: { attemptId: string; error: unknown }[] = [];
    const result = await reconcilePendingSpend({
      store: corruptStore,
      reconcilers: {
        models: async () => ({ costStatus: 'reported', costUsd: 0.4 }),
      },
      now: () => new Date('2026-11-24T00:02:00.000Z'),
      ...(withHandler && {
        onError: ({ record, error }) =>
          errors.push({ attemptId: record.attempt.attemptId, error }),
      }),
    });
    expect(result).toEqual({ checked: 2, reconciled: 1, stillPending: 0, failed: 1 });
    if (withHandler) {
      expect(errors).toHaveLength(1);
      expect(errors[0]?.attemptId).toBe('corrupt');
      expect(errors[0]?.error).toBeInstanceOf(TypeError);
    }
    expect(ledger.receipts.get('good')).toMatchObject({
      rank: 3,
      facts: { costStatus: 'reported', costUsd: 0.4, inputTokens: 7 },
    });
  }
});

test('a reconciler answer with explicit undefined costStatus keeps the unknown default', async () => {
  const ledger = memorySpendLedger();
  await ledger.store.begin(attempt('undef-status', 'models'));
  await ledger.store.settle({
    attemptId: 'undef-status',
    rank: 1,
    at: '2026-11-24T00:00:01.000Z',
    outcome: 'succeeded',
    facts: { costStatus: 'pending', inputTokens: 7 },
  });
  const errors: unknown[] = [];
  const result = await reconcilePendingSpend({
    store: ledger.store,
    reconcilers: {
      models: async () => ({ costStatus: undefined, outputTokens: 12 }),
    },
    now: () => new Date('2026-11-24T00:02:00.000Z'),
    onError: ({ error }) => errors.push(error),
  });
  expect(result).toEqual({ checked: 1, reconciled: 1, stillPending: 0, failed: 0 });
  expect(errors).toEqual([]);
  expect(ledger.receipts.get('undef-status')).toMatchObject({
    rank: 3,
    facts: { costStatus: 'unknown', inputTokens: 7, outputTokens: 12 },
  });
});

test('store.settle failure rejects reconcilePendingSpend and does not invoke onError (negative control)', async () => {
  const ledger = memorySpendLedger();
  await ledger.store.begin(attempt('priced', 'models'));
  await ledger.store.settle({
    attemptId: 'priced',
    rank: 1,
    at: '2026-11-24T00:00:01.000Z',
    outcome: 'succeeded',
    facts: { costStatus: 'pending' },
  });
  const errors: unknown[] = [];
  const failingSettleStore = {
    ...ledger.store,
    settle: async () => {
      throw new Error('db down');
    },
  };
  await expect(
    reconcilePendingSpend({
      store: failingSettleStore,
      reconcilers: {
        models: async () => ({ costStatus: 'reported', costUsd: 0.5 }),
      },
      onError: ({ error }) => errors.push(error),
    }),
  ).rejects.toThrow('db down');
  expect(errors).toEqual([]);
});
