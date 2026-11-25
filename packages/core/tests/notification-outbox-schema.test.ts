import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createNotificationOutboxStateSchema,
  type NotificationOutboxState,
} from '../src/entrypoints/application';

const PayloadSchema = z.strictObject({
  recipientId: z.string().min(1),
  text: z.string().min(1),
});
type Payload = z.infer<typeof PayloadSchema>;

describe('createNotificationOutboxStateSchema', () => {
  const StateSchema = createNotificationOutboxStateSchema(PayloadSchema);

  test('accepts a valid empty and populated outbox state', () => {
    const empty: NotificationOutboxState<Payload> = {
      schemaVersion: 1,
      queue: [],
      receipts: [],
    };
    expect(StateSchema.parse(empty)).toEqual(empty);

    const populated: NotificationOutboxState<Payload> = {
      schemaVersion: 1,
      queue: [
        {
          key: 'order:42:paid',
          payload: { recipientId: 'user-1', text: 'Order confirmed' },
          createdAt: '2026-11-23T10:00:00.000Z',
          attempts: 1,
          nextAttemptAt: '2026-11-23T10:05:00.000Z',
          leaseOwner: 'worker-a',
          leaseId: 'lease-1',
          leaseUntil: '2026-11-23T10:01:00.000Z',
        },
      ],
      receipts: [
        {
          key: 'order:41:paid',
          completedAt: '2026-11-23T09:59:00.000Z',
        },
      ],
    };
    expect(StateSchema.parse(populated)).toEqual(populated);
  });

  test('rejects invalid schemaVersion, payload, timestamps, counts, and unknown keys', () => {
    expect(
      StateSchema.safeParse({ schemaVersion: 2, queue: [], receipts: [] }).success,
    ).toBeFalse();

    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        queue: [],
        receipts: [],
        extraField: true,
      }).success,
    ).toBeFalse();

    const baseItem = {
      key: 'order:42:paid',
      payload: { recipientId: 'user-1', text: 'Order confirmed' },
      createdAt: '2026-11-23T10:00:00.000Z',
      attempts: 0,
      nextAttemptAt: '2026-11-23T10:00:00.000Z',
      leaseOwner: null,
      leaseId: null,
      leaseUntil: null,
    };

    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        queue: [{ ...baseItem, payload: { recipientId: '', text: 'bad' } }],
        receipts: [],
      }).success,
    ).toBeFalse();

    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        queue: [{ ...baseItem, attempts: -1 }],
        receipts: [],
      }).success,
    ).toBeFalse();

    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        queue: [{ ...baseItem, createdAt: 'not-a-timestamp' }],
        receipts: [],
      }).success,
    ).toBeFalse();

    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        queue: [{ ...baseItem, extraItemKey: 'nope' }],
        receipts: [],
      }).success,
    ).toBeFalse();

    expect(
      StateSchema.safeParse({
        schemaVersion: 1,
        queue: [],
        receipts: [{ key: '', completedAt: '2026-11-23T09:59:00.000Z' }],
      }).success,
    ).toBeFalse();
  });
});
