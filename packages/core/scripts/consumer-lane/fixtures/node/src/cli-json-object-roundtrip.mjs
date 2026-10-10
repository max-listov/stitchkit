import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCli } from 'stitchkit/cli';
import { defineMcpClientConnection, mountConnections } from 'stitchkit/tools/connections';
import { z } from 'zod';

const inputSchema = z.toJSONSchema(
  z.object({ data: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.unknown()) }),
);
const readOnlyInputSchema = structuredClone(inputSchema);
readOnlyInputSchema.properties.data.readOnly = true;
const composedInputSchema = structuredClone(inputSchema);
composedInputSchema.properties.data.allOf = [
  {
    type: 'object',
    properties: {
      nested: {
        type: 'object',
        properties: { code: { type: 'string' } },
        required: ['code'],
        additionalProperties: false,
      },
    },
    required: ['nested'],
  },
];
let calls = 0;
const server = createServer(async (request, response) => {
  if (request.method === 'GET') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body.id === undefined) {
    response.writeHead(202).end();
    return;
  }
  const result =
    body.method === 'initialize'
      ? {
          protocolVersion: '2024-11-05',
          capabilities: {},
          serverInfo: { name: 'fixture', version: '1' },
        }
      : body.method === 'tools/list'
        ? {
            tools: [
              {
                name: 'upsert',
                description: 'Upsert structured data',
                inputSchema,
              },
              {
                name: 'read-only',
                description: 'Upsert read-only structured data',
                inputSchema: readOnlyInputSchema,
              },
              {
                name: 'composed',
                description: 'Upsert composed structured data',
                inputSchema: composedInputSchema,
              },
            ],
          }
        : (() => {
            calls++;
            const args = body.params?.arguments;
            return {
              content: [{ type: 'text', text: JSON.stringify({ echoed: args }) }],
              structuredContent: { echoed: args },
            };
          })();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');

async function run(runtimeTools, argv) {
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'packed',
    version: '1',
    runtimeTools,
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

try {
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: 'fixture',
      transport: { url: `http://127.0.0.1:${address.port}/mcp` },
      transports: ['CLI'],
    }),
  ]);
  const value = '{"email":"cli-json@example.invalid","nested":{"code":"007"}}';
  for (const argv of [
    ['upsert', '--data', value, '--json'],
    ['upsert', `--data=${value}`, '--json'],
  ]) {
    const result = await run(runtimeTools, argv);
    assert.deepEqual({ err: result.err, code: result.code }, { err: '', code: 0 });
    assert.deepEqual(JSON.parse(result.out), {
      echoed: {
        data: { email: 'cli-json@example.invalid', nested: { code: '007' } },
      },
    });
  }
  for (const [command, data] of [
    ['read-only', { ok: '007' }],
    ['composed', { nested: { code: '007' } }],
  ]) {
    const result = await run(runtimeTools, [
      command,
      `--data=${JSON.stringify(data)}`,
      '--json',
    ]);
    assert.deepEqual({ err: result.err, code: result.code }, { err: '', code: 0 });
    assert.deepEqual(JSON.parse(result.out), { echoed: { data } });
  }
  assert.equal(calls, 4);
  for (const [command, value] of [
    ['upsert', '{"email":'],
    ['upsert', '[]'],
    ['upsert', '{"Bad-Key":"x"}'],
    ['read-only', '{"Bad-Key":"x"}'],
    ['composed', '{"nested":{"code":7}}'],
  ]) {
    const result = await run(runtimeTools, [command, `--data=${value}`, '--json']);
    assert.notEqual(result.code, 0);
    assert.match(result.err, /VALIDATION_ERROR/);
    assert.equal(calls, 4);
  }
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

console.log('packed CLI JSON object round-trip: ok');
