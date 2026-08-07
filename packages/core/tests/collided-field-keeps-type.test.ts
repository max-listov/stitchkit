import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { flattenToolJsonSchema } from '../src/tools/flatten';
import { toJsonSchema } from '../src/tools/json-schema';

function advertised(union: z.ZodType): Record<string, Record<string, unknown>> {
  const flat = flattenToolJsonSchema(toJsonSchema(union, 'input', 'any'));
  if (typeof flat.properties !== 'object' || flat.properties === null) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(flat.properties)) {
    if (typeof value === 'object' && value !== null) result[key] = value;
  }
  return result;
}

describe('collided fields retain the common useful kind', () => {
  test('integer constraints shared byte-for-byte are retained', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('text'), partIndex: z.number().int().min(0) }),
      z.object({ op: z.literal('button'), partIndex: z.number().int().min(0) }),
    ]);
    expect(advertised(union).partIndex?.type).toBe('integer');
    expect(advertised(union).partIndex?.minimum).toBe(0);
  });

  test('different numeric constraints retain number but drop the constraints', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), n: z.number().min(0) }),
      z.object({ op: z.literal('b'), n: z.number().min(5) }),
    ]);
    expect(advertised(union).n?.type).toBe('number');
    expect(advertised(union).n?.minimum).toBeUndefined();
  });

  test('an enum and a free string still agree on string', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), mode: z.enum(['x', 'y']) }),
      z.object({ op: z.literal('b'), mode: z.string() }),
    ]);
    expect(advertised(union).mode?.type).toBe('string');
    expect(advertised(union).mode?.enum).toBeUndefined();
  });

  test('genuinely different kinds stay unconstrained', () => {
    const union = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), target: z.string() }),
      z.object({ op: z.literal('b'), target: z.number() }),
    ]);
    expect(advertised(union).target?.type).toBeUndefined();
  });

  test('result is independent of variant order', () => {
    const first = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), n: z.number().min(0) }),
      z.object({ op: z.literal('b'), n: z.number().max(5) }),
    ]);
    const second = z.discriminatedUnion('op', [
      z.object({ op: z.literal('b'), n: z.number().max(5) }),
      z.object({ op: z.literal('a'), n: z.number().min(0) }),
    ]);
    expect(advertised(first).n).toEqual(advertised(second).n);
  });
});
