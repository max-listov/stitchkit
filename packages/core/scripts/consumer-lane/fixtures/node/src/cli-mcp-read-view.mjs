// A CLI built over a Stitchkit MCP surface — not over the contract — withholds
// a refused read view. The CLI never sees the HTTP method: the server publishes
// `readOnlyHint` for a GET that declared none, and the client connection carries
// it onto the mounted tool.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCli } from 'stitchkit/cli';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { defineMcpClientConnection, mountConnections } from 'stitchkit/tools/connections';
import { createMcpHandler } from 'stitchkit/tools/mcp';
import { z } from 'zod';
import { listenFetchable } from './listen-fetchable.mjs';

const Bots = z.array(z.object({ id: z.string(), name: z.string() }));
const bots = [
  { id: 'b1', name: 'first' },
  { id: 'b2', name: 'second' },
];
const contract = defineContract(
  { prefix: 'bots', scope: 'public' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List bots',
      expose: ['MCP'],
      output: Bots,
      tool: { name: 'bot_list' },
    },
    create: {
      method: 'POST',
      path: '/',
      desc: 'Create bots',
      expose: ['MCP'],
      output: Bots,
      tool: { name: 'bot_create' },
    },
  },
);
const handler = createMcpHandler({
  serverInfo: { name: 'bots', version: '1' },
  auth: () => ({}),
  context: () => ({}),
  services: [implement(contract, { list: () => bots, create: () => bots })],
});
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const result = await handler.fetch(
    new Request(new URL(request.url, `http://${request.headers.host}`), {
      method: request.method,
      headers,
      ...(body.length > 0 ? { body } : {}),
    }),
  );
  response.writeHead(result.status, Object.fromEntries(result.headers));
  response.end(Buffer.from(await result.arrayBuffer()));
});
const port = await listenFetchable(server);

async function run(argv) {
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: 'bots',
      transports: ['CLI'],
      transport: { url: `http://127.0.0.1:${port}/mcp` },
    }),
  ]);
  let out = '';
  let err = '';
  let code = -1;
  await createCli({
    name: 'bots',
    version: '1.0.0',
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
  const refusedRead = await run(['bot_list', '--table', 'id,nosuchcolumn']);
  assert.notEqual(refusedRead.code, 0);
  assert.equal(refusedRead.out, '');
  const readDiagnostic = JSON.parse(refusedRead.err);
  assert.equal(readDiagnostic.error, 'CLI_PRESENTATION_FAILED');
  assert.equal(readDiagnostic.details.resultOnStdout, false);
  assert.match(refusedRead.err, /nosuchcolumn/);

  const table = await run(['bot_list', '--table', 'id']);
  assert.equal(table.code, 0);
  assert.equal(table.err, '');
  assert.match(table.out, /b1/);

  const refusedWrite = await run(['bot_create', '--table', 'id,nosuchcolumn']);
  assert.notEqual(refusedWrite.code, 0);
  assert.deepEqual(JSON.parse(refusedWrite.out), { result: bots });
  assert.equal(JSON.parse(refusedWrite.err).details.resultOnStdout, true);
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await handler.close();
}

console.log('packed CLI over MCP read view: ok');
