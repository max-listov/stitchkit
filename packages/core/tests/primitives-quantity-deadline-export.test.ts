import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  addQuantity,
  defineDeadlinePolicy,
  defineExportOperation,
  defineUnitSystem,
  type Quantity,
  QuantityProjectionSchema,
} from '../src/primitives';

describe('quantity value and conversion', () => {
  const units = defineUnitSystem({
    units: ['small', 'large'],
    conversions: [
      {
        id: 'small-to-large-v1',
        from: 'small',
        to: 'large',
        numerator: '1',
        denominator: '100',
      },
      {
        id: 'large-to-small-v1',
        from: 'large',
        to: 'small',
        numerator: '100',
        denominator: '1',
      },
    ],
  });

  test('keeps units in types and explains derived projections on the wire', () => {
    const first = units.create('125.5', 'small');
    expect(addQuantity(first, units.create('0.5', 'small'))).toEqual({
      value: '126',
      unit: 'small',
    });
    function crossUnitAdditionDoesNotCompile() {
      // @ts-expect-error Distinct unit literals cannot be added.
      addQuantity(first, units.create('1', 'large'));
    }
    expect(typeof crossUnitAdditionDoesNotCompile).toBe('function');
    const untrustedLeft: Quantity<string> = { value: '1', unit: 'small' };
    const untrustedRight: Quantity<string> = { value: '1', unit: 'large' };
    expect(() => addQuantity(untrustedLeft, untrustedRight)).toThrow('cannot combine');
    const converted = units.convert(first, 'large');
    expect(QuantityProjectionSchema.parse(JSON.parse(JSON.stringify(converted)))).toEqual({
      kind: 'derived',
      quantity: { value: '1.255', unit: 'large' },
      source: first,
      conversionId: 'small-to-large-v1',
    });
  });

  test('round-trips a matrix of finite decimal conversions exactly', () => {
    for (let index = -500; index <= 500; index += 1) {
      const original = units.create(`${index}.25`, 'small');
      const large = units.convert(original, 'large');
      const roundTrip = units.convert(large.quantity, 'small');
      expect(roundTrip.quantity).toEqual(original);
    }
  });
});

describe('deadline policy', () => {
  test('uses caller-owned categories at exact elapsed-day boundaries', () => {
    const policy = defineDeadlinePolicy({
      boundary: 'elapsed-day',
      timeZone: 'UTC',
      warningDays: 2,
      categories: { onTrack: 'green', warning: 'amber', overdue: 'red' },
    });
    expect(
      policy.evaluate({
        anchorAt: new Date('2026-09-01T00:00:00Z'),
        durationDays: 5,
        now: new Date('2026-09-04T00:00:00Z'),
      }),
    ).toMatchObject({ remainingDays: 2, overdueDays: 0, category: 'amber' });
    expect(policy.queryBoundary(new Date('2026-09-04T00:00:00Z'))).toEqual({
      overdueBefore: '2026-09-04T00:00:00.000Z',
      warningBefore: '2026-09-06T00:00:00.000Z',
    });
  });

  test('keeps calendar time stable across a daylight-saving transition', () => {
    const policy = defineDeadlinePolicy({
      boundary: 'calendar-day',
      timeZone: 'America/New_York',
      warningDays: 1,
      categories: { onTrack: 'safe', warning: 'near', overdue: 'late' },
    });
    const result = policy.evaluate({
      anchorAt: new Date('2026-10-31T13:00:00Z'),
      durationDays: 2,
      now: new Date('2026-11-01T14:00:00Z'),
    });
    expect(result.dueAt).toBe('2026-11-02T14:00:00.000Z');
    expect(result).toMatchObject({ remainingDays: 1, category: 'near' });
  });
});

describe('declared export operation', () => {
  test('keeps immediate and pending results on one ordinary contract operation', () => {
    const exportOperation = defineExportOperation({
      input: z.object({ range: z.string() }),
      operationId: z.uuid(),
      mediaType: 'text/csv',
      filename: ({ range }) => `résumé-${range}.csv`,
    });
    const contract = defineContract(
      { prefix: 'reports' },
      {
        export: exportOperation.endpoint({
          method: 'POST',
          path: '/export',
          desc: 'Prepare an export',
          scope: 'user',
          toolName: 'prepare_export',
          meta: { audit: { mode: 'record', change: z.object({}) } },
        }),
      },
    );
    expect(contract.endpoints.export.scope).toBe('user');
    expect(contract.endpoints.export.toolName).toBe('prepare_export');
    expect(
      exportOperation.ready({ range: 'week' }, { path: 'out/week.csv', size: 12 }),
    ).toEqual({
      state: 'ready',
      file: {
        path: 'out/week.csv',
        size: 12,
        mediaType: 'text/csv',
        name: 'résumé-week.csv',
      },
    });
    expect(exportOperation.pending('5ea053e0-93aa-46ee-9c77-a08e2e8fbb46')).toEqual({
      state: 'pending',
      operationId: '5ea053e0-93aa-46ee-9c77-a08e2e8fbb46',
    });
  });
});
