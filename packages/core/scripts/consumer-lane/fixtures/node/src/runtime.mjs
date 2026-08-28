import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createClient } from 'stitchkit';
import { createMemoryAgentRuntimeStore } from 'stitchkit/agent-runtime';
import {
  createBoundedAdmission,
  createBoundedChannel,
  createCreditWindow,
} from 'stitchkit/application';
import { createCli, defineCliCommand } from 'stitchkit/cli';
import { defineContract } from 'stitchkit/contract';
import { createHandler, implement } from 'stitchkit/server';
import { createAgentRaceTrace } from 'stitchkit/testing';
import { createMcpHandler } from 'stitchkit/tools';
import { z } from 'zod';

const agentStore = createMemoryAgentRuntimeStore();
const agentSnapshot = await agentStore.loadSnapshot('packed-node-agent');
assert.equal(agentSnapshot.version, 0);
const agentTrace = createAgentRaceTrace();
agentTrace.record('admission');
agentTrace.record('terminal');
agentTrace.assertSequence(['admission', 'terminal']);

const inspect = defineCliCommand({
  name: 'inspect',
  description: 'Inspect the packed Node executable',
  input: z.object({ target: z.string(), verbose: z.boolean().default(false) }),
  output: z.object({ target: z.string(), verbose: z.boolean() }),
  handler: ({ input }) => input,
  present: ({ result }) => `inspect:${result.target}:${result.verbose}\n`,
  exitCode: () => 6,
});
let cliOutput = '';
let cliExit = -1;
await createCli({
  name: 'packed-node-cli',
  version: '1',
  commands: [inspect],
  defaultCommand: 'inspect',
  optionAliases: { inspect: { v: 'verbose' } },
  positionals: { inspect: ['target'] },
  argv: ['inspect', 'packed', '-v'],
  stdout: (text) => {
    cliOutput += text;
  },
  stderr: () => undefined,
  stdin: async () => null,
  exit: (code) => {
    cliExit = code;
  },
});
assert.equal(cliOutput, 'inspect:packed:true\n');
assert.equal(cliExit, 6);

const contract = defineContract(
  { prefix: 'node-http', scope: 'public' },
  {
    echo: {
      method: 'POST',
      path: '/echo',
      desc: 'Echo through a packed Node HTTP consumer',
      expose: ['MCP'],
      toolName: 'echo_node_http',
      input: z.object({ text: z.string() }),
      output: z.object({ text: z.string() }),
    },
  },
);
const service = implement(contract, { echo: ({ input }) => input });
const handler = createMcpHandler({
  serverInfo: { name: 'packed-node-http', version: '1' },
  auth: () => ({}),
  security: { allowedHosts: ['consumer.test'] },
  services: [service],
});
const httpTransport = new StreamableHTTPClientTransport(new URL('http://consumer.test/mcp'), {
  fetch: (input, init) => handler.fetch(new Request(input, init)),
});
const httpClient = new Client(
  { name: 'packed-node-http', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await httpClient.connect(httpTransport);
assert.deepEqual(
  (
    await httpClient.callTool({
      name: 'echo_node_http',
      arguments: { text: 'packed Node HTTP' },
    })
  ).structuredContent,
  { text: 'packed Node HTTP' },
);
await httpClient.close();
await handler.close();

const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('./stdio-server.mjs', import.meta.url).pathname],
  stderr: 'pipe',
});
const stdioClient = new Client(
  { name: 'packed-node-stdio', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await stdioClient.connect(stdioTransport);
const result = await stdioClient.callTool({
  name: 'echo_node',
  arguments: { text: 'packed Node stdio' },
});
assert.deepEqual(result.structuredContent, { text: 'packed Node stdio' });
await stdioClient.close();

const streamContract = defineContract(
  { prefix: 'node-stream' },
  {
    read: {
      method: 'GET',
      path: '/',
      desc: 'Read a packed Node stream',
      stream: {
        item: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('line'), value: z.number() }),
          z.object({ kind: z.literal('complete') }),
        ]),
        terminal: z.object({ kind: z.literal('complete') }),
      },
    },
  },
);
const streamHandler = createHandler({
  services: [
    implement(streamContract, {
      read: async function* () {
        yield { kind: 'line', value: 1 };
        yield { kind: 'complete' };
      },
    }),
  ],
});
const streamClient = createClient(streamContract, {
  baseUrl: 'http://packed-node',
  fetch: (input, init) => streamHandler(new Request(input, init)),
});
const streamValues = [];
for await (const value of await streamClient.read()) streamValues.push(value);
assert.deepEqual(streamValues, [{ kind: 'line', value: 1 }, { kind: 'complete' }]);

const bounded = createBoundedAdmission({
  policy: { global: { maxConcurrent: 1 } },
});
const boundedLease = bounded.acquire();
assert.equal(boundedLease.outcome, 'leased');
assert.equal(bounded.acquire().outcome, 'refused');
if (boundedLease.outcome === 'leased') boundedLease.lease.release();

const channel = createBoundedChannel({
  policy: 'ordered',
  maxItems: 2,
  maxBytes: 2,
  sizeOf: () => 1,
});
channel.offer('one');
channel.offer('two');
channel.close();
const channelValues = [];
for await (const value of channel) channelValues.push(value);
assert.deepEqual(channelValues, ['one', 'two']);

const credit = createCreditWindow({ capacityBytes: 2 });
const creditLease = credit.acquire(2);
assert.equal(creditLease.outcome, 'leased');
assert.equal(credit.acquire(1).outcome, 'refused');
if (creditLease.outcome === 'leased') creditLease.lease.release();

console.log('node consumer: ok (HTTP + stdio MCP + bounded transport primitives)');
