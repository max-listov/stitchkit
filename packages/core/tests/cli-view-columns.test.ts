/**
 * Pre-execution column verification (`assertViewColumns`) for unambiguous
 * collection output schemas across managed and native CLI commands.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createCli, defineCliCommand } from '../src/entrypoints/cli';
import { defineContract } from '../src/entrypoints/contract';
import { implement } from '../src/entrypoints/server';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

const RecordSchema = z.object({
  id: z.string(),
  status: z.string(),
  meta: z.object({ x: z.number() }),
});

const EnvelopeSchema = z.object({
  items: z.array(RecordSchema),
  total: z.number(),
});

const SAMPLE = [
  { id: 'r1', status: 'ok', meta: { x: 10 } },
  { id: 'r2', status: 'warn', meta: { x: 20 } },
];

async function runManaged(argv: string[], outputSchema: z.ZodType, resultValue: unknown) {
  let calls = 0;
  let out = '';
  let err = '';
  let code = -1;
  const contract = defineContract(
    { prefix: 'records', scope: 'public' },
    {
      list: {
        method: 'GET',
        path: '/',
        desc: 'List records',
        expose: ['CLI'],
        output: outputSchema,
        tool: { name: 'list' },
      },
    },
  );
  const service = implement(contract, {
    list: () => {
      calls++;
      return resultValue;
    },
  });
  await createCli({
    access: { open: 'local-operator' },
    name: 'views',
    version: '1.0.0',
    services: [service],
    argv: ['list', ...argv],
    stdin: async () => null,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
  });
  return { calls, out, err, code };
}

describe('pre-execution view column validation', () => {
  test.each([
    [['--table', 'id,nope']],
    [['--sort', 'nope']],
    [['--sum', 'nope']],
    [['--count-by', 'nope']],
    [['--top', '2', '--by', 'nope']],
    [['--table', 'meta.nope']],
  ])('refuses unknown column (%j) before executing the handler', async (flags: string[]) => {
    const result = await runManaged(flags, EnvelopeSchema, { items: SAMPLE, total: 2 });
    expect(result.code).toBe(2);
    expect(result.calls).toBe(0);
    expect(result.out).toBe('');
    expect(result.err).toContain('nope');
    expect(result.err).toContain('available: id, meta, status');
  });

  test('accepts valid plain and nested paths and runs the handler once', async () => {
    const result = await runManaged(['--table', 'id,meta.x'], EnvelopeSchema, {
      items: SAMPLE,
      total: 2,
    });
    expect(result.code).toBe(0);
    expect(result.calls).toBe(1);
    expect(result.err).toBe('');
    expect(result.out).toContain('id');
    expect(result.out).toContain('meta.x');
    expect(result.out).toContain('10');
  });

  test('empty result with unknown column still fails before execution with code 2', async () => {
    const result = await runManaged(['--table', 'nope'], EnvelopeSchema, {
      items: [],
      total: 0,
    });
    expect(result.code).toBe(2);
    expect(result.calls).toBe(0);
    expect(result.err).toContain('nope');
    expect(result.err).toContain('available: id, meta, status');
  });

  test('root ZodArray schema is also validated before execution', async () => {
    const bad = await runManaged(['--table', 'nope'], z.array(RecordSchema), SAMPLE);
    expect(bad.code).toBe(2);
    expect(bad.calls).toBe(0);
    expect(bad.err).toContain('available: id, meta, status');

    const good = await runManaged(['--table', 'id,meta.x'], z.array(RecordSchema), SAMPLE);
    expect(good.code).toBe(0);
    expect(good.calls).toBe(1);
  });

  test('native command with output validates columns before execution and applies views', async () => {
    let calls = 0;
    const nativeList = defineCliCommand({
      name: 'list',
      description: 'Native list',
      input: z.object({}),
      output: EnvelopeSchema,
      handler: () => {
        calls++;
        return { items: SAMPLE, total: 2 };
      },
    });
    const runNative = async (argv: string[]) => {
      let out = '';
      let err = '';
      let code = -1;
      await createCli({
        name: 'native-views',
        version: '1.0.0',
        commands: [nativeList],
        argv,
        stdin: async () => null,
        stdout: (text) => {
          out += text;
        },
        stderr: (text) => {
          err += text;
        },
        exit: (value) => {
          code = value;
        },
      });
      return { out, err, code };
    };

    const bad = await runNative(['list', '--table', 'id,nope']);
    expect(bad.code).toBe(2);
    expect(calls).toBe(0);
    expect(bad.err).toContain('nope');
    expect(bad.err).toContain('available: id, meta, status');

    const good = await runNative(['list', '--table', 'id,meta.x']);
    expect(good.code).toBe(0);
    expect(calls).toBe(1);
    expect(good.out).toContain('r1');
    expect(good.out).toContain('20');
  });

  test('ambiguous or open output schemas defer column checks until after execution', async () => {
    const ambiguousCases: Array<{ label: string; schema: z.ZodType; value: unknown }> = [
      { label: 'z.unknown()', schema: z.unknown(), value: { items: SAMPLE } },
      {
        label: 'z.record',
        schema: z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
        value: { items: SAMPLE },
      },
      {
        label: 'looseObject element',
        schema: z.object({ items: z.array(z.looseObject({ id: z.string() })) }),
        value: { items: SAMPLE },
      },
      {
        label: 'looseObject root',
        schema: z.looseObject({ items: z.array(RecordSchema) }),
        value: { items: SAMPLE },
      },
      {
        label: 'union element',
        schema: z.object({
          items: z.array(
            z.union([RecordSchema, z.object({ id: z.string(), other: z.string() })]),
          ),
        }),
        value: { items: SAMPLE },
      },
      {
        label: 'two arrays',
        schema: z.object({ a: z.array(RecordSchema), b: z.array(RecordSchema) }),
        value: { a: SAMPLE, b: SAMPLE },
      },
      {
        label: 'optional array',
        schema: z.object({ items: z.array(RecordSchema).optional() }),
        value: { items: SAMPLE },
      },
      {
        label: 'array beside tuple',
        schema: z.object({ items: z.array(RecordSchema), pair: z.tuple([z.string()]) }),
        value: { items: SAMPLE, pair: ['only'] },
      },
    ];
    for (const { label, schema, value } of ambiguousCases) {
      let calls = 0;
      let err = '';
      let code = -1;
      const tool = defineRuntimeTool({
        name: 'list',
        description: label,
        identity: { serviceName: 'ambiguous', action: 'list', method: 'GET' },
        expose: ['CLI'],
        input: z.object({}),
        output: schema,
        handler: () => {
          calls++;
          return value;
        },
      });
      await createCli({
        access: { open: 'local-operator' },
        name: 'ambiguous',
        version: '1.0.0',
        runtimeTools: [tool],
        argv: ['list', '--table', 'nope'],
        stdin: async () => null,
        stdout: () => undefined,
        stderr: (text) => {
          err += text;
        },
        exit: (value) => {
          code = value;
        },
      });
      expect(calls).toBe(1);
      expect(code).toBe(8);
      expect(err).toContain('CLI_PRESENTATION_FAILED');
    }
  });
});
