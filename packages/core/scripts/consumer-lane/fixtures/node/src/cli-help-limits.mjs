import assert from 'node:assert/strict';
import { createCli, defineCliCommand } from 'stitchkit/cli';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { defineRuntimeTool } from 'stitchkit/tools';
import { z } from 'zod';

const input = z.object({
  limit: z.int().min(1).max(50).optional().describe('Page size'),
  score: z.number().gt(0).lt(10).optional(),
  key: z.string().min(1).max(12).optional(),
  names: z.array(z.string()).min(2).max(4).optional(),
  zero: z.number().min(0).max(0).optional(),
  query: z.string().optional(),
  maybe: z.string().min(1).nullable().optional(),
});
let calls = 0;
const handler = () => {
  calls += 1;
};
const service = implement(
  defineContract(
    { prefix: 'bounds', scope: 'public' },
    {
      search: {
        method: 'POST',
        path: '/',
        desc: 'Search',
        input,
        expose: ['CLI'],
        tool: { name: 'search' },
      },
    },
  ),
  { search: handler },
);
const native = defineCliCommand({ name: 'local', description: 'Local', input, handler });
const runtime = defineRuntimeTool({
  name: 'runtime',
  description: 'Runtime',
  input,
  transports: ['CLI'],
  identity: { serviceName: 'bounds', action: 'runtime', method: 'POST' },
  handler,
});
async function run(argv) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'bounds',
    version: '1',
    services: [service],
    commands: [native],
    runtimeTools: [runtime],
    globalOptions: z.object({ budget: z.number().gt(0).max(30).optional() }),
    argv,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (value) => {
      code = value;
    },
    stdin: async () => null,
  });
  return { out, err, code };
}
for (const command of ['local', 'search', 'runtime']) {
  const before = calls;
  const { out, err, code } = await run([command, '--help']);
  assert.equal(code, 0);
  assert.equal(err, '');
  assert.equal(calls, before);
  assert.ok(out.includes('<integer> [>=1, <=50] — Page size'));
  assert.ok(out.includes('<number> [>0, <10]'));
  assert.ok(out.includes('<string> [length >=1, length <=12]'));
  assert.ok(out.includes('<value…> [items >=2, items <=4]'));
  assert.ok(out.includes('<number> [>=0, <=0]'));
  assert.ok(out.includes('[any of: string [length >=1] | null]'));
  assert.ok(out.includes('--budget <number> [>0, <=30]'));
  const query = out.split('\n').find((line) => line.includes('--query '));
  assert.ok(query?.trimEnd().endsWith('<string>'));
  assert.equal((await run([command, '--limit', '50'])).code, 0);
  assert.equal(calls, before + 1);
  for (const value of ['0', '51']) {
    assert.notEqual((await run([command, '--limit', value])).code, 0);
    assert.equal(calls, before + 1);
  }
}
assert.ok((await run(['--help'])).out.includes('--budget <number> [>0, <=30]'));
console.log('packed CLI help limits: ok');
