import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { coerceJsonArgs } from '../src/tools/coerce';
import { executeToolMethod } from '../src/tools/execute';
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
    const json = first.presentationSchema;
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

describe('flattenUnionInput presentation', () => {
  const union = z.discriminatedUnion('type', [
    z.object({ type: z.literal('setMeta'), title: z.string() }),
    z.object({ type: z.literal('addPart'), content: z.string(), position: z.number() }),
    z.object({ type: z.literal('removePart'), partId: z.string() }),
  ]);

  test('is compiled without changing the executable union', () => {
    const contract = defineContract(
      { prefix: 'union' },
      { run: { method: 'POST', path: '/', desc: 'Run', input: union } },
    );
    const [mounted] = collectTools(implement(contract, { run: () => undefined }), 'AGENT', {
      flattenUnionInput: true,
    });
    if (!mounted) throw new Error('expected tool');
    expect(mounted.argumentSchema).toBe(union);
    const text = JSON.stringify(mounted.presentationSchema);
    expect(text).toContain('setMeta');
    expect(text).toContain('addPart');
    expect(text).toContain('removePart');
    expect(text).not.toContain('oneOf');
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
    expect(first.argumentSchema).not.toBeInstanceOf(z.ZodObject);
    expect(JSON.stringify(first.presentationSchema)).toContain('oneOf');
  });

  test('with flatten — schema becomes ZodObject', () => {
    const [first] = collectTools(service, 'MCP', { flattenUnionInput: true });
    if (!first) throw new Error('expected tool');
    expect(first.argumentSchema).not.toBeInstanceOf(z.ZodObject);
    expect(JSON.stringify(first.presentationSchema)).not.toContain('oneOf');
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
    const manifest = buildToolManifest({ services: [service], transport: 'AGENT' });

    expect(manifest).toHaveLength(2);
    const [first] = manifest;
    if (!first) throw new Error('expected entry');
    expect(first.name).toBeTruthy();
    expect(first.description).toBeTruthy();
    expect(first.inputSchema).toBeTruthy();
    expect(typeof first.inputSchema).toBe('object');
  });

  test('inputSchema is valid JSON Schema', () => {
    const manifest = buildToolManifest({ services: [service], transport: 'AGENT' });
    const createEntry = manifest.find((e) => e.name.includes('create'));
    expect(createEntry).toBeDefined();
    if (createEntry) expect(createEntry.inputSchema.type).toBe('object');
  });

  test('empty tools → empty manifest', () => {
    const manifest = buildToolManifest({ transport: 'AGENT' });
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
