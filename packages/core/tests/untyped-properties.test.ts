/**
 * `requireTypedProperties` — the guard a consuming project runs on its own
 * contracts. The framework ships none, so a build-time check here could never
 * have caught the incident; this is the shape that can. → ADR 0044.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { findUntypedProperties, validateMcpSchemas } from '../src/tools';

const contract = (input: z.ZodType) =>
  defineContract(
    { prefix: 'broadcast' },
    {
      patch: {
        method: 'POST',
        path: '/patch',
        desc: 'Patch a broadcast',
        input: z.object({ operations: z.array(input) }),
        output: z.object({ ok: z.boolean() }),
        expose: ['MCP'],
        toolName: 'broadcast_patch',
      },
    },
  );

const service = (input: z.ZodType) =>
  implement(contract(input), { patch: () => ({ ok: true }) });

describe('findUntypedProperties', () => {
  test('flags a property with only a description', () => {
    expect(
      findUntypedProperties({ properties: { partIndex: { description: 'Required if …' } } }),
    ).toEqual([{ path: 'partIndex', description: 'Required if …' }]);
  });

  test('accepts anything that says what it is', () => {
    expect(
      findUntypedProperties({
        properties: {
          a: { type: 'integer' },
          b: { enum: ['x'] },
          c: { $ref: '#/$defs/X' },
          d: { anyOf: [{ type: 'string' }] },
          e: { const: 3 },
        },
      }),
    ).toEqual([]);
  });

  test('walks past an intersection root, which has no top-level properties', () => {
    const found = findUntypedProperties({
      allOf: [{ properties: { blind: { description: 'nothing' } } }, { type: 'object' }],
    });
    expect(found.map((f) => f.path)).toEqual(['blind']);
  });

  test('walks into items, additionalProperties and both definition containers', () => {
    const found = findUntypedProperties({
      properties: { list: { type: 'array', items: { properties: { a: {} } } } },
      additionalProperties: { properties: { b: {} } },
      $defs: { X: { properties: { c: {} } } },
      definitions: { Y: { properties: { d: {} } } },
    });
    expect(found.map((f) => f.path).sort()).toEqual(['b', 'c', 'd', 'list.a']);
  });
});

describe('validateMcpSchemas({ requireTypedProperties })', () => {
  /** A field JSON Schema cannot describe at all — the honest untyped case. */
  const freeForm = z.object({ payload: z.unknown().describe('free-form blob') });

  test('off by default — a contract with an unknown field still mounts', () => {
    expect(() =>
      validateMcpSchemas([service(freeForm)], 'throw', undefined, { flattenUnionInput: true }),
    ).not.toThrow();
  });

  test('on, it names the property, the tool and the clue the model was given', () => {
    expect(() =>
      validateMcpSchemas([service(freeForm)], 'throw', undefined, {
        flattenUnionInput: true,
        requireTypedProperties: true,
      }),
    ).toThrow(/broadcast_patch.*operations\.payload.*free-form blob/s);
  });

  test('a deliberately free-form field can be listed and stops being a finding', () => {
    expect(() =>
      validateMcpSchemas([service(freeForm)], 'throw', undefined, {
        flattenUnionInput: true,
        requireTypedProperties: true,
        allowUntyped: ['broadcast_patch.operations.payload'],
      }),
    ).not.toThrow();
  });

  test('a fully typed contract passes', () => {
    const typed = z.object({ partIndex: z.number().int().min(0), text: z.string() });
    expect(() =>
      validateMcpSchemas([service(typed)], 'throw', undefined, {
        flattenUnionInput: true,
        requireTypedProperties: true,
      }),
    ).not.toThrow();
  });

  test('the incident contract passes now, and would have failed before the fix', () => {
    // Before ADR 0044 the collided `partIndex` was advertised as a bare
    // description; the guard is what turns that into a failed build rather than
    // sixteen retries in production.
    const operations = z.discriminatedUnion('op', [
      z.object({ op: z.literal('setText'), partIndex: z.number().int().min(0) }),
      z.object({ op: z.literal('setButton'), partIndex: z.number().int().min(0) }),
    ]);
    expect(() =>
      validateMcpSchemas([service(operations)], 'throw', undefined, {
        flattenUnionInput: true,
        requireTypedProperties: true,
      }),
    ).not.toThrow();
  });

  test('a genuinely divergent collision is still reported, not hidden', () => {
    // Kinds that really differ stay `unknown` by design — the guard is what makes
    // that visible to the project instead of leaving it for a model to discover.
    const operations = z.discriminatedUnion('op', [
      z.object({ op: z.literal('a'), target: z.string() }),
      z.object({ op: z.literal('b'), target: z.number() }),
    ]);
    expect(() =>
      validateMcpSchemas([service(operations)], 'throw', undefined, {
        flattenUnionInput: true,
        requireTypedProperties: true,
      }),
    ).toThrow(/operations\.target/);
  });
});
