import { expect, test } from 'bun:test';
import { z } from 'zod';
import { zodObjectFromJsonSchema } from '../src/tools/connections/runtime';
import { parseToolCallArguments } from '../src/tools/execute-args';
import { localVerdict } from '../src/tools/schema/json-schema-origin';

function failure(schema: z.ZodType, value: unknown): z.ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error('Expected this control to fail validation');
  return result.error;
}

function restore(schema: z.ZodObject): z.ZodObject {
  return zodObjectFromJsonSchema(z.toJSONSchema(schema));
}

test.each([
  { name: 'datetime', field: z.iso.datetime(), value: '2026-10-12' },
  { name: 'email', field: z.email(), value: 'missing-at' },
  { name: 'URL', field: z.url(), value: 'relative-path' },
  { name: 'UUID', field: z.uuid(), value: 'not-a-uuid' },
  { name: 'pattern', field: z.string().regex(/^item_[0-9]+$/), value: 'wrong' },
])('a restored $name refusal belongs to the remote', ({ field, value }) => {
  const schema = restore(z.strictObject({ value: field }));
  const error = failure(schema, { value });
  expect(error.issues.every((issue) => issue.code === 'invalid_format')).toBe(true);
  expect(localVerdict(schema, error)).toBeNull();
});

test('nested arrays, optional fields and record values leave their formats to the remote', () => {
  const schema = restore(
    z.object({
      rows: z.array(z.object({ at: z.iso.datetime().nullable() })).optional(),
      values: z.record(z.string(), z.email()),
    }),
  );
  const error = failure(schema, {
    rows: [{ at: '2026-10-12' }, { at: null }],
    values: { first: 'wrong' },
  });
  expect(error.issues.map((issue) => issue.path)).toContainEqual(['rows', 0, 'at']);
  expect(error.issues.map((issue) => issue.path)).toContainEqual(['values', 'first']);
  expect(localVerdict(schema, error)).toBeNull();
});

test('format-only record key containers belong to the remote', () => {
  const schema = restore(z.object({ values: z.record(z.email(), z.string()) }));
  const error = failure(schema, { values: { wrong: 'value' } });
  expect(error.issues.map((issue) => issue.code)).toEqual(['invalid_key']);
  expect(localVerdict(schema, error)).toBeNull();
});

test('a mixed record key retains its bounds and metadata without format children', () => {
  const schema = restore(z.object({ values: z.record(z.email().min(10), z.string()) }));
  const error = failure(schema, { values: { bad: 'value' } });
  const original = error.issues[0];
  if (original?.code !== 'invalid_key') throw new Error('Expected a record key refusal');
  const refused = localVerdict(schema, error);
  const issue = refused?.issues[0];
  if (issue?.code !== 'invalid_key') throw new Error('Expected retained key bounds');
  expect(refused).not.toBe(error);
  expect(refused?.issues).toHaveLength(1);
  expect(issue).toEqual({
    ...original,
    issues: original.issues.filter((child) => child.code === 'too_small'),
  });
  expect(issue.issues.map((child) => child.code)).toEqual(['too_small']);
  expect(original.issues.some((child) => child.code === 'invalid_format')).toBe(true);
});

test('a structural record key keeps its original error and issue identity', () => {
  const schema = restore(z.object({ values: z.record(z.string().min(10), z.number()) }));
  const error = failure(schema, { values: { short: 1 } });
  expect(error.issues[0]?.code).toBe('invalid_key');
  expect(localVerdict(schema, error)).toBe(error);
  expect(localVerdict(schema, error)?.issues[0]).toBe(error.issues[0]);
});

test('reported structural issues keep their order and paths beside format and union failures', () => {
  const schema = restore(
    z.strictObject({
      at: z.iso.datetime(),
      branch: z.union([z.string(), z.number()]),
      mode: z.enum(['safe', 'fast']),
      required: z.string(),
      rows: z.array(z.iso.datetime()),
    }),
  );
  const error = failure(schema, {
    at: '2026-10-12',
    branch: false,
    mode: 'unknown',
    rows: ['2026-10-12', 123],
    extra: true,
  });
  const expected = error.issues.filter(
    (issue) => issue.code !== 'invalid_format' && issue.code !== 'invalid_union',
  );
  expect(expected.map((issue) => issue.code)).toEqual([
    'invalid_value',
    'invalid_type',
    'invalid_type',
    'unrecognized_keys',
  ]);
  expect(localVerdict(schema, error)?.issues).toEqual(expected);
  expect(localVerdict(schema, error)?.issues.map((issue) => issue.path)).toEqual([
    ['mode'],
    ['required'],
    ['rows', 1],
    [],
  ]);
});

test('enum keys and scalar bounds remain local', () => {
  for (const [schema, value] of [
    [restore(z.object({ key: z.string().min(3) })), { key: '' }],
    [restore(z.object({ count: z.number().min(1) })), { count: 0 }],
    [
      restore(z.object({ values: z.record(z.enum(['allowed']), z.string()) })),
      { values: { extra: 'x' } },
    ],
  ] satisfies Array<[z.ZodObject, unknown]>) {
    const error = failure(schema, value);
    expect(localVerdict(schema, error)).toBe(error);
  }
});

test('an authored schema keeps its entire verdict and parses transforms once', () => {
  let transforms = 0;
  const schema = z.object({
    at: z.iso.datetime({ error: 'Use a full UTC timestamp' }),
    key: z.string(),
    count: z.number().transform((value) => {
      transforms += 1;
      return value + 1;
    }),
  });
  const args = { at: '2026-10-12', count: 1 };
  const error = failure(schema, args);
  expect(localVerdict(schema, error)).toBe(error);
  expect(error.issues.map((issue) => issue.code)).toEqual(['invalid_format', 'invalid_type']);
  transforms = 0;
  const result = parseToolCallArguments(
    {
      serviceName: 'local',
      key: 'check',
      desc: 'Check local arguments',
      method: 'POST',
      inputSchema: schema,
      handler: () => undefined,
    },
    args,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('The authored schema must refuse locally');
  expect(result.message).toContain('Use a full UTC timestamp');
  expect(result.message).toContain('key');
  expect(transforms).toBe(1);
});

test('delegation forwards coerced arguments rather than partially parsed defaults', () => {
  const schema = restore(
    z.object({ rows: z.array(z.iso.datetime()), limit: z.number().default(5) }),
  );
  const result = parseToolCallArguments(
    {
      serviceName: 'remote',
      key: 'check',
      desc: 'Check remote arguments',
      method: 'POST',
      inputSchema: schema,
      handler: () => undefined,
    },
    { rows: '["2026-10-12"]' },
    { coerceJson: true },
  );
  expect(result).toEqual({ ok: true, params: undefined, input: { rows: ['2026-10-12'] } });
});
