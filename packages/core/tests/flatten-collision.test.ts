import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { isRecord } from '../src/internal/typed';
import { flattenToolJsonSchema } from '../src/tools/flatten';
import { toJsonSchema } from '../src/tools/json-schema';

function properties(schema: Record<string, unknown>): Record<string, unknown> {
  const value = schema.properties;
  return isRecord(value) ? value : {};
}

function field(schema: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = properties(schema)[name];
  return isRecord(value) ? value : {};
}

function flatten(schema: z.ZodType): Record<string, unknown> {
  return flattenToolJsonSchema(toJsonSchema(schema, 'input', 'any'));
}

describe('conservative discriminated-union join', () => {
  test('keeps common types and drops branch-only constraints', () => {
    const schema = flatten(
      z.discriminatedUnion('op', [
        z.object({ op: z.literal('a'), n: z.number().int().min(0) }),
        z.object({ op: z.literal('b'), n: z.number().max(10) }),
      ]),
    );
    expect(field(schema, 'n').type).toBe('number');
    expect(field(schema, 'n').minimum).toBeUndefined();
    expect(field(schema, 'n').maximum).toBeUndefined();
  });

  test('widens object-vs-array collisions to an unconstrained field', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('one'), media: z.object({ id: z.string() }) }),
        z.object({ kind: z.literal('many'), media: z.array(z.object({ id: z.string() })) }),
      ]),
    );
    expect(field(schema, 'media').type).toBeUndefined();
  });

  test('merges string literals into one enum', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), mode: z.literal('fast') }),
        z.object({ kind: z.literal('b'), mode: z.literal('slow') }),
      ]),
    );
    expect(field(schema, 'mode').enum).toEqual(['fast', 'slow']);
  });

  test('only all-strict variants advertise additionalProperties false', () => {
    const allStrict = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), a: z.string() }).strict(),
        z.object({ kind: z.literal('b'), b: z.string() }).strict(),
      ]),
    );
    const mixed = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), a: z.string() }).strict(),
        z.object({ kind: z.literal('b'), b: z.string() }),
      ]),
    );
    expect(allStrict.additionalProperties).toBe(false);
    expect(mixed.additionalProperties).toEqual({});
  });

  test('plain unions remain unions', () => {
    const schema = flatten(z.union([z.string(), z.number()]));
    expect(Array.isArray(schema.anyOf)).toBe(true);
  });

  test('an optional discriminator is not flattened into a required field', () => {
    const schema = flattenToolJsonSchema({
      oneOf: [
        {
          type: 'object',
          properties: { kind: { const: 'a' }, value: { type: 'string' } },
          required: ['value'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'b' }, count: { type: 'number' } },
          required: ['kind', 'count'],
        },
      ],
    });
    expect(Array.isArray(schema.oneOf)).toBe(true);
  });

  test('a shared discriminator description survives projection', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a').describe('Operation kind'), value: z.string() }),
        z.object({ kind: z.literal('b').describe('Operation kind'), count: z.number() }),
      ]),
    );
    expect(field(schema, 'kind').description).toBe('Operation kind');
  });

  test('nullable collided fields stay typed without a nested union keyword', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), value: z.number().nullable() }),
        z.object({ kind: z.literal('b'), value: z.number().nullable() }),
      ]),
    );
    expect(field(schema, 'value').type).toEqual(['number', 'null']);
    expect(field(schema, 'value').anyOf).toBeUndefined();
  });

  test('nullable literals widen enough to keep null valid', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), value: z.literal('x').nullable() }),
        z.object({ kind: z.literal('b'), value: z.literal('x').nullable() }),
      ]),
    );
    expect(field(schema, 'value').type).toEqual(['string', 'null']);
    expect(field(schema, 'value').const).toBeUndefined();
    expect(field(schema, 'value').enum).toEqual(['x', null]);
  });

  test('ordinary nullable enums outside a projected DU keep their schema', () => {
    const schema = flatten(z.object({ status: z.enum(['draft', 'live']).nullable() }));
    expect(Array.isArray(field(schema, 'status').anyOf)).toBe(true);
  });
});
