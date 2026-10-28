import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineContract } from 'stitchkit/contract';
import { implement } from 'stitchkit/server';
import { createMcpHandler } from 'stitchkit/tools/mcp';
import { z } from 'zod';

// Separate builds duplicate the provenance owner, while Zod remains one peer.
// Ordinary subpath imports share the package's split chunks and cannot prove this boundary.
async function separateClients() {
  const directory = mkdtempSync(join(process.cwd(), '.remote-verdict-bundles-'));
  const close = () => rmSync(directory, { recursive: true, force: true });
  try {
    for (const [name, source] of [
      [
        'cli',
        "export { createCli, createCliInvoker, defineCliCommand } from 'stitchkit/cli';",
      ],
      [
        'connections',
        "export { defineMcpClientConnection, mountConnections } from 'stitchkit/tools/connections';",
      ],
    ]) {
      const entry = join(directory, `${name}-entry.mjs`);
      writeFileSync(entry, source);
      execFileSync(
        'bun',
        [
          'build',
          entry,
          '--target=node',
          '--external=zod',
          '--outfile',
          join(directory, `${name}.mjs`),
        ],
        {
          stdio: 'pipe',
          timeout: 30_000,
        },
      );
    }
    return {
      cli: await import(pathToFileURL(join(directory, 'cli.mjs')).href),
      connections: await import(pathToFileURL(join(directory, 'connections.mjs')).href),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

const clients = await separateClients();
const { createCli, createCliInvoker, defineCliCommand } = clients.cli;
const { defineMcpClientConnection, mountConnections } = clients.connections;

const message =
  'Expected ISO 8601 UTC time, e.g. 2026-10-12T00:00:00Z; a bare date such as 2026-10-12 is not accepted';
const input = z.strictObject({
  createdFrom: z.iso.datetime({ error: message }),
  mode: z.enum(['safe', 'fast']),
  dates: z.array(z.iso.datetime({ error: message })).optional(),
  labels: z.record(z.email(), z.string()).optional(),
  page: z.number().default(5),
});
const contract = defineContract(
  { prefix: 'entries', scope: 'public' },
  {
    list: {
      method: 'POST',
      path: '/',
      desc: 'List entries',
      expose: ['MCP'],
      tool: { name: 'entry_list' },
      input,
      output: z.object({ count: z.number() }),
    },
  },
);
const calls = [];
const received = [];
const handler = createMcpHandler({
  serverInfo: { name: 'entries', version: '1' },
  auth: () => ({}),
  context: () => ({}),
  services: [
    implement(contract, {
      list: async ({ input: value }) => {
        received.push(value);
        return { count: 1 };
      },
    }),
  ],
});
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (request.method === 'POST') {
    const rpc = JSON.parse(body.toString('utf8'));
    if (rpc.method === 'tools/call') calls.push(rpc.params);
  }
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
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');

try {
  const runtimeTools = await mountConnections([
    defineMcpClientConnection({
      name: 'entries',
      transports: ['CLI'],
      transport: { url: `http://127.0.0.1:${address.port}/mcp` },
    }),
  ]);
  const invoker = await createCliInvoker({ name: 'entries', runtimeTools });
  const valid = { createdFrom: '2026-10-12T00:00:00Z', mode: 'safe' };
  const invalid = { ...valid, createdFrom: '2026-10-12' };
  const result = await invoker.invoke('entry_list', invalid);
  assert.equal(calls.length, 1, 'foreign format must reach real remote tools/call');
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'VALIDATION_ERROR');
  assert.equal(result.error?.retryable, false);
  assert.equal(result.error?.message, `Invalid input: createdFrom: ${message}`);
  assert.deepEqual(result.error?.details, {
    message: `Invalid input: createdFrom: ${message}`,
  });
  assert.deepEqual(calls[0], { name: 'entry_list', arguments: invalid });
  assert.deepEqual(received, []);

  let out = '';
  let err = '';
  let exit = -1;
  await createCli({
    name: 'entries',
    version: '1',
    runtimeTools,
    argv: ['entry_list', '--createdFrom', '2026-10-12', '--mode', 'safe', '--json'],
    stdin: async () => null,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    exit: (code) => {
      exit = code;
    },
  });
  assert.equal(exit, 1);
  assert.equal(out, '');
  assert.deepEqual(JSON.parse(err), {
    error: 'VALIDATION_ERROR',
    retryable: false,
    details: { message: `Invalid input: createdFrom: ${message}` },
  });
  assert.equal(calls.length, 2);

  for (const args of [
    { ...valid, dates: ['2026-10-12'] },
    { ...valid, labels: { wrong: 'value' } },
  ]) {
    const before = calls.length;
    const failed = await invoker.invoke('entry_list', args);
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, 'VALIDATION_ERROR');
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1), { name: 'entry_list', arguments: args });
  }
  const before = calls.length;
  for (const args of [
    { ...valid, createdFrom: 123 },
    { mode: 'safe' },
    { ...valid, extra: true },
    { ...valid, mode: 'unknown' },
    { ...invalid, mode: 'unknown' },
    { ...valid, page: 'not-a-number' },
  ]) {
    const failed = await invoker.invoke('entry_list', args);
    assert.equal(failed.ok, false);
    assert.equal(failed.error?.code, 'VALIDATION_ERROR');
    assert.ok(!failed.error?.message.includes('Invalid ISO datetime'));
    assert.ok(!failed.error?.message.includes('must match pattern'));
    assert.equal(calls.length, before);
  }
  assert.deepEqual(received, []);
  assert.equal((await invoker.invoke('entry_list', valid)).ok, true);
  assert.deepEqual(calls.at(-1), { name: 'entry_list', arguments: { ...valid, page: 5 } });
  assert.deepEqual(received, [{ ...valid, page: 5 }]);

  let localCalls = 0;
  const local = await createCliInvoker({
    name: 'local',
    commands: [
      defineCliCommand({
        name: 'local_list',
        description: 'Local list',
        input,
        output: z.object({ count: z.number() }),
        handler: () => {
          localCalls += 1;
          return { count: 1 };
        },
      }),
    ],
  });
  const refused = await local.invoke('local_list', invalid);
  assert.equal(refused.ok, false);
  assert.equal(refused.error?.message, `Invalid input: createdFrom: ${message}`);
  assert.equal(localCalls, 0);
} finally {
  await handler.close();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
  clients.close();
}
console.log('packed remote schema verdict: ok');
