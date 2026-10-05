import { describe, expect, test } from 'bun:test';
import { asSchema } from 'ai';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { isRecord } from '../src/internal/typed';
import { mountAgent } from '../src/tools/agent';
import { buildToolManifest } from '../src/tools/manifest';

const media = z.object({ id: z.string() });
const part = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('message'), media: media.optional() }),
  z.object({ kind: z.literal('mediaGroup'), media: z.array(media).min(2).max(10) }),
]);

function surface(input: z.ZodType) {
  const received: unknown[] = [];
  const service = implement(
    defineContract(
      { prefix: 'projection' },
      {
        run: {
          method: 'POST',
          path: '/',
          desc: 'Project an input',
          input,
          tool: { name: 'project_input' },
        },
      },
    ),
    { run: (context) => void received.push(context.input) },
  );
  const [manifest] = buildToolManifest({
    services: [service],
    transport: 'AGENT',
    flattenUnionInput: true,
  });
  const mounted = mountAgent(service, { flattenUnionInput: true }).project_input;
  if (!manifest || !mounted) throw new Error('expected manifest and mounted tool');
  return { manifest: manifest.inputSchema, mounted, received };
}

function field(schema: unknown, name: string): Record<string, unknown> {
  if (!isRecord(schema) || !isRecord(schema.properties)) throw new Error('expected object');
  const value = schema.properties[name];
  if (!isRecord(value)) throw new Error(`missing field ${name}`);
  return value;
}

function branches(schema: Record<string, unknown>): Record<string, unknown>[] {
  if (!Array.isArray(schema.anyOf)) throw new Error('expected structural alternatives');
  return schema.anyOf.map((branch) => {
    if (!isRecord(branch)) throw new Error('expected schema branch');
    return branch;
  });
}

function expectTypedArrays(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) expectTypedArrays(item);
  } else if (isRecord(node)) {
    if (node.type === 'array' || (Array.isArray(node.type) && node.type.includes('array'))) {
      expect(node.items).toBeDefined();
      expect(node.items).not.toEqual({});
    }
    for (const child of Object.values(node)) expectTypedArrays(child);
  }
}

describe('flattened tool surfaces retain structural alternatives', () => {
  test('manifest and mountAgent preserve object properties and typed array items', async () => {
    const { manifest, mounted } = surface(z.object({ part }));
    const mountedSchema = await asSchema(mounted.inputSchema).jsonSchema;
    for (const schema of [manifest, mountedSchema]) {
      expectTypedArrays(schema);
      const projected = field(schema, 'part');
      const variants = branches(field(projected, 'media'));
      expect(variants).toHaveLength(2);
      expect(variants).toEqual(
        expect.arrayContaining([
          { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
          {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
            minItems: 2,
            maxItems: 10,
          },
        ]),
      );
      expect(projected.required).toEqual(['kind']);
      expect(field(projected, 'media').description).toBe(
        'Available if kind = message | mediaGroup. Required if kind = mediaGroup',
      );
      expectTypedArrays(schema);
    }
  });

  test('different item schemas and nested arrays remain typed and accept both variants', () => {
    const input = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('ids'), values: z.array(z.array(media)).min(1) }),
      z.object({ kind: z.literal('counts'), values: z.array(z.array(z.number().int())) }),
    ]);
    const { manifest } = surface(input);
    const variants = branches(field(manifest, 'values'));
    expect(variants).toHaveLength(2);
    expect(variants.find((variant) => variant.minItems === 1)).toMatchObject({
      items: { items: { properties: { id: { type: 'string' } } } },
    });
    expect(variants.find((variant) => variant.minItems === undefined)).toMatchObject({
      items: { items: { type: 'integer' } },
    });
    expectTypedArrays(manifest);
    const advertised = z.fromJSONSchema(manifest);
    for (const value of [
      { kind: 'ids', values: [[{ id: 'a' }]] },
      { kind: 'counts', values: [[1, 2]] },
      { kind: 'counts', values: [] },
    ]) {
      expect(input.safeParse(value).success).toBe(true);
      expect(advertised.safeParse(value).success).toBe(true);
    }
  });

  test('nullable and optional structural variants retain null and requiredness', () => {
    const input = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('one'), value: media.nullable().optional() }),
      z.object({ kind: z.literal('many'), value: z.array(media).nullable() }),
    ]);
    const { manifest } = surface(input);
    expect(branches(field(manifest, 'value')).map((branch) => branch.type)).toEqual([
      ['array', 'null'],
      ['object', 'null'],
    ]);
    expectTypedArrays(manifest);
    const advertised = z.fromJSONSchema(manifest);
    for (const value of [
      { kind: 'one' },
      { kind: 'one', value: null },
      { kind: 'one', value: { id: 'a' } },
      { kind: 'many', value: null },
      { kind: 'many', value: [{ id: 'b' }] },
    ]) {
      expect(input.safeParse(value).success).toBe(true);
      expect(advertised.safeParse(value).success).toBe(true);
    }
  });

  test('same-kind object collisions retain each property set without requiring both', () => {
    const input = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('id'), value: media }),
      z.object({ kind: z.literal('name'), value: z.object({ name: z.string() }) }),
    ]);
    const { manifest } = surface(input);
    const variants = branches(field(manifest, 'value'));
    expect(variants[0]).toMatchObject({
      properties: { id: { type: 'string' } },
      required: ['id'],
    });
    expect(variants[1]).toMatchObject({
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    const advertised = z.fromJSONSchema(manifest);
    expect(advertised.safeParse({ kind: 'id', value: { id: 'a' } }).success).toBe(true);
    expect(advertised.safeParse({ kind: 'name', value: { name: 'b' } }).success).toBe(true);
  });

  test('top-level union remains an object and execution keeps the original discriminator validation', async () => {
    const { manifest, mounted, received } = surface(part);
    expect(manifest.type).toBe('object');
    expect(manifest.oneOf).toBeUndefined();
    expect(manifest.anyOf).toBeUndefined();
    expect(field(manifest, 'kind').enum).toEqual(['message', 'mediaGroup']);
    const run = mounted.execute;
    if (typeof run !== 'function') throw new Error('expected executable tool');
    const execute = (value: unknown) =>
      Reflect.apply(run, undefined, [value, { toolCallId: 'projection', messages: [] }]);
    await execute({ kind: 'message' });
    await execute({ kind: 'mediaGroup', media: [{ id: 'a' }, { id: 'b' }] });
    expect(received).toHaveLength(2);
    for (const value of [
      { kind: 'mediaGroup', media: { id: 'a' } },
      { kind: 'message', media: [{ id: 'a' }, { id: 'b' }] },
      { kind: 'mediaGroup', media: [{ id: 'a' }] },
      { kind: 'mediaGroup' },
    ]) {
      await expect(execute(value)).rejects.toMatchObject({
        output: { error: 'VALIDATION_ERROR' },
      });
      expect(received).toHaveLength(2);
    }
  });
});
