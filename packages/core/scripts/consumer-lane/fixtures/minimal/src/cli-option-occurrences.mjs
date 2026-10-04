import assert from 'node:assert/strict';
import { CliArgumentError, createCli, defineCliCommand, parseCliArgs } from 'stitchkit/cli';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { z } from 'zod';

const Input = z.strictObject({
  root: z.string(),
  issuer: z.string().optional(),
  check: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  'feature.enabled': z.boolean().optional(),
  feature: z.object({ mode: z.string() }).optional(),
});
const aliases = new Map([
  ['c', 'check'],
  ['i', 'issuer'],
  ['t', 'tags'],
  ['f', 'feature.enabled'],
]);
const forms = [
  [['--check'], true],
  [['--check', 'true'], true],
  [['--check', 'false'], false],
  [['--check=true'], true],
  [['--check=false'], false],
  [['--no-check'], false],
  [['-c'], true],
  [['-c', 'false'], false],
  [['-c=false'], false],
];
const parse = (argv) =>
  parseCliArgs(argv, Input, {
    positionals: ['root'],
    optionAliases: aliases,
  });

for (const [flags, value] of forms) {
  assert.deepEqual(parse(['/workspace', ...flags]).toolArgs, {
    root: '/workspace',
    check: value,
  });
}
for (const [first] of forms) {
  for (const [second] of forms) {
    assert.throws(
      () => parse(['/workspace', ...first, ...second]),
      (error) =>
        error instanceof CliArgumentError && error.message === '--check was passed 2 times',
    );
  }
}
assert.deepEqual(parse(['/workspace', '--tags=a', '-t', 'b']).toolArgs, {
  root: '/workspace',
  tags: ['a', 'b'],
});
assert.deepEqual(parse(['/workspace', '-f=false', '--feature={"mode":"inspect"}']).toolArgs, {
  root: '/workspace',
  'feature.enabled': false,
  feature: '{"mode":"inspect"}',
});
const NestedInput = z.strictObject({
  'feature.enabled': z.boolean().optional(),
  feature: z.object({ enabled: z.boolean() }),
});
assert.deepEqual(
  NestedInput.parse(parseCliArgs(['--feature.enabled=false'], NestedInput).toolArgs),
  { feature: { enabled: false } },
);
for (const flags of [
  ['--check=false', '-c=private-second-value'],
  ['-c=false', '-c=private-second-value'],
]) {
  assert.throws(
    () => parse(flags),
    (error) =>
      error instanceof CliArgumentError && error.message === '--check was passed 2 times',
  );
}

let handlerCalls = 0;
let stdinCalls = 0;
let authCalls = 0;
const native = defineCliCommand({
  name: 'native',
  description: 'Inspect a parsed invocation',
  input: Input,
  output: Input,
  handler: ({ input }) => {
    handlerCalls++;
    return input;
  },
});
const service = implement(
  defineContract(
    { prefix: 'inspection', scope: 'public' },
    {
      inspect: {
        method: 'POST',
        path: '/',
        desc: 'Inspect through the contract',
        expose: ['CLI'],
        input: Input,
        output: Input,
        tool: { name: 'managed' },
      },
    },
  ),
  {
    inspect: ({ input }) => {
      handlerCalls++;
      return input;
    },
  },
);

async function run(argv) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'inspection',
    version: '1',
    argv,
    commands: [native],
    services: [service],
    defaultCommand: 'native',
    positionals: { native: ['root'], managed: ['root'] },
    optionAliases: {
      native: { c: 'check', i: 'issuer', t: 'tags', f: 'feature.enabled' },
      managed: { c: 'check' },
    },
    globalOptions: z.object({ verbose: z.boolean().optional() }),
    resolveAuth: () => {
      authCalls++;
      return {};
    },
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => {
      stdinCalls++;
      return '/stdin-root';
    },
  });
  return { out, err, code };
}

for (const command of ['native', 'managed']) {
  for (const flags of [
    ['--check=false', '--check'],
    ['--check', '--check=false'],
    ['--check', 'true', '--check', 'false'],
    ['--check', 'false', '--check', 'false'],
    ['--no-check', '--no-check'],
    ['-c=false', '--check'],
    ['--check', '-c=false'],
    ['--check=false', '-c=private-second-value'],
    ['-c=false', '-c=private-second-value'],
  ]) {
    const before = handlerCalls;
    const result = await run([command, ...flags]);
    assert.deepEqual(result, { out: '', err: '--check was passed 2 times\n', code: 2 });
    assert.equal(handlerCalls, before);
    assert.equal(stdinCalls, 0);
  }
  const before = handlerCalls;
  const positive = await run([command, '/workspace', '--check', 'false', '--json']);
  assert.equal(positive.code, 0);
  assert.equal(positive.err, '');
  assert.deepEqual(JSON.parse(positive.out), { root: '/workspace', check: false });
  assert.equal(handlerCalls, before + 1);
  const help = await run([command, '--check=false', '--check', '--help', '-h']);
  assert.equal(help.code, 0);
  assert.match(help.out, /--check/);
  assert.equal(handlerCalls, before + 1);
}
const authBefore = authCalls;
const globalDuplicate = await run(['--verbose=false', 'managed', '--verbose']);
assert.deepEqual(globalDuplicate, { out: '', err: '--verbose was passed 2 times\n', code: 2 });
assert.equal(authCalls, authBefore);
const frameworkDuplicate = await run(['--json=false', 'native', '--json']);
assert.deepEqual(frameworkDuplicate, { out: '', err: '--json was passed 2 times\n', code: 2 });
const scalarDuplicate = await run([
  'native',
  '/private-unrelated',
  '--issuer=private-a',
  '-i',
  'private-b',
]);
assert.deepEqual(scalarDuplicate, { out: '', err: '--issuer was passed 2 times\n', code: 2 });
assert.equal(handlerCalls, 2);
assert.equal(stdinCalls, 0);
console.log('packed CLI option occurrences: ok');
