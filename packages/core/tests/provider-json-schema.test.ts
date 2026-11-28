import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  normalizeOpenAiJsonSchema,
  prepareAnthropicJsonSchema,
  stripStrictOptionalNulls,
} from '../src/agent-runtime/provider-json-schema';
import { toJsonSchema } from '../src/json-schema/json-schema';

describe('normalizeOpenAiJsonSchema (strict and loose modes)', () => {
  test('rewrites optional $ref, const, oneOf, enum (with and without type), and empty objects in strict mode', () => {
    const normalized = normalizeOpenAiJsonSchema(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          reqStr: { type: 'string' },
          optStr: { type: 'string' },
          optRef: { $ref: '#/$defs/Tag' },
          optConst: { const: 'fixed' },
          optOneOf: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          optEnumNoType: { enum: ['a', 'b'] },
          optEnumWithType: { type: 'string', enum: ['x', 'y'] },
          optAlreadyNull: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          emptyObj: { type: 'object' },
          lookaround: { type: 'string', pattern: '(?=foo)bar' },
        },
        required: ['reqStr'],
        $defs: {
          Tag: { type: 'object', properties: { label: { type: 'string' } } },
        },
      },
      true,
    );

    expect(normalized.$schema).toBeUndefined();
    expect(normalized.additionalProperties).toBe(false);
    expect(normalized.required).toEqual([
      'reqStr',
      'optStr',
      'optRef',
      'optConst',
      'optOneOf',
      'optEnumNoType',
      'optEnumWithType',
      'optAlreadyNull',
      'emptyObj',
      'lookaround',
    ]);
    const props = normalized.properties as Record<string, unknown>;
    expect(props.reqStr).toEqual({ type: 'string' });
    expect(props.optStr).toEqual({ type: ['string', 'null'] });
    expect(props.optRef).toEqual({ anyOf: [{ $ref: '#/$defs/Tag' }, { type: 'null' }] });
    expect(props.optConst).toEqual({ anyOf: [{ const: 'fixed' }, { type: 'null' }] });
    expect(props.optOneOf).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }],
    });
    expect(props.optEnumNoType).toEqual({ enum: ['a', 'b', null] });
    expect(props.optEnumWithType).toEqual({
      type: ['string', 'null'],
      enum: ['x', 'y', null],
    });
    // Already nullable anyOf must NOT receive a duplicate { type: 'null' } branch
    expect(props.optAlreadyNull).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    // Empty object gets properties:{}, required:[], additionalProperties:false and becomes nullable because optional
    expect(props.emptyObj).toEqual({
      type: ['object', 'null'],
      properties: {},
      required: [],
      additionalProperties: false,
    });
    // Lookaround regex stripped
    expect(props.lookaround).toEqual({ type: ['string', 'null'] });
    // Nested $defs object also normalized strictly
    expect((normalized.$defs as Record<string, unknown>).Tag).toEqual({
      type: 'object',
      properties: { label: { type: ['string', 'null'] } },
      required: ['label'],
      additionalProperties: false,
    });
  });

  test('closes required empty { type: "object" } without properties and keeps loose mode untouched', () => {
    const strictEmpty = normalizeOpenAiJsonSchema({ type: 'object' }, true);
    expect(strictEmpty).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    });

    const loose = normalizeOpenAiJsonSchema(
      {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a'],
      },
      false,
    );
    expect(loose).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'number' } },
      required: ['a'],
    });
  });
});

describe('stripStrictOptionalNulls', () => {
  test('round-trips Zod .optional(), .nullable().optional(), .default(), and .transform() through strict schema', () => {
    const OutputSchema = z.object({
      title: z.string(),
      note: z.string().optional(),
      explicitNull: z.string().nullable().optional(),
      retries: z.number().int().default(3),
      normalizedTag: z
        .string()
        .transform((s) => s.trim().toLowerCase())
        .optional(),
      nested: z
        .object({
          code: z.string(),
          hint: z.string().optional(),
        })
        .optional(),
      items: z.array(
        z.object({
          id: z.string(),
          extra: z.enum(['a', 'b']).optional(),
        }),
      ),
    });

    const inputJsonSchema = toJsonSchema(OutputSchema, 'input');
    const wireSchema = normalizeOpenAiJsonSchema(inputJsonSchema, true);
    expect(wireSchema.required).toEqual([
      'title',
      'note',
      'explicitNull',
      'retries',
      'normalizedTag',
      'nested',
      'items',
    ]);

    // Simulated OpenAI strict JSON output returning null for every omitted optional/default field
    const wireOutput = {
      title: 'Report',
      note: null,
      explicitNull: null,
      retries: null,
      normalizedTag: '  Urgent  ',
      nested: { code: 'OK', hint: null },
      items: [
        { id: '1', extra: null },
        { id: '2', extra: 'b' },
      ],
    };

    const cleaned = stripStrictOptionalNulls(wireOutput, inputJsonSchema);
    expect(cleaned).toEqual({
      title: 'Report',
      explicitNull: null,
      normalizedTag: '  Urgent  ',
      nested: { code: 'OK' },
      items: [{ id: '1' }, { id: '2', extra: 'b' }],
    });
    // Must not mutate original object
    expect(wireOutput.note).toBeNull();

    const parsed = OutputSchema.safeParse(cleaned);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        title: 'Report',
        explicitNull: null,
        retries: 3,
        normalizedTag: 'urgent',
        nested: { code: 'OK' },
        items: [{ id: '1' }, { id: '2', extra: 'b' }],
      });
    }
  });

  test('preserves null on required non-nullable properties (negative control) and handles discriminated unions + $ref', () => {
    const schema = z.object({
      mustHave: z.string(),
      maybeAny: z.unknown().optional(),
      payload: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), aOpt: z.string().optional() }),
        z.object({ kind: z.literal('b'), bOpt: z.number().nullable().optional() }),
      ]),
    });
    const inputJsonSchema = toJsonSchema(schema, 'input');

    // Negative control: required `mustHave: null` is NOT stripped, so Zod still rejects it
    const bad = stripStrictOptionalNulls(
      { mustHave: null, maybeAny: null, payload: { kind: 'a', aOpt: null } },
      inputJsonSchema,
    );
    expect(bad).toEqual({
      mustHave: null,
      maybeAny: null,
      payload: { kind: 'a' },
    });
    expect(schema.safeParse(bad).success).toBe(false);

    // Discriminated union branch b preserves explicit nullable optional bOpt: null
    const goodB = stripStrictOptionalNulls(
      { mustHave: 'ok', payload: { kind: 'b', bOpt: null } },
      inputJsonSchema,
    );
    expect(goodB).toEqual({ mustHave: 'ok', payload: { kind: 'b', bOpt: null } });
    expect(schema.safeParse(goodB).success).toBe(true);

    // $ref optional non-nullable object is stripped when null and cleaned when object
    const refSchema = {
      type: 'object',
      properties: {
        addr: { $ref: '#/$defs/Address' },
      },
      $defs: {
        Address: {
          type: 'object',
          properties: { city: { type: 'string' }, zip: { type: 'string' } },
          required: ['city'],
        },
      },
    };
    expect(stripStrictOptionalNulls({ addr: null }, refSchema)).toEqual({});
    expect(stripStrictOptionalNulls({ addr: { city: 'KL', zip: null } }, refSchema)).toEqual({
      addr: { city: 'KL' },
    });
  });

  test('handles discriminatedUnion optional enum/literal nulls and distinguishes required non-null vs optional union branches', () => {
    // 1. Discriminated union with optional enum + optional literal fields returning null under strict mode
    const discUnion = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('a'),
        role: z.enum(['admin', 'user']).optional(),
        flag: z.literal('vip').optional(),
      }),
      z.object({ kind: z.literal('b'), count: z.number() }),
    ]);
    const discJson = toJsonSchema(discUnion, 'input');

    const cleanedOptNulls = stripStrictOptionalNulls(
      { kind: 'a', role: null, flag: null },
      discJson,
    );
    expect(cleanedOptNulls).toEqual({ kind: 'a' });
    expect(discUnion.safeParse(cleanedOptNulls).success).toBe(true);

    const cleanedMixed = stripStrictOptionalNulls(
      { kind: 'a', role: 'admin', flag: null },
      discJson,
    );
    expect(cleanedMixed).toEqual({ kind: 'a', role: 'admin' });
    expect(discUnion.safeParse(cleanedMixed).success).toBe(true);

    // Negative controls: invalid non-null enum value and null required discriminator are NOT masked
    const invalidEnum = stripStrictOptionalNulls(
      { kind: 'a', role: 'guest', flag: null },
      discJson,
    );
    expect(discUnion.safeParse(invalidEnum).success).toBe(false);
    const nullDiscriminator = stripStrictOptionalNulls(
      { kind: null, role: null, flag: null },
      discJson,
    );
    expect(nullDiscriminator).toEqual({ kind: null, role: null, flag: null });
    expect(discUnion.safeParse(nullDiscriminator).success).toBe(false);

    // 2. Non-discriminated union where branch 1 requires non-null `b` and branch 2 has optional `b`
    const reqVsOptUnion = z.union([
      z.object({ a: z.string(), b: z.number() }),
      z.object({ a: z.string(), b: z.string().optional() }),
    ]);
    const reqVsOptJson = toJsonSchema(reqVsOptUnion, 'input');

    const cleanedBranch2 = stripStrictOptionalNulls({ a: 'hi', b: null }, reqVsOptJson);
    expect(cleanedBranch2).toEqual({ a: 'hi' });
    expect(reqVsOptUnion.safeParse(cleanedBranch2).success).toBe(true);

    const keptBranch1 = stripStrictOptionalNulls({ a: 'hi', b: 42 }, reqVsOptJson);
    expect(keptBranch1).toEqual({ a: 'hi', b: 42 });
    expect(reqVsOptUnion.safeParse(keptBranch1).success).toBe(true);

    // Negative control: when EVERY union branch requires non-null `b`, `b: null` must remain and fail Zod
    const bothRequiredUnion = z.union([
      z.object({ a: z.string(), b: z.number() }),
      z.object({ a: z.string(), b: z.boolean() }),
    ]);
    const bothRequiredJson = toJsonSchema(bothRequiredUnion, 'input');
    const keptInvalidNull = stripStrictOptionalNulls({ a: 'hi', b: null }, bothRequiredJson);
    expect(keptInvalidNull).toEqual({ a: 'hi', b: null });
    expect(bothRequiredUnion.safeParse(keptInvalidNull).success).toBe(false);

    // Required explicitly nullable field still matches the branch and preserves null while stripping optional sibling
    const reqNullableDisc = z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('a'),
        note: z.string().nullable(),
        tag: z.enum(['x', 'y']).optional(),
      }),
      z.object({ kind: z.literal('b'), count: z.number() }),
    ]);
    const cleanedReqNullable = stripStrictOptionalNulls(
      { kind: 'a', note: null, tag: null },
      toJsonSchema(reqNullableDisc, 'input'),
    );
    expect(cleanedReqNullable).toEqual({ kind: 'a', note: null });
    expect(reqNullableDisc.safeParse(cleanedReqNullable).success).toBe(true);
  });
});

describe('prepareAnthropicJsonSchema (real DFS cycle detection & additionalProperties)', () => {
  test('rejects direct, self-$defs, mutual, and definitions cycles', () => {
    expect(() =>
      prepareAnthropicJsonSchema({
        type: 'object',
        properties: { self: { $ref: '#' } },
      }),
    ).toThrow(TypeError);

    expect(() =>
      prepareAnthropicJsonSchema({
        type: 'object',
        properties: { root: { $ref: '#/$defs/Node' } },
        $defs: {
          Node: {
            type: 'object',
            properties: { next: { $ref: '#/$defs/Node' } },
          },
        },
      }),
    ).toThrow(/recursive \$ref "#\/\$defs\/Node"/);

    expect(() =>
      prepareAnthropicJsonSchema({
        type: 'object',
        properties: { a: { $ref: '#/$defs/A' } },
        $defs: {
          A: { type: 'object', properties: { b: { $ref: '#/$defs/B' } } },
          B: { type: 'object', properties: { a: { $ref: '#/$defs/A' } } },
        },
      }),
    ).toThrow(TypeError);

    expect(() =>
      prepareAnthropicJsonSchema({
        type: 'object',
        properties: { tree: { $ref: '#/definitions/Tree' } },
        definitions: {
          Tree: {
            type: 'object',
            properties: { children: { type: 'array', items: { $ref: '#/definitions/Tree' } } },
          },
        },
      }),
    ).toThrow(/recursive \$ref "#\/definitions\/Tree"/);
  });

  test('allows sibling anyOf and diamond $ref reuse without false positives, and forces additionalProperties: false', () => {
    const prepared = prepareAnthropicJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: true,
      properties: {
        choice: { anyOf: [{ $ref: '#/$defs/Tag' }, { $ref: '#/$defs/Tag' }] },
        primary: { $ref: '#/$defs/Tag' },
        secondary: { $ref: '#/$defs/Tag' },
      },
      $defs: {
        Tag: {
          type: 'object',
          additionalProperties: true,
          properties: { name: { type: 'string', minLength: 2 } },
        },
      },
    });

    expect(prepared.$schema).toBeUndefined();
    expect(prepared.additionalProperties).toBe(false);
    const defs = prepared.$defs as Record<string, Record<string, unknown>>;
    expect(defs.Tag?.additionalProperties).toBe(false);
    const tagProps = defs.Tag?.properties as Record<string, Record<string, unknown>>;
    expect(tagProps.name?.minLength).toBeUndefined();
    expect(tagProps.name?.description).toContain('minLength=2');
  });

  test('normalizes Zod 4 discriminatedUnion without oneOf, strips z.array(ObjWithOpt).nullable(), refuses z.record() in strict/Anthropic, handles type: ["object","null"], and narrows non-discriminated z.union', () => {
    const containsKeyword = (node: unknown, keyword: string): boolean => {
      if (Array.isArray(node)) return node.some((item) => containsKeyword(item, keyword));
      if (typeof node !== 'object' || node === null) return false;
      if (Object.hasOwn(node, keyword)) return true;
      return Object.values(node).some((v) => containsKeyword(v, keyword));
    };

    // 1. Zod 4 discriminatedUnion + nullable flattens oneOf -> anyOf in strict mode (and preserves oneOf in loose mode)
    const unionSchema = z.object({
      choice: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('a'), opt: z.string().optional() }),
        z.object({ kind: z.literal('b'), count: z.number().int() }),
      ]),
      nullableChoice: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('x'), note: z.string().optional() }),
          z.object({ kind: z.literal('y'), val: z.number() }),
        ])
        .nullable(),
    });
    const unionJson = toJsonSchema(unionSchema, 'input');
    expect(containsKeyword(unionJson, 'oneOf')).toBe(true);
    const strictUnion = normalizeOpenAiJsonSchema(unionJson, true);
    expect(containsKeyword(strictUnion, 'oneOf')).toBe(false);
    const strictProps = strictUnion.properties as Record<string, Record<string, unknown>>;
    expect(Array.isArray(strictProps.choice?.anyOf)).toBe(true);
    const nullableBranches = Array.isArray(strictProps.nullableChoice?.anyOf)
      ? strictProps.nullableChoice.anyOf
      : [];
    expect(nullableBranches).toHaveLength(3);
    expect(nullableBranches[2]).toEqual({ type: 'null' });

    const looseUnion = normalizeOpenAiJsonSchema(unionJson, false);
    expect(containsKeyword(looseUnion, 'oneOf')).toBe(true);

    // 2. z.array(ObjWithOptional).nullable() strips synthesized nulls inside array elements while preserving null array
    const nullableArraySchema = z.object({
      items: z
        .array(
          z.object({
            id: z.string(),
            note: z.string().optional(),
            explicitNull: z.string().nullable().optional(),
          }),
        )
        .nullable(),
      pair: z
        .tuple([z.object({ id: z.string(), opt: z.string().optional() })])
        .nullable()
        .optional(),
    });
    const nullableArrJson = toJsonSchema(nullableArraySchema, 'input');
    const cleanedArr = stripStrictOptionalNulls(
      {
        items: [
          { id: '1', note: null, explicitNull: null },
          { id: '2', note: 'kept', explicitNull: 'ok' },
        ],
        pair: [{ id: 'p1', opt: null }],
      },
      nullableArrJson,
    );
    expect(cleanedArr).toEqual({
      items: [
        { id: '1', explicitNull: null },
        { id: '2', note: 'kept', explicitNull: 'ok' },
      ],
      pair: [{ id: 'p1' }],
    });
    expect(nullableArraySchema.safeParse(cleanedArr).success).toBe(true);

    const cleanedNull = stripStrictOptionalNulls({ items: null, pair: null }, nullableArrJson);
    expect(cleanedNull).toEqual({ items: null, pair: null });
    expect(nullableArraySchema.safeParse(cleanedNull).success).toBe(true);

    // 3. z.record(...) fails fast with TypeError in OpenAI strict and Anthropic, but passes in loose mode
    const recordJson = toJsonSchema(z.record(z.string(), z.number()), 'input');
    expect(() => normalizeOpenAiJsonSchema(recordJson, true)).toThrow(TypeError);
    expect(() => prepareAnthropicJsonSchema(recordJson)).toThrow(TypeError);
    const nestedRecordJson = toJsonSchema(
      z.object({ meta: z.record(z.string(), z.unknown()) }),
      'input',
    );
    expect(() => normalizeOpenAiJsonSchema(nestedRecordJson, true)).toThrow(TypeError);
    expect(() => prepareAnthropicJsonSchema(nestedRecordJson)).toThrow(TypeError);
    const looseRecord = normalizeOpenAiJsonSchema(recordJson, false);
    expect(looseRecord.additionalProperties).toEqual({ type: 'number' });

    // 4. type: ['object', 'null'] normalizes properties + additionalProperties while preserving 'null'
    const nullableObj = {
      type: ['object', 'null'],
      properties: { a: { type: 'string', minLength: 2 }, b: { type: 'number' } },
      required: ['a'],
      additionalProperties: true,
    };
    const oaNullableObj = normalizeOpenAiJsonSchema(nullableObj, true);
    expect(oaNullableObj).toEqual({
      type: ['object', 'null'],
      properties: {
        a: { type: 'string', minLength: 2 },
        b: { type: ['number', 'null'] },
      },
      required: ['a', 'b'],
      additionalProperties: false,
    });
    const anthNullableObj = prepareAnthropicJsonSchema(nullableObj);
    expect(anthNullableObj.type).toEqual(['object', 'null']);
    expect(anthNullableObj.additionalProperties).toBe(false);
    expect(() =>
      normalizeOpenAiJsonSchema(
        { type: ['object', 'null'], additionalProperties: { type: 'string' } },
        true,
      ),
    ).toThrow(TypeError);
    expect(() =>
      prepareAnthropicJsonSchema({
        type: ['object', 'null'],
        additionalProperties: { type: 'string' },
      }),
    ).toThrow(TypeError);

    // 5. Non-discriminated z.union selects best matching branch and respects additionalProperties: false
    const nonDiscUnion = z.union([
      z.object({ a: z.string(), shared: z.string().optional() }),
      z.object({ b: z.number(), shared: z.string().nullable() }),
    ]);
    const nonDiscJson = toJsonSchema(nonDiscUnion, 'input');
    const branchACleaned = stripStrictOptionalNulls({ a: 'hello', shared: null }, nonDiscJson);
    expect(branchACleaned).toEqual({ a: 'hello' });
    expect(nonDiscUnion.safeParse(branchACleaned).success).toBe(true);
    const branchBCleaned = stripStrictOptionalNulls({ b: 7, shared: null }, nonDiscJson);
    expect(branchBCleaned).toEqual({ b: 7, shared: null });
    expect(nonDiscUnion.safeParse(branchBCleaned).success).toBe(true);

    // additionalProperties: false branch rejected when value has foreign keys
    const closedUnion = {
      anyOf: [
        {
          type: 'object',
          properties: { onlyA: { type: 'string' }, opt: { type: ['string', 'null'] } },
          required: ['onlyA'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            onlyA: { type: 'string' },
            extraB: { type: 'number' },
            opt: { type: 'string' },
          },
          required: ['onlyA', 'extraB'],
          additionalProperties: false,
        },
      ],
    };
    expect(
      stripStrictOptionalNulls({ onlyA: 'x', extraB: 1, opt: null }, closedUnion),
    ).toEqual({ onlyA: 'x', extraB: 1 });
  });
});
