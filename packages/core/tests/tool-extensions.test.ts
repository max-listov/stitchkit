import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/server/implement';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';
import { executeToolMethod } from '../src/tools/execute';
import { buildToolManifest } from '../src/tools/manifest';
import { collectTools, formatToolError } from '../src/tools/mount';
import { coerceJsonArgs } from '../src/tools/schema/coerce';

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

  test('coerces native records and object guards restored from JSON Schema', () => {
    const record = z.record(z.string(), z.unknown());
    const native = z.object({
      required: record,
      optional: record.optional(),
      nullable: record.nullable(),
    });
    const raw = {
      required: '{"code":"007"}',
      optional: '{"nested":{"enabled":true}}',
      nullable: '{"count":2}',
    };
    expect(native.parse(coerceJsonArgs(raw, native))).toEqual({
      required: { code: '007' },
      optional: { nested: { enabled: true } },
      nullable: { count: 2 },
    });

    const restored = zodObjectFromJsonSchema(z.toJSONSchema(native));
    expect(restored.shape.required).toBeInstanceOf(z.ZodPipe);
    const coerced = coerceJsonArgs(
      {
        required: '{"email":"cli-json@example.invalid","sentinel":"007"}',
        optional: '{"nested":{"enabled":true}}',
        nullable: '{"count":2}',
      },
      restored,
    );
    expect(restored.parse(coerced)).toEqual({
      required: { email: 'cli-json@example.invalid', sentinel: '007' },
      optional: { nested: { enabled: true } },
      nullable: { count: 2 },
    });
  });

  test('coerces restored object guards through read-only and allOf wrappers', () => {
    const restored = zodObjectFromJsonSchema({
      type: 'object',
      properties: {
        readOnly: {
          type: 'object',
          readOnly: true,
          propertyNames: { pattern: '^[a-z]+$' },
          additionalProperties: {},
        },
        composed: {
          type: 'object',
          propertyNames: { pattern: '^[a-z]+$' },
          additionalProperties: {},
          allOf: [
            {
              type: 'object',
              properties: {
                nested: {
                  type: 'object',
                  properties: { code: { type: 'string' } },
                  required: ['code'],
                },
              },
              required: ['nested'],
            },
          ],
        },
      },
      required: ['readOnly', 'composed'],
    });
    const coerced = coerceJsonArgs(
      {
        readOnly: '{"ok":"007"}',
        composed: '{"nested":{"code":"007"}}',
      },
      restored,
    );
    expect(restored.parse(coerced)).toEqual({
      readOnly: { ok: '007' },
      composed: { nested: { code: '007' } },
    });
    expect(() =>
      restored.parse(
        coerceJsonArgs(
          { readOnly: '{"Bad":1}', composed: '{"nested":{"code":"007"}}' },
          restored,
        ),
      ),
    ).toThrow('Invalid key in record');
  });

  test('does not run or borrow structure from a lookalike application transform pipe', async () => {
    let transforms = 0;
    const applicationPipe = z
      .transform((value) => {
        transforms++;
        return value;
      })
      .check(() => undefined)
      .pipe(z.object({ code: z.string() }))
      .meta({ propertyNames: { type: 'string' } });
    const raw = { data: '{"code":"007"}' };
    const input = z.object({ data: applicationPipe });
    expect(coerceJsonArgs(raw, input)).toEqual(raw);
    expect(transforms).toBe(0);

    let calls = 0;
    const service = implement(
      defineContract(
        { prefix: '/application-pipe', scope: 'public' },
        {
          run: {
            method: 'POST',
            path: '/',
            desc: 'Run',
            input,
            output: z.object({ ok: z.boolean() }),
          },
        },
      ),
      {
        run: () => {
          calls++;
          return { ok: true };
        },
      },
    );
    const method = service.methods.run;
    if (!method) throw new Error('expected method');
    const result = await executeToolMethod(
      method,
      { toolName: 'run', rawArgs: raw, context: { source: 'agent' } },
      { coerceJson: true },
    );
    expect(result.ok).toBe(false);
    expect(transforms).toBe(1);
    expect(calls).toBe(0);
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

  test('a list written as text in a string-or-array field is refused by name, at any depth', () => {
    const field = z.union([z.string(), z.array(z.string()).max(3)]);
    expect(() => coerceJsonArgs({ names: '["a","b"]' }, z.object({ names: field }))).toThrow(
      'names is a list written as text',
    );
    expect(() =>
      coerceJsonArgs(
        { rows: [{ names: ' ["a"]' }] },
        z.object({ rows: z.array(z.object({ names: field.optional() })) }),
      ),
    ).toThrow('rows.0.names is a list written as text');
    expect(() => coerceJsonArgs({ names: '[]' }, z.object({ names: field }))).toThrow(
      'names is a list written as text',
    );
  });

  test('a string that is not a list the array member accepts stays one plain value', () => {
    const field = z.union([z.string(), z.array(z.string()).max(1)]);
    const schema = z.object({
      names: field,
      pick: z.union([z.string(), z.array(z.number())]),
    });
    for (const value of ['[preview].png', 'plain', '["a","b"]', '[1,2', '[{"a":1}]', '123']) {
      expect(coerceJsonArgs({ names: value, pick: 'x' }, schema)).toEqual({
        names: value,
        pick: 'x',
      });
    }
    expect(coerceJsonArgs({ names: 'a', pick: '["a"]' }, schema)).toEqual({
      names: 'a',
      pick: '["a"]',
    });
    expect(() => coerceJsonArgs({ names: 'a', pick: '[1,2]' }, schema)).toThrow(
      'pick is a list written as text',
    );
  });

  test('every tool surface reports the refusal as a validation error', async () => {
    const method = {
      ...implement(
        defineContract(
          { prefix: '/list', scope: 'public' },
          {
            find: {
              method: 'POST',
              path: '/find',
              desc: 'Find',
              input: z.object({ names: z.union([z.string(), z.array(z.string())]) }),
              output: z.object({ ok: z.boolean() }),
            },
          },
        ),
        { find: () => ({ ok: true }) },
      ).methods,
    }.find;
    if (!method) throw new Error('expected method');
    const result = await executeToolMethod(
      method,
      { toolName: 'find', rawArgs: { names: '["a","b"]' }, context: { source: 'agent' } },
      { coerceJson: true },
    );
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
    expect(JSON.stringify(result)).toContain('names is a list written as text');
    const kept = await executeToolMethod(
      method,
      { toolName: 'find', rawArgs: { names: 'a.png' }, context: { source: 'agent' } },
      { coerceJson: true },
    );
    expect(kept.ok).toBe(true);
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
      { toolName: 'do_thing', rawArgs: { items: '["a","b"]' }, context: { source: 'agent' } },
      { coerceJson: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ count: 2 });
  });

  test('executeToolMethod does not coerce when coerceJson is off', async () => {
    const method = service.methods.doThing;
    if (!method) throw new Error('expected method');
    const result = await executeToolMethod(method, {
      toolName: 'do_thing',
      rawArgs: { items: '["a","b"]' },
      context: { source: 'agent' },
    });
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
    const result = await executeToolMethod(method, {
      toolName: 'test_process',
      rawArgs: { items: ['a', 'b'] },
      context: { source: 'agent' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toEqual({ count: 2 });
  });
});
