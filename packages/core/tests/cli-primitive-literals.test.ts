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
});
