import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { withJsonCoercion } from '../src/tools/coerce';
import { executeToolMethod } from '../src/tools/execute';
import { flattenDiscriminatedUnion } from '../src/tools/flatten';
import { buildToolManifest } from '../src/tools/manifest';
import { collectTools, formatToolError } from '../src/tools/mount';

// ─── Gap 1: JSON coercion ───────────────────────────────────────────────

describe('withJsonCoercion', () => {
  test('coerces JSON-stringified array', () => {
    const schema = withJsonCoercion(z.object({ tags: z.array(z.string()) }));
    const result = schema.safeParse({ tags: '["a","b"]' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tags).toEqual(['a', 'b']);
  });

  test('coerces JSON-stringified object', () => {
    const schema = withJsonCoercion(z.object({ meta: z.object({ x: z.number() }) }));
    const result = schema.safeParse({ meta: '{"x":42}' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.meta).toEqual({ x: 42 });
  });

  test('leaves string fields untouched', () => {
    const schema = withJsonCoercion(z.object({ name: z.string() }));
    const result = schema.safeParse({ name: 'hello' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe('hello');
  });

  test('preserves optional wrapper', () => {
    const schema = withJsonCoercion(z.object({ tags: z.array(z.string()).optional() }));
    const withValue = schema.safeParse({ tags: '["x"]' });
    expect(withValue.success).toBe(true);
    if (withValue.success) expect(withValue.data.tags).toEqual(['x']);

    const without = schema.safeParse({});
    expect(without.success).toBe(true);
    if (without.success) expect(without.data.tags).toBeUndefined();
  });

  test('preserves nullable wrapper', () => {
    const schema = withJsonCoercion(
      z.object({ data: z.object({ a: z.number() }).nullable() }),
    );
    const withNull = schema.safeParse({ data: null });
    expect(withNull.success).toBe(true);
    if (withNull.success) expect(withNull.data.data).toBeNull();
  });

  test('non-JSON string stays as-is for array field', () => {
    const schema = withJsonCoercion(z.object({ tags: z.array(z.string()) }));
    const result = schema.safeParse({ tags: 'not-json' });
    expect(result.success).toBe(false);
  });

  test('already-parsed values pass through', () => {
    const schema = withJsonCoercion(z.object({ items: z.array(z.number()) }));
    const result = schema.safeParse({ items: [1, 2, 3] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.items).toEqual([1, 2, 3]);
  });
});

describe('coerceJsonArgs in collectTools', () => {
  const contract = defineContract(
    { prefix: '/test', scope: 'public' },
    {
      doThing: {
        method: 'POST',
        path: '/do',
        desc: 'Does a thing',
        input: z.object({ items: z.array(z.string()) }),
      },
    },
  );
  const service = implement(contract, {
    doThing: () => undefined,
  });

  test('coercion enabled by default', () => {
    const [first] = collectTools(service, 'AGENT', {});
    if (!first) throw new Error('expected tool');
    const result = (first.schema as z.ZodObject<z.ZodRawShape>).safeParse({
      items: '["a","b"]',
    });
    expect(result.success).toBe(true);
  });

  test('coercion disabled when coerceJsonArgs=false', () => {
    const [first] = collectTools(service, 'AGENT', { coerceJsonArgs: false });
    if (!first) throw new Error('expected tool');
    const result = (first.schema as z.ZodObject<z.ZodRawShape>).safeParse({
      items: '["a","b"]',
    });
    expect(result.success).toBe(false);
  });
});

// ─── Gap 2: Discriminated union flatten ─────────────────────────────────

describe('flattenDiscriminatedUnion', () => {
  const union = z.discriminatedUnion('type', [
    z.object({ type: z.literal('setMeta'), title: z.string() }),
    z.object({ type: z.literal('addPart'), content: z.string(), position: z.number() }),
    z.object({ type: z.literal('removePart'), partId: z.string() }),
  ]);

  test('flattens to single object with enum discriminator', () => {
    const flat = flattenDiscriminatedUnion(union);
    expect(flat).toBeInstanceOf(z.ZodObject);

    const shape = flat.shape;
    expect(shape.type).toBeInstanceOf(z.ZodEnum);
  });

  test('all variant fields present as optional', () => {
    const flat = flattenDiscriminatedUnion(union);
    const shape = flat.shape;
    expect('title' in shape).toBe(true);
    expect('content' in shape).toBe(true);
    expect('position' in shape).toBe(true);
    expect('partId' in shape).toBe(true);
  });

  test('parses valid variant data', () => {
    const flat = flattenDiscriminatedUnion(union);
    const result = flat.safeParse({ type: 'setMeta', title: 'Hello' });
    expect(result.success).toBe(true);
  });

  test('parses variant without other variant fields', () => {
    const flat = flattenDiscriminatedUnion(union);
    const result = flat.safeParse({ type: 'removePart', partId: 'abc' });
    expect(result.success).toBe(true);
  });

  test('enum includes all discriminator values', () => {
    const flat = flattenDiscriminatedUnion(union);
    const typeField = flat.shape.type;
    expect(typeField).toBeInstanceOf(z.ZodEnum);
    const values = (typeField as z.ZodEnum).def.entries;
    expect(Object.keys(values)).toContain('setMeta');
    expect(Object.keys(values)).toContain('addPart');
    expect(Object.keys(values)).toContain('removePart');
  });

  test('throws on empty union', () => {
    expect(() => flattenDiscriminatedUnion(z.discriminatedUnion('t', [] as never))).toThrow();
  });
});

describe('flattenUnionInput in collectTools', () => {
  const contract = defineContract(
    { prefix: '/test', scope: 'public' },
    {
      patch: {
        method: 'POST',
        path: '/patch',
        desc: 'Patch operation',
        input: z.discriminatedUnion('type', [
          z.object({ type: z.literal('rename'), name: z.string() }),
          z.object({ type: z.literal('delete'), id: z.string() }),
        ]),
      },
    },
  );
  const service = implement(contract, { patch: () => undefined });

  test('without flatten — schema stays non-object', () => {
    const [first] = collectTools(service, 'MCP', {
      flattenUnionInput: false,
      coerceJsonArgs: false,
    });
    if (!first) throw new Error('expected tool');
    expect(first.schema).not.toBeInstanceOf(z.ZodObject);
  });

  test('with flatten — schema becomes ZodObject', () => {
    const [first] = collectTools(service, 'MCP', {
      flattenUnionInput: true,
      coerceJsonArgs: false,
    });
    if (!first) throw new Error('expected tool');
    expect(first.schema).toBeInstanceOf(z.ZodObject);
  });
});

// ─── Gap 3: Error hints ─────────────────────────────────────────────────

describe('formatToolError with errorHint', () => {
  const failedResult = {
    ok: false,
    code: 'SOME_ERROR',
    details: { message: 'oops' },
  } as const;

  test('no hints when no errorHint and no result.hint', () => {
    const err = formatToolError(failedResult);
    expect(err._hint).toBeUndefined();
  });

  test('result.hint only', () => {
    const err = formatToolError({ ...failedResult, hint: 'Try X' });
    expect(err._hint).toBe('Try X');
  });

  test('global errorHint only', () => {
    const hint = () => 'Global hint';
    const err = formatToolError(failedResult, 'my_tool', hint);
    expect(err._hint).toBe('Global hint');
  });

  test('both hints combined', () => {
    const hint = () => 'Global hint';
    const err = formatToolError({ ...failedResult, hint: 'Specific' }, 'my_tool', hint);
    expect(err._hint).toBe('Specific Global hint');
  });

  test('errorHint returns null — only result.hint', () => {
    const hint = () => null;
    const err = formatToolError({ ...failedResult, hint: 'Specific' }, 'my_tool', hint);
    expect(err._hint).toBe('Specific');
  });
});

// ─── Gap 4: Tool manifest ───────────────────────────────────────────────

describe('buildToolManifest', () => {
  const contract = defineContract(
    { prefix: '/items', scope: 'public' },
    {
      list: {
        method: 'GET',
        path: '/',
        desc: 'List all items',
        output: z.object({ items: z.array(z.string()) }),
      },
      create: {
        method: 'POST',
        path: '/',
        desc: 'Create an item',
        input: z.object({ name: z.string() }),
        output: z.object({ id: z.string() }),
      },
    },
  );
  const service = implement(contract, {
    list: () => ({ items: [] }),
    create: () => ({ id: '1' }),
  });

  test('returns manifest entries with name, description, inputSchema', () => {
    const tools = collectTools(service, 'AGENT', { coerceJsonArgs: false });
    const manifest = buildToolManifest(tools);

    expect(manifest).toHaveLength(2);
    const [first] = manifest;
    if (!first) throw new Error('expected entry');
    expect(first.name).toBeTruthy();
    expect(first.description).toBeTruthy();
    expect(first.inputSchema).toBeTruthy();
    expect(typeof first.inputSchema).toBe('object');
  });

  test('inputSchema is valid JSON Schema', () => {
    const tools = collectTools(service, 'AGENT', { coerceJsonArgs: false });
    const manifest = buildToolManifest(tools);
    const createEntry = manifest.find((e) => e.name.includes('create'));
    expect(createEntry).toBeDefined();
    if (createEntry) expect(createEntry.inputSchema.type).toBe('object');
  });

  test('empty tools → empty manifest', () => {
    const manifest = buildToolManifest([]);
    expect(manifest).toEqual([]);
  });
});

// ─── Integration: executeToolMethod with coerced schema ─────────────────

describe('executeToolMethod with JSON-coerced args (integration)', () => {
  const contract = defineContract(
    { prefix: '/test', scope: 'public' },
    {
      process: {
        method: 'POST',
        path: '/process',
        desc: 'Process items',
        input: z.object({ items: z.array(z.string()) }),
        output: z.object({ count: z.number() }),
      },
    },
  );
  const service = implement(contract, {
    process: (ctx) => ({ count: ctx.input.items.length }),
  });

  test('handler receives parsed array from JSON string', async () => {
    const method = service.methods.process;
    expect(method).toBeDefined();
    if (!method) return;
    const result = await executeToolMethod(
      method,
      'test_process',
      { items: ['a', 'b'] },
      { source: 'agent' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ count: 2 });
  });
});
