import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import {
  assertAuditDeclared,
  audit,
  createAuditRecord,
  type DomainEventDeliveryClaim,
  type DomainEventDeliveryOutcome,
  defineDomainEventDelivery,
  definePermissionMatrix,
} from '../src/primitives';

describe('permission matrix', () => {
  const permissions = definePermissionMatrix({
    roles: ['reader', 'editor'],
    operations: ['read', 'write'],
    grants: {
      reader: { read: true, write: false },
      editor: { read: true, write: true },
    },
  });

  test('projects capabilities from the exact decisions used by server checks', () => {
    for (const role of permissions.definition.roles) {
      for (const operation of permissions.definition.operations) {
        expect(permissions.capabilities(role).includes(operation)).toBe(
          permissions.allows(role, operation),
        );
      }
    }
    expect(permissions.check('missing', 'read')).toEqual({
      outcome: 'unknown_role',
      role: 'missing',
    });
  });

  test('requires every operation in every role row by type', () => {
    function incompletePermissionMatrixDoesNotCompile() {
      definePermissionMatrix({
        roles: ['reader'],
        operations: ['read', 'write'],
        // @ts-expect-error An omitted operation is not an implicit deny.
        grants: { reader: { read: true } },
      });
    }
    expect(typeof incompletePermissionMatrixDoesNotCompile).toBe('function');
  });
});

describe('declared audit', () => {
  const change = z.object({ field: z.string(), next: z.string() });

  test('requires an explicit endpoint decision and validates the declared change', () => {
    const missing = defineContract(
      { prefix: 'missing-audit' },
      {
        read: {
          method: 'GET',
          path: '/',
          desc: 'Read',
          output: z.object({ ok: z.boolean() }),
        },
      },
    );
    expect(() => assertAuditDeclared(missing)).toThrow('must declare meta.audit');

    const declared = defineContract(
      { prefix: 'declared-audit' },
      {
        read: {
          method: 'GET',
          path: '/',
          desc: 'Read',
          output: z.object({ ok: z.boolean() }),
          meta: { audit: audit.omit('read-only projection') },
        },
        change: {
          method: 'POST',
          path: '/change',
          desc: 'Change',
          input: z.object({ next: z.string() }),
          output: z.object({ ok: z.boolean() }),
          meta: { audit: audit.record(change) },
        },
      },
    );
    expect(() => assertAuditDeclared(declared)).not.toThrow();
    expect(() => audit.omit('')).toThrow('requires a reason');
    expect(() =>
      createAuditRecord({
        id: 'event-1',
        occurredAt: '2026-09-01T12:00:00Z',
        operation: 'declared-audit.change',
        actor: { id: 'actor-1', role: 'editor' },
        subject: { type: 'record', id: 'record-1' },
        policy: audit.record(change),
        change: { field: 'name', next: '' },
      }),
    ).not.toThrow();
    expect(() =>
      createAuditRecord({
        id: 'event-1',
        occurredAt: '2026-09-01T12:00:00Z',
        operation: 'declared-audit.change',
        actor: { id: 'actor-1', role: 'editor' },
        subject: { type: 'record', id: 'record-1' },
        policy: audit.record(change),
        // @ts-expect-error The declared audit change schema requires a string field.
        change: { field: 1, next: '' },
      }),
    ).toThrow();
  });
});

describe('application-owned event delivery', () => {
  test('plans once and settles delivered, retryable, terminal and unknown attempts distinctly', async () => {
    const auditEvent = createAuditRecord({
      id: 'event-1',
      occurredAt: '2026-09-01T12:00:00Z',
      operation: 'records.change',
      actor: { id: 'actor-1', role: 'editor' },
      subject: { type: 'record', id: 'record-1' },
      policy: audit.record(z.object({ next: z.string() })),
      change: { next: 'value' },
    });
    const outcomes: DomainEventDeliveryOutcome[] = [
      { outcome: 'delivered', receipt: 'receipt-1' },
      { outcome: 'retryable', code: 'TEMPORARY', retryAt: '2026-09-01T12:01:00Z' },
      { outcome: 'terminal', code: 'DESTINATION_GONE' },
    ];
    const settled: string[] = [];
    const pending: DomainEventDeliveryClaim[] = [];
    const delivery = defineDomainEventDelivery({
      routes: [
        {
          type: 'audit.recorded',
          destinations: () => [
            { id: 'a', transport: 'test', address: 'one' },
            { id: 'b', transport: 'test', address: 'two' },
            { id: 'c', transport: 'test', address: 'three' },
            { id: 'd', transport: 'missing', address: 'four' },
          ],
        },
      ],
      transports: {
        test: {
          async send() {
            const outcome = outcomes.shift();
            if (!outcome) throw new Error('unexpected attempt');
            return outcome;
          },
        },
      },
      outbox: {
        async claim() {
          return pending.shift();
        },
        async delivered() {
          settled.push('delivered');
        },
        async retry() {
          settled.push('retry');
        },
        async terminal() {
          settled.push('terminal');
        },
        async unknown() {
          settled.push('unknown');
        },
      },
    });
    const plan = delivery.plan(auditEvent);
    expect(plan.event.id).toBe(auditEvent.id);
    pending.push(
      ...plan.destinations.map((destination, index) => ({
        event: plan.event,
        destination,
        attempt: index + 1,
      })),
    );
    expect(await delivery.dispatch(auditEvent.id)).toEqual({
      eventId: 'event-1',
      attempts: 4,
      exhausted: false,
    });
    expect(settled).toEqual(['delivered', 'retry', 'terminal', 'unknown']);
  });

  test('refuses duplicate destination identities before persistence', () => {
    const delivery = defineDomainEventDelivery({
      routes: [
        {
          type: 'example',
          destinations: () => [
            { id: 'same', transport: 'one', address: 'a' },
            { id: 'same', transport: 'two', address: 'b' },
          ],
        },
      ],
      transports: {},
      outbox: {
        async claim() {
          return undefined;
        },
        async delivered() {
          return undefined;
        },
        async retry() {
          return undefined;
        },
        async terminal() {
          return undefined;
        },
        async unknown() {
          return undefined;
        },
      },
    });
    expect(() =>
      delivery.plan({
        id: 'event-1',
        type: 'example',
        occurredAt: '2026-09-01T12:00:00Z',
        subject: { type: 'record', id: 'record-1' },
        payload: {},
      }),
    ).toThrow('duplicate destination id');
  });
});
