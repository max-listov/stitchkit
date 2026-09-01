import { describe, expect, test } from 'bun:test';
import {
  addMoney,
  defineMoney,
  defineOwnerScope,
  type Money,
  type OwnerScope,
  scanMoneyNumberRisks,
  scanOwnerFilterRisks,
} from '../src/primitives';

describe('owner scope', () => {
  const scopes = defineOwnerScope<
    { ownerId?: string; permissions: readonly string[] },
    string
  >({
    ownerId: (identity) => identity.ownerId,
    canAccessAll: (identity) => identity.permissions.includes('all'),
  });

  test('derives scoped access from identity and requires an explicit all-owner request', () => {
    expect(scopes.forIdentity({ ownerId: 'owner-1', permissions: [] })).toMatchObject({
      outcome: 'resolved',
      scope: { kind: 'owner', ownerId: 'owner-1' },
    });
    expect(scopes.forIdentity({ permissions: ['all'] })).toEqual({ outcome: 'owner_missing' });
    expect(scopes.acrossAllOwners({ permissions: [] })).toEqual({
      outcome: 'across_all_forbidden',
    });
    expect(scopes.acrossAllOwners({ permissions: ['all'] })).toMatchObject({
      outcome: 'resolved',
      scope: { kind: 'all', permission: 'acrossAllOwners' },
    });
  });

  test('finds the shorthand property, which carries no colon', () => {
    // `{ ownerId }` is the ordinary ES2015 form and was invisible to the first
    // version of this scan, which required `ownerId:`. Measured on the trees the
    // scan exists for, roughly one filter in ten is written this way — and a
    // report that silently omits them still reads as complete.
    const shorthand = scanOwnerFilterRisks([
      {
        path: 'query.ts',
        text:
          'db.record.findMany({ where: { ownerId } });\n' +
          'db.record.findMany({ where: { archived: false, ownerId } });',
      },
    ]);
    expect(shorthand.map((risk) => risk.line)).toEqual([1, 2]);

    // The narrowness that keeps it usable: a longer identifier that merely
    // starts with the key is not the key, and an object that is not a query
    // argument is not a filter.
    const quiet = scanOwnerFilterRisks([
      {
        path: 'query.ts',
        text: 'db.record.findMany({ where: { ownerIdentifier } });\nconst config = { ownerId };',
      },
    ]);
    expect(quiet).toEqual([]);
  });

  test('finds manual owner filtering without flagging unrelated queries', () => {
    const risks = scanOwnerFilterRisks([
      {
        path: 'query.ts',
        text:
          'db.record.findMany({ where: { ownerId: identity.ownerId } });\n' +
          'db.publicRecord.findMany({ where: { published: true } });',
      },
    ]);
    expect(risks).toHaveLength(1);
    expect(risks[0]?.kind).toBe('manual-owner-filter');
  });

  test('requires a resolved branded scope at a data-adapter boundary', () => {
    function readWithScope(scope: OwnerScope<string>) {
      return scope.kind;
    }
    function unscopedReadDoesNotCompile() {
      // @ts-expect-error A missing scope is distinct from explicit across-all intent.
      readWithScope(undefined);
    }
    expect(typeof unscopedReadDoesNotCompile).toBe('function');
  });
});

describe('money value', () => {
  const alpha = defineMoney('AAA');
  const beta = defineMoney('BBB');

  test('keeps currency on the wire and refuses cross-currency arithmetic by type', () => {
    const first = alpha.create('125');
    const second = alpha.create(75n);
    expect(alpha.add(first, second)).toEqual({ minor: '200', currency: 'AAA' });
    expect(alpha.schema.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    function crossCurrencyAdditionDoesNotCompile() {
      // @ts-expect-error Currency literals differ; conversion must be application-owned.
      alpha.add(first, beta.create('10'));
    }
    expect(typeof crossCurrencyAdditionDoesNotCompile).toBe('function');

    const untrustedLeft: Money<string> = { minor: '10', currency: 'AAA' };
    const untrustedRight: Money<string> = { minor: '10', currency: 'BBB' };
    expect(() => addMoney(untrustedLeft, untrustedRight)).toThrow('cannot combine');
  });

  test('returns an exact rational remainder for a share', () => {
    const share = alpha.share(alpha.create('100'), 1n, 3n);
    expect(share).toEqual({
      amount: { minor: '33', currency: 'AAA' },
      remainder: { numerator: '1', denominator: '3', currency: 'AAA' },
    });
    expect(BigInt(share.amount.minor) * 3n + BigInt(share.remainder.numerator)).toBe(100n);
  });

  test('splits random totals into exact parts plus an explicit remainder', () => {
    for (let index = 0; index < 500; index += 1) {
      const total = BigInt(Math.floor(Math.random() * 2_000_001) - 1_000_000);
      const count = Math.floor(Math.random() * 97) + 1;
      const split = alpha.split(alpha.create(total), count);
      const reconstructed =
        BigInt(split.part.minor) * BigInt(count) + BigInt(split.remainder.minor);
      expect(reconstructed).toBe(total);
    }
  });

  test('finds decimal money formatting but ignores unrelated rounding', () => {
    const risks = scanMoneyNumberRisks([
      {
        path: 'format.ts',
        text: 'const shown = amount.toFixed(2);\nconst ratio = distance.toFixed(2);',
      },
    ]);
    expect(risks).toHaveLength(1);
    expect(risks[0]?.excerpt).toContain('amount.toFixed(2)');
  });
});
