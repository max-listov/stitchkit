import { expect, test } from 'bun:test';
import { z } from 'zod';
import {
  createCli,
  defineCliCommand,
  extractCliGlobalOptions,
  parseCliArgs,
} from '../src/entrypoints/cli';

const Input = z.strictObject({
  productId: z.string().nullable(),
  count: z.number().nullable().optional(),
  text: z.string().optional(),
  note: z.string().nullable().optional(),
  values: z.array(z.string()).nullable().optional(),
  data: z.object({ value: z.string().nullable() }).optional(),
});

test('explicit JSON null differs from a literal null string and omission', () => {
  const parsed = parseCliArgs(
    ['--productId:=null', '--count:=null', '--text=null'],
    Input,
  ).toolArgs;
  expect(parsed).toEqual({ productId: null, count: null, text: 'null' });
  expect(Object.hasOwn(parsed, 'note')).toBe(false);
  expect(Input.safeParse(parsed).success).toBe(true);
  expect(parseCliArgs(['--productId=null'], Input).toolArgs).toEqual({ productId: 'null' });
  expect(parseCliArgs(['--productId:="null"'], Input).toolArgs).toEqual({
    productId: 'null',
  });
});

test('JSON values keep their type for dotted leaves, booleans and whole arrays', () => {
  const schema = Input.extend({ enabled: z.boolean().nullable() });
  const parsed = parseCliArgs(
    ['--productId:=null', '--data.value:=null', '--values:=["null","007"]', '--enabled:=null'],
    schema,
  ).toolArgs;
  expect(parsed).toEqual({
    productId: null,
    data: { value: null },
    values: ['null', '007'],
    enabled: null,
  });
  expect(schema.safeParse(parsed).success).toBe(true);
});

test('malformed JSON, repeats, mixed whole values and unsafe paths fail before dispatch', () => {
  for (const args of [
    ['--productId:=undefined'],
    ['--productId:='],
    ['--productId:=null', '--productId=null'],
    ['--productId=null', '--productId:=null'],
    ['--values:=null', '--values=x'],
    ['--values=x', '--values:=["y"]'],
    ['--values:=["x"]', '--values:=["y"]'],
    ['--data:={"value":null}', '--data.value=x'],
    ['--data.value:=null', '--data.value.child=x'],
    ['--data.value.child=x', '--data.value:=null'],
    ['--data.__proto__.polluted:=true'],
    ['--unknown:=null'],
    ['--json:=null'],
  ]) {
    expect(() => parseCliArgs(args, Input)).toThrow();
  }
  expect(() => parseCliArgs(['--productId:=undefined'], Input)).toThrow(
    '--productId expects valid JSON',
  );
});

test('declared colon names keep their existing inline spelling', () => {
  const schema = z.object({ 'key:': z.string() });
  expect(parseCliArgs(['--key:=literal'], schema).toolArgs).toEqual({ 'key:': 'literal' });
});

test('application globals use the same explicit JSON grammar', () => {
  const schema = z.object({ tenant: z.string().nullable().optional() });
  expect(extractCliGlobalOptions(['--tenant:=null', 'inspect'], schema)).toEqual({
    argv: ['inspect'],
    globals: { tenant: null },
  });
  expect(extractCliGlobalOptions(['inspect', '--tenant=null'], schema).globals).toEqual({
    tenant: 'null',
  });
  expect(() => extractCliGlobalOptions(['--tenant:=null', '--tenant=x'], schema)).toThrow(
    'passed 2 times',
  );
  expect(extractCliGlobalOptions(['--json:=null'], schema).argv).toEqual(['--json:=null']);
});

async function run(argv: string[]) {
  let calls = 0;
  let out = '';
  let err = '';
  let code = -1;
  const native = defineCliCommand({
    name: 'upsert',
    description: 'Upsert a synthetic material',
    input: Input,
    output: Input,
    handler: ({ input }) => {
      calls++;
      return input;
    },
  });
  await createCli({
    name: 'example',
    version: '1',
    commands: [native],
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
  return { out, err, code, calls };
}

test('native commands validate explicit null through the canonical schema', async () => {
  expect(await run(['upsert', '--productId:=null', '--count:=null', '--json'])).toEqual({
    out: '{"productId":null,"count":null}\n',
    err: '',
    code: 0,
    calls: 1,
  });
  const refused = await run(['upsert', '--productId:=null', '--text:=null', '--json']);
  expect(refused.code).not.toBe(0);
  expect(refused.err).toContain('VALIDATION_ERROR');
  expect(refused.out).toBe('');
  expect(refused.calls).toBe(0);
});

test('native command help discovers explicit JSON and literal string syntax', async () => {
  const help = await run(['upsert', '--help']);
  expect(help.code).toBe(0);
  expect(help.calls).toBe(0);
  expect(help.out).toContain('--productId:=null');
  expect(help.out).toContain('--productId null');
});
