import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { parseCliArgs } from '../src/tools/cli/args';
import { createCli } from '../src/tools/cli/create-cli';

const PrimitiveLiterals = z.strictObject({
  behind: z.literal(1),
  ahead: z.literal([2, 3]),
  truth: z.literal(true),
  falsehood: z.literal(false).optional(),
  code: z.literal('007'),
  numericUnion: z.union([z.literal(4), z.literal(5)]),
  numbers: z.array(z.literal([6, 7])),
  optionalNumber: z.literal(8).optional(),
  defaultNumber: z.literal(9).default(9),
  nullableNumber: z.literal(10).nullable(),
  mixed: z.literal([11, '011']).optional(),
});

describe('CLI primitive literal coercion', () => {
  test('coerces homogeneous literals through wrappers and arrays', () => {
    const parsed = parseCliArgs(
      [
        '--behind=1',
        '--ahead',
        '2',
        '--truth',
        '--no-falsehood',
        '--code',
        '007',
        '--numericUnion',
        '5',
        '--numbers',
        '6',
        '--numbers=7',
        '--optionalNumber',
        '8',
        '--defaultNumber=9',
        '--nullableNumber',
        '10',
        '--mixed',
        '011',
      ],
      PrimitiveLiterals,
    ).toolArgs;

    expect(parsed).toEqual({
      behind: 1,
      ahead: 2,
      truth: true,
      falsehood: false,
      code: '007',
      numericUnion: 5,
      numbers: [6, 7],
      optionalNumber: 8,
      defaultNumber: 9,
      nullableNumber: 10,
      mixed: '011',
    });
    expect(PrimitiveLiterals.safeParse(parsed).success).toBe(true);
  });

  test('keeps string and mixed-type literals lexical instead of guessing from argv', () => {
    const schema = z.object({
      code: z.literal('007'),
      mixed: z.literal([7, '007']),
    });
    const parsed = parseCliArgs(['--code=007', '--mixed=007'], schema).toolArgs;
    expect(parsed).toEqual({ code: '007', mixed: '007' });
    expect(schema.safeParse(parsed).success).toBe(true);
  });

  test('dotted leaves follow their schema and free records preserve lexical strings', () => {
    const schema = z.object({
      data: z.object({
        code: z.string(),
        signed: z.string().optional(),
        exponent: z.string().nullable(),
        truth: z.string(),
        falsehood: z.string(),
        count: z.number(),
        enabled: z.boolean(),
      }),
      free: z.record(z.string(), z.unknown()),
      numbers: z.record(z.string(), z.number()),
      booleans: z.record(z.string(), z.boolean()),
    });
    const parsed = parseCliArgs(
      [
        '--data.code=007',
        '--data.signed=+007',
        '--data.exponent=1e3',
        '--data.truth=true',
        '--data.falsehood=false',
        '--data.count=1e3',
        '--data.enabled=false',
        '--free.code=007',
        '--free.truth=true',
        '--numbers.total=1e3',
        '--booleans.ready=true',
      ],
      schema,
    ).toolArgs;

    expect(parsed).toEqual({
      data: {
        code: '007',
        signed: '+007',
        exponent: '1e3',
        truth: 'true',
        falsehood: 'false',
        count: 1_000,
        enabled: false,
      },
      free: { code: '007', truth: 'true' },
      numbers: { total: 1_000 },
      booleans: { ready: true },
    });
    expect(schema.safeParse(parsed).success).toBe(true);
  });

  test('repeated dotted arrays accumulate and coerce each declared element', () => {
    const schema = z.object({
      data: z.object({
        tags: z.array(z.string()),
        scores: z.array(z.number()),
      }),
    });
    const parsed = parseCliArgs(
      ['--data.tags=007', '--data.tags=true', '--data.scores=007', '--data.scores=1e3'],
      schema,
    ).toolArgs;

    expect(parsed).toEqual({
      data: {
        tags: ['007', 'true'],
        scores: [7, 1_000],
      },
    });
    expect(schema.safeParse(parsed).success).toBe(true);
  });

  test('a union with conflicting array element types stays lexical in either branch order', () => {
    const strings = z.object({
      values: z.array(z.string()),
      data: z.object({ values: z.array(z.string()) }),
    });
    const numbers = z.object({
      values: z.array(z.number()),
      data: z.object({ values: z.array(z.number()) }),
    });
    for (const schema of [z.union([strings, numbers]), z.union([numbers, strings])]) {
      const parsed = parseCliArgs(
        ['--values=007', '--values=1e3', '--data.values=007', '--data.values=1e3'],
        schema,
      ).toolArgs;
      expect(parsed).toEqual({
        values: ['007', '1e3'],
        data: { values: ['007', '1e3'] },
      });
      expect(schema.safeParse(parsed).success).toBe(true);
    }

    expect(parseCliArgs(['--data.values=007', '--data.values=1e3'], numbers).toolArgs).toEqual(
      { data: { values: [7, 1_000] } },
    );
  });

  test('wholly unknown dotted passthrough keeps its legacy best-effort coercion', () => {
    const schema = z.object({ known: z.string().optional() });
    expect(
      parseCliArgs(['--extra.code=007', '--extra.enabled=true'], schema, {
        allowUnknown: true,
      }).toolArgs,
    ).toEqual({ extra: { code: 7, enabled: true } });
  });

  test('a free union branch keeps a dotted leaf lexical in either branch order', () => {
    const free = z.object({ data: z.record(z.string(), z.unknown()) });
    const typed = z.object({ data: z.object({ code: z.number() }) });
    for (const schema of [z.union([free, typed]), z.union([typed, free])]) {
      const parsed = parseCliArgs(['--data.code=007'], schema).toolArgs;
      expect(parsed).toEqual({ data: { code: '007' } });
      expect(schema.safeParse(parsed).success).toBe(true);
    }
  });

  test('an intersection concrete leaf still refines its free member', () => {
    const schema = z.object({
      data: z.intersection(z.record(z.string(), z.unknown()), z.object({ count: z.number() })),
    });
    const parsed = parseCliArgs(['--data.count=007'], schema).toolArgs;
    expect(parsed).toEqual({ data: { count: 7 } });
    expect(schema.safeParse(parsed).success).toBe(true);
  });

  test('invalid numeric and boolean literals are rejected before the handler', async () => {
    const Input = z.strictObject({ behind: z.literal(1), enabled: z.literal(true) });
    const contract = defineContract(
      { prefix: 'literal', scope: 'public' },
      {
        inspect: {
          method: 'POST',
          path: '/inspect',
          desc: 'Inspect literal coercion',
          expose: ['CLI'],
          input: Input,
          output: z.object({ ok: z.literal(true) }),
          tool: { name: 'inspect_literals' },
        },
      },
    );
    let calls = 0;
    const service = implement(contract, {
      inspect: () => {
        calls++;
        return { ok: true as const };
      },
    });

    for (const argv of [
      ['inspect_literals', '--behind=2', '--enabled'],
      ['inspect_literals', '--behind=1', '--no-enabled'],
    ]) {
      let code = -1;
      await createCli({
        name: 'literal-proof',
        version: '1.0.0',
        services: [service],
        argv,
        stdout: () => undefined,
        stderr: () => undefined,
        exit: (value) => {
          code = value;
        },
        stdin: async () => null,
      });
      expect(code).not.toBe(0);
    }
    expect(calls).toBe(0);
  });

  test('invalid typed dotted leaves never reach the handler', async () => {
    const Input = z.strictObject({
      data: z.object({ count: z.number().int(), enabled: z.boolean() }),
    });
    const contract = defineContract(
      { prefix: 'dotted', scope: 'public' },
      {
        inspect: {
          method: 'POST',
          path: '/inspect',
          desc: 'Inspect dotted coercion',
          expose: ['CLI'],
          input: Input,
          output: z.object({ ok: z.literal(true) }),
          tool: { name: 'inspect_dotted' },
        },
      },
    );
    let calls = 0;
    const service = implement(contract, {
      inspect: () => {
        calls++;
        return { ok: true as const };
      },
    });

    for (const argv of [
      ['inspect_dotted', '--data.count=nope', '--data.enabled=true'],
      ['inspect_dotted', '--data.count=1', '--data.enabled=banana'],
    ]) {
      let code = -1;
      await createCli({
        name: 'dotted-proof',
        version: '1.0.0',
        services: [service],
        argv,
        stdout: () => undefined,
        stderr: () => undefined,
        exit: (value) => {
          code = value;
        },
        stdin: async () => null,
      });
      expect(code).not.toBe(0);
    }
    expect(calls).toBe(0);
  });
});
