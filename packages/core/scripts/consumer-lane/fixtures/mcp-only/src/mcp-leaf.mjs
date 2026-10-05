import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { AppError } from 'stitchkit/contract';
import { buildMcpServer, createMcpHandler, createMcpHttpRoute } from 'stitchkit/tools/mcp';
import { z } from 'zod';

const require = createRequire(import.meta.url);
assert.throws(() => require.resolve('ai'), /Cannot find module/);
assert.ok(require.resolve('@modelcontextprotocol/server'));
const observed = [];
let calls = 0;
const definition = {
  name: 'double',
  description: 'Double a number',
  identity: { serviceName: 'numbers', action: 'double', method: 'POST' },
  input: z.object({ value: z.number() }),
  output: z.object({ doubled: z.number() }),
  handler: ({ input }) => {
    calls++;
    if (input.value === -1) throw new AppError('FORBIDDEN', { message: 'Operation refused' });
    return { doubled: input.value * 2, removed: true };
  },
  present: {
    mcp: ({ doubled }) => ({ content: [{ type: 'text', text: `answer:${doubled}` }] }),
  },
};
const config = {
  serverInfo: { name: 'mcp-only', version: '1' },
  services: [],
  runtimeTools: [definition],
  auth: (request) =>
    request.headers.get('authorization') === 'Bearer fixture' ? { id: 'reader' } : null,
  hooks: { afterToolCall: ({ result }) => observed.push(result.ok) },
};
const handler = createMcpHandler(config);
const route = createMcpHttpRoute({ path: '/mcp', handler });
const direct = buildMcpServer(config, { id: 'reader' });
assert.equal(typeof direct.connect, 'function');
await direct.close();

function request(method, params = {}, extraHeaders = {}) {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer fixture',
      host: 'localhost',
      ...extraHeaders,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}
async function rpc(method, params) {
  const response = await route.handler(request(method, params), { params: {} });
  assert.equal(response.status, 200);
  const text = await response.text();
  const data = text
    .split('\n')
    .find((line) => line.startsWith('data: '))
    ?.slice(6);
  return JSON.parse(data ?? text);
}
try {
  const initialized = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fixture', version: '1' },
  });
  assert.equal(initialized.result.serverInfo.name, 'mcp-only');
  const listed = await rpc('tools/list');
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['double'],
  );
  assert.equal(listed.result.tools[0].inputSchema.properties.value.type, 'number');
  const valid = await rpc('tools/call', { name: 'double', arguments: { value: 3 } });
  assert.deepEqual(valid.result.structuredContent, { doubled: 6 });
  assert.deepEqual(valid.result.content, [{ type: 'text', text: 'answer:6' }]);
  const invalid = await rpc('tools/call', { name: 'double', arguments: { value: 'bad' } });
  assert.equal(invalid.result.isError, true);
  assert.equal(calls, 1);
  const forbidden = await rpc('tools/call', { name: 'double', arguments: { value: -1 } });
  assert.equal(forbidden.result.isError, true);
  assert.match(JSON.stringify(forbidden), /FORBIDDEN/);
  assert.deepEqual(observed, [true, false, false]);
  const unauthenticated = await handler.fetch(
    request('tools/list', {}, { authorization: '' }),
  );
  assert.equal(unauthenticated.status, 401);
  const hostileOrigin = await handler.fetch(
    request('tools/list', {}, { origin: 'https://foreign.invalid' }),
  );
  assert.equal(hostileOrigin.status, 403);
  const hostileHost = await handler.fetch(
    request('tools/list', {}, { host: 'foreign.invalid' }),
  );
  assert.equal(hostileHost.status, 403);
} finally {
  await handler.close();
}
assert.equal((await handler.fetch(request('tools/list'))).status, 503);
console.log('packed MCP-only leaf: ok');
