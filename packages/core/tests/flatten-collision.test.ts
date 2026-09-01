import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { isRecord } from '../src/internal/typed';
import { flattenToolJsonSchema } from '../src/tools/flatten';
import { toJsonSchema } from '../src/tools/json-schema';
import { findUntypedProperties } from '../src/tools/untyped-properties';

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

  test('keeps every known kind in an object-vs-array collision', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('one'), media: z.object({ id: z.string() }) }),
        z.object({ kind: z.literal('many'), media: z.array(z.object({ id: z.string() })) }),
      ]),
    );
    expect(field(schema, 'media')).toEqual({ type: ['object', 'array'] });
    expect(findUntypedProperties(schema)).toEqual([]);
  });

  test('recognises the base kind of a nested object union', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('link'), target: z.string() }),
        z.object({
          kind: z.literal('select'),
          target: z.union([
            z.object({ names: z.array(z.string()) }),
            z.object({ pattern: z.string() }),
          ]),
        }),
      ]),
    );
    expect(field(schema, 'target')).toEqual({ type: ['string', 'object'] });
    expect(findUntypedProperties(schema)).toEqual([]);
  });

  test('projects different nested object unions to one loose object kind', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({
          kind: z.literal('first'),
          value: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
        }),
        z.object({
          kind: z.literal('second'),
          value: z.union([z.object({ c: z.boolean() }), z.object({ d: z.array(z.string()) })]),
        }),
      ]),
    );
    expect(field(schema, 'value')).toEqual({ type: 'object', additionalProperties: {} });
  });

  test('retains null alongside every divergent non-null kind', () => {
    const schema = flatten(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('one'), value: z.string().nullable() }),
        z.object({ kind: z.literal('many'), value: z.array(z.string()).nullable() }),
      ]),
    );
    expect(field(schema, 'value')).toEqual({ type: ['string', 'array', 'null'] });
  });

  test('derives divergent kinds from const and enum values', () => {
    const schema = flattenToolJsonSchema({
      oneOf: [
        {
          type: 'object',
          properties: { kind: { const: 'number' }, value: { const: 1 } },
          required: ['kind', 'value'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'boolean' }, value: { enum: [true, false] } },
          required: ['kind', 'value'],
        },
      ],
    });
    expect(field(schema, 'value')).toEqual({ type: ['number', 'boolean'] });
  });

  test('does not guess through an unresolved reference', () => {
    const schema = flattenToolJsonSchema({
      oneOf: [
        {
          type: 'object',
          properties: { kind: { const: 'known' }, value: { type: 'string' } },
          required: ['kind', 'value'],
        },
        {
          type: 'object',
          properties: { kind: { const: 'reference' }, value: { $ref: '#/$defs/value' } },
          required: ['kind', 'value'],
        },
      ],
      $defs: { value: { type: 'object' } },
    });
    expect(field(schema, 'value').type).toBeUndefined();
    expect(findUntypedProperties(schema).map((finding) => finding.path)).toContain('value');
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

  test('a plain union is passed through, not joined into an object', () => {
    // The join exists for discriminated unions of objects; a union of scalars
    // has nothing to join. The guard is that flatten returns it **unchanged**,
    // asserted against its own input rather than against a shape zod happens to
    // emit — 4.5 writes this union as `type: ['string','number']` where 4.4
    // wrote `anyOf`. Both are unions, and neither is flatten's business.
    const input = toJsonSchema(z.union([z.string(), z.number()]), 'input', 'any');
    expect(flattenToolJsonSchema(input)).toEqual(input);
    expect(flattenToolJsonSchema(input).type).not.toBe('object');
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
