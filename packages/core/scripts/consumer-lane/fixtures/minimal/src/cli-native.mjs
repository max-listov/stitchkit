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
