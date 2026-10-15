import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  createCli,
  createCliInvoker,
  defineCliCommand,
  parseCliArgs,
  routeCliArgv,
} from 'stitchkit/cli';
import { z } from 'zod';

const require = createRequire(import.meta.url);
for (const peer of ['ai', '@modelcontextprotocol/server'])
  assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' });

const command = defineCliCommand({
  name: 'measure',
  description: 'Measure repeated text',
  input: z.object({ text: z.string(), repeat: z.coerce.number().default(1) }),
  output: z.object({ size: z.number() }),
  handler: ({ input }) => ({ size: input.text.length * input.repeat }),
});
const route = routeCliArgv(['measure', '--text', 'hello', '--repeat', '2', '--json']);
const parsed = parseCliArgs(route.commandArgv, command.input);
let stdout = '';
let stderr = '';
let code;
await createCli({
  name: 'native-probe',
  version: '1.0.0',
  commands: [command],
  argv: ['measure', '--text', 'hello', '--repeat', '2', '--json'],
  stdout: (text) => {
    stdout += text;
  },
  stderr: (text) => {
    stderr += text;
  },
  exit: (value) => {
    code = value;
  },
  stdin: async () => null,
});
assert.equal(code, 0);
assert.equal(stderr, '');
assert.deepEqual(JSON.parse(stdout), { size: 10 });

// Consumer control: a catalog client rebuilds its CLI schema from JSON Schema rather than importing
// the producer's Zod object. Numeric and boolean `const` values must retain their primitive type
// through that boundary and invalid values must stop before the handler.
const RestoredLiterals = z.fromJSONSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    behind: { type: 'number', const: 1 },
    ahead: { type: 'number', enum: [2, 3] },
    enabled: { type: 'boolean', const: true },
    code: { type: 'string', const: '007' },
  },
  required: ['behind', 'ahead', 'enabled', 'code'],
});
assert.ok(RestoredLiterals instanceof z.ZodObject);
let literalCalls = 0;
const literalCommand = defineCliCommand({
  name: 'literal',
  description: 'Read catalog-restored primitive literals',
  input: RestoredLiterals,
  output: z.object({ behind: z.number(), ahead: z.number(), code: z.string() }),
  handler: ({ input }) => {
    literalCalls++;
    return { behind: input.behind, ahead: input.ahead, code: input.code };
  },
});
async function runLiteral(argv) {
  let literalOut = '';
  let literalCode;
  await createCli({
    name: 'literal-probe',
    version: '1.0.0',
    commands: [literalCommand],
    argv: ['literal', ...argv, '--json'],
    stdout: (text) => {
      literalOut += text;
    },
    stderr: () => undefined,
    exit: (value) => {
      literalCode = value;
    },
    stdin: async () => null,
  });
  return { literalCode, literalOut };
}
for (const [argv, ahead] of [
  [['--behind', '1', '--ahead', '2', '--enabled', '--code', '007'], 2],
  [['--behind=1', '--ahead=3', '--enabled=true', '--code=007'], 3],
]) {
  const result = await runLiteral(argv);
  assert.equal(result.literalCode, 0);
  assert.deepEqual(JSON.parse(result.literalOut), {
    behind: 1,
    ahead,
    code: '007',
  });
}
for (const argv of [
  ['--behind=2', '--ahead=2', '--enabled', '--code=007'],
  ['--behind=1', '--ahead=2', '--no-enabled', '--code=007'],
]) {
  const before = literalCalls;
  assert.notEqual((await runLiteral(argv)).literalCode, 0);
  assert.equal(literalCalls, before);
}
assert.equal(literalCalls, 2);

const NullableInput = z.fromJSONSchema({
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    count: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    text: { type: 'string' },
    note: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['productId'],
});
assert.ok(NullableInput instanceof z.ZodObject);
const nullableCommand = defineCliCommand({
  name: 'nullable',
  description: 'Inspect a schema-restored JSON assignment',
  input: NullableInput,
  output: NullableInput,
  handler: ({ input }) => input,
});
async function runNullable(argv) {
  let out = '';
  let err = '';
  let code;
  await createCli({
    name: 'json-probe',
    version: '1',
    commands: [nullableCommand],
    argv: ['nullable', ...argv],
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
}
const jsonNull = await runNullable([
  '--productId:=null',
  '--count:=null',
  '--text=null',
  '--json',
]);
assert.equal(jsonNull.code, 0);
assert.equal(jsonNull.err, '');
assert.deepEqual(JSON.parse(jsonNull.out), { productId: null, count: null, text: 'null' });
assert.deepEqual(JSON.parse((await runNullable(['--productId=null', '--json'])).out), {
  productId: 'null',
});
for (const flags of [
  ['--productId:=null', '--text:=null'],
  ['--productId:=undefined'],
  ['--productId:=null', '--productId=null'],
]) {
  const refusal = await runNullable(flags);
  assert.notEqual(refusal.code, 0);
  assert.equal(refusal.out, '');
}
const nullableHelp = await runNullable(['--help']);
assert.equal(nullableHelp.code, 0);
assert.match(nullableHelp.out, /--productId:=null/);
assert.match(nullableHelp.out, /--productId null/);

const managed = {
  name: 'managed',
  description: 'A managed operation',
  identity: { serviceName: 'probe', action: 'managed', method: 'POST' },
  transports: ['CLI'],
  input: command.input,
  output: command.output,
  handler: ({ input }) => ({ size: input.text.length * input.repeat }),
};
const invoker = await createCliInvoker({
  name: 'invoker-probe',
  commands: [command],
  runtimeTools: [managed],
});
for (const name of ['measure', 'managed']) {
  assert.deepEqual(await invoker.invoke(name, parsed.toolArgs), {
    ok: true,
    exitCode: 0,
    data: { size: 10 },
  });
  const refused = await invoker.invoke(name, { text: 1 });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'VALIDATION_ERROR');
}
const unknown = await invoker.invoke('absent', {});
assert.equal(unknown.ok, false);
assert.equal(unknown.error.code, 'NOT_FOUND');
await assert.rejects(
  import('stitchkit/tools'),
  (error) =>
    (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND') &&
    /(?:@modelcontextprotocol\/server|["']ai["'])/.test(error.message),
);
console.log('packed peer-free CLI execution: ok');
