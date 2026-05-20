import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { coerceJsonArgs } from '../src/tools/coerce';
import { executeToolMethod } from '../src/tools/execute';
import { flattenDiscriminatedUnion } from '../src/tools/flatten';
import { buildToolManifest } from '../src/tools/manifest';
import { collectTools, formatToolError } from '../src/tools/mount';

// ─── Gap 1: JSON coercion ───────────────────────────────────────────────

describe('coerceJsonArgs', () => {
  test('coerces a JSON-stringified array field', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    expect(coerceJsonArgs({ tags: '["a","b"]' }, schema)).toEqual({ tags: ['a', 'b'] });
  });

  test('coerces a JSON-stringified object field', () => {
    const schema = z.object({ meta: z.object({ x: z.number() }) });
    expect(coerceJsonArgs({ meta: '{"x":42}' }, schema)).toEqual({ meta: { x: 42 } });
  });

  test('leaves string-typed fields untouched', () => {
    const schema = z.object({ name: z.string() });
    expect(coerceJsonArgs({ name: 'hello' }, schema)).toEqual({ name: 'hello' });
  });

  test('coerces through optional / nullable wrappers', () => {
    const schema = z.object({ tags: z.array(z.string()).optional() });
    expect(coerceJsonArgs({ tags: '["x"]' }, schema)).toEqual({ tags: ['x'] });
  });

  test('a non-JSON string for an array field is left for validation to reject', () => {
    const schema = z.object({ tags: z.array(z.string()) });
    expect(coerceJsonArgs({ tags: 'not-json' }, schema)).toEqual({ tags: 'not-json' });
  });

  test('already-parsed values pass through', () => {
    const schema = z.object({ items: z.array(z.number()) });
    expect(coerceJsonArgs({ items: [1, 2, 3] }, schema)).toEqual({ items: [1, 2, 3] });
  });

  test('strips prototype-pollution keys from a coerced object', () => {
    const schema = z.object({ meta: z.object({}).loose() });
    const out = coerceJsonArgs({ meta: '{"__proto__":{"x":1},"ok":2}' }, schema);
    expect(Object.getPrototypeOf(out.meta as object) === Object.prototype).toBe(true);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test('a non-object schema is returned unchanged', () => {
    const schema = z.array(z.string());
    expect(coerceJsonArgs({ a: '1' }, schema)).toEqual({ a: '1' });
  });
});

describe('coerceJsonArgs in the tool runner — schema stays clean', () => {
  const contract = defineContract(
    { prefix: '/test', scope: 'public' },
    {
      doThing: {
        method: 'POST',
        path: '/do',
        desc: 'Does a thing',
        input: z.object({ items: z.array(z.string()) }),
        output: z.object({ count: z.number() }),
      },
    },
  );
  const service = implement(contract, {
    doThing: (ctx) => ({ count: ctx.input.items.length }),
  });

  test('advertised schema keeps `required` (no preprocess wrapper)', () => {
    const [first] = collectTools(service, 'AGENT', {});
    if (!first) throw new Error('expected tool');
    const json = z.toJSONSchema(first.schema, { io: 'input' });
    expect(json.required).toEqual(['items']);
  });

  test('executeToolMethod coerces a stringified array when coerceJson is on', async () => {
    const method = service.methods.doThing;
    if (!method) throw new Error('expected method');
    const result = await executeToolMethod(
      method,
      'do_thing',
      { items: '["a","b"]' },
      { source: 'agent' },
      undefined,
      undefined,
      true,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ count: 2 });
  });

  test('executeToolMethod does not coerce when coerceJson is off', async () => {
    const method = service.methods.doThing;
    if (!method) throw new Error('expected method');
    const result = await executeToolMethod(
      method,
      'do_thing',
      { items: '["a","b"]' },
      { source: 'agent' },
    );
    expect(result.ok).toBe(false);
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
    const [first] = collectTools(service, 'MCP', { flattenUnionInput: false });
    if (!first) throw new Error('expected tool');
    expect(first.schema).not.toBeInstanceOf(z.ZodObject);
  });

  test('with flatten — schema becomes ZodObject', () => {
    const [first] = collectTools(service, 'MCP', { flattenUnionInput: true });
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
    const tools = collectTools(service, 'AGENT', {});
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
    const tools = collectTools(service, 'AGENT', {});
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
