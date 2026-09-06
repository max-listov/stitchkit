import { describe, expect, test } from 'bun:test';
import { defineContract } from '../src/contract/define';
import { createDimensionsProjector } from '../src/observability/audit';
import {
  getRequestContext,
  runWithRequestContext,
  setRequestDimensions,
} from '../src/observability/context';
import { implement } from '../src/server/implement';

const contract = defineContract(
  { prefix: 'schools' },
  {
    create: { method: 'POST', path: '/', desc: 'Create a school' },
  },
);
const endpoint = implement(contract, { create: () => undefined }).methods.create;
if (!endpoint) throw new Error('Expected endpoint');

describe('typed dimensions projector', () => {
  test('projects request and result phases through the active request context', () => {
    const projector = createDimensionsProjector<
      { params: undefined; input: { tenantId: string }; source: 'http' },
      { school: { id: string } }
    >({
      request: (ctx) => ({ tenantId: ctx.input.tenantId }),
      result: (_ctx, result) => ({ entityType: 'school', entityId: result.school.id }),
    });

    const context = {
      trace: { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' },
      source: 'http' as const,
      method: 'POST',
      path: '/schools',
      startedAt: 1n,
    };
    runWithRequestContext(context, () => {
      const ctx = {
        params: undefined,
        input: { tenantId: 'tenant-1' },
        source: 'http' as const,
      };
      projector.request(ctx, endpoint);
      const result = projector.result(ctx, { school: { id: 'school-1' } }, endpoint);
      expect(result.school.id).toBe('school-1');
      expect(getRequestContext()?.dimensions).toEqual({
        tenantId: 'tenant-1',
        entityType: 'school',
        entityId: 'school-1',
      });
    });
  });

  test('makes collision behavior explicit', () => {
    const context = {
      trace: { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), traceFlags: '01' },
      source: 'http' as const,
      method: 'GET',
      path: '/schools/one',
      startedAt: 1n,
    };
    runWithRequestContext(context, () => {
      setRequestDimensions({ entityId: 'first' });
      setRequestDimensions({ entityId: 'second' }, { collision: 'preserve' });
      expect(getRequestContext()?.dimensions?.entityId).toBe('first');
      expect(() =>
        setRequestDimensions({ entityId: 'third' }, { collision: 'error' }),
      ).toThrow('already set');
    });
  });
});
