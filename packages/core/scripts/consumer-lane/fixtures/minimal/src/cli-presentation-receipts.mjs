import assert from 'node:assert/strict';
import { createCli, defineCliCommand } from 'stitchkit/cli';
import { AppError, defineContract, isStitchErrorCode } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { z } from 'zod';

const input = z.object({ refuse: z.boolean().optional() });
const output = z.object({
  id: z.string(),
  pendingPaths: z.array(z.string()),
  pages: z.array(z.object({ path: z.string() })),
});
const payload = { id: 'created-once', pendingPaths: ['/'], pages: [{ path: '/' }] };
let calls = 0;
let mutations = 0;
const create = ({ refuse }) => {
  calls++;
  if (refuse) throw new AppError('FORBIDDEN', { details: { message: 'Denied' } });
  mutations++;
  return payload;
};
const contract = defineContract(
  { prefix: 'receipts', scope: 'public' },
  {
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create a receipt',
      expose: ['CLI'],
      input,
      output,
      tool: { name: 'receipt_create' },
    },
  },
);
const service = implement(contract, { create: ({ input }) => create(input) });
const runtime = {
  name: 'runtime_create',
  description: 'Create a runtime receipt',
  identity: { serviceName: 'receipts', action: 'create', method: 'POST' },
  transports: ['CLI'],
  input,
  output,
  handler: ({ input }) => create(input),
};
async function run(argv, config = {}) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'receipts',
    version: '1',
    services: [service],
    runtimeTools: [runtime],
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
    ...config,
  });
  return { out, err, code };
}
function assertPreserved(result, command, json, expectedExit = 8) {
  assert.equal(result.out, `${JSON.stringify(payload, null, json ? undefined : 2)}\n`);
  assert.equal(result.code, expectedExit);
  const diagnostic = JSON.parse(result.err);
  assert.equal(diagnostic.error, 'CLI_PRESENTATION_FAILED');
  assert.equal(diagnostic.retryable, false);
  assert.equal(diagnostic.details.operationSucceeded, true);
  assert.equal(diagnostic.details.command, command);
  assert.ok(diagnostic._hint.includes('Do not repeat'));
  assert.ok(!result.err.includes('private presenter'));
  assert.ok(!result.err.includes('Retry the operation'));
}
// An unmodified package loses stdout after the first successful mutation.
for (const command of ['receipt_create', 'runtime_create']) {
  for (const json of [false, true]) {
    const before = mutations;
    const result = await run([command, '--table', 'id', ...(json ? ['--json'] : [])]);
    assert.equal(mutations, before + 1);
    assertPreserved(result, command, json);
    assert.ok(
      JSON.parse(result.err).details.cause.details.message.includes('pendingPaths, pages'),
    );
  }
}
assert.ok(isStitchErrorCode('CLI_PRESENTATION_FAILED'));
const beforeOverride = mutations;
assertPreserved(
  await run(['receipt_create', '--sum', 'id'], {
    exitCodes: { CLI_PRESENTATION_FAILED: 42 },
    errorHint: () => 'Retry the operation',
  }),
  'receipt_create',
  false,
  42,
);
assert.equal(mutations, beforeOverride + 1);
for (const mode of ['throw', 'number', 'undefined']) {
  const before = mutations;
  const native = defineCliCommand({
    name: 'native_create',
    description: 'Create a native receipt',
    input,
    output,
    handler: ({ input }) => create(input),
    present: () => {
      if (mode === 'throw') throw new Error('private presenter');
      return mode === 'number' ? 42 : undefined;
    },
  });
  assertPreserved(
    await run(['native_create', '--json'], { commands: [native] }),
    'native_create',
    true,
  );
  assert.equal(mutations, before + 1);
}
const beforeRefusal = mutations;
const refusal = await run(['receipt_create', '--refuse', '--table', 'id']);
assert.equal(refusal.code, 3);
assert.equal(refusal.out, '');
assert.equal(JSON.parse(refusal.err).error, 'FORBIDDEN');
assert.ok(!refusal.err.includes('operationSucceeded'));
assert.equal(mutations, beforeRefusal);
const beforeArgv = calls;
const badArgv = await run(['receipt_create', '--sum', 'id', '--count-by', 'id']);
assert.equal(badArgv.code, 2);
assert.equal(badArgv.out, '');
assert.equal(calls, beforeArgv);
assert.deepEqual(await run(['receipt_create', '--json']), {
  out: `${JSON.stringify(payload)}\n`,
  err: '',
  code: 0,
});
console.log('packed CLI presentation receipts: ok');
