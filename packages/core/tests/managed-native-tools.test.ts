import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AppError } from '../src/contract';
import { createManagedFileBoundary } from '../src/files/boundary';
import { mountAgent } from '../src/tools/agent';
import { defineDownloadTool } from '../src/tools/define-download-tool';
import { defineUploadTool } from '../src/tools/define-upload-tool';
import { defineWaitTool } from '../src/tools/define-wait-tool';
import { listToolNames } from '../src/tools/list-names';
import { buildToolManifest } from '../src/tools/manifest';
import { buildMcpServer } from '../src/tools/mcp';
import { summarizeTransports } from '../src/tools/transports';

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'managed-native-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function executable(tools: ReturnType<typeof mountAgent>, name: string) {
  const execute = tools[name]?.execute;
  if (!execute) throw new Error(`expected executable tool ${name}`);
  return execute;
}

const WaitInputSchema = z.object({ id: z.string() });
const WaitStateSchema = z.object({ id: z.string(), status: z.enum(['DONE', 'FAILED']) });

describe('managed generic native tools', () => {
  test('wait shares one definition across MCP, Agent, lifecycle, hooks and introspection', async () => {
    let polls = 0;
    const phases: string[] = [];
    const wait = defineWaitTool({
      name: 'wait_for_job',
      description: 'Wait for a job',
      identity: { serviceName: 'jobs', action: 'waitForJob', scope: 'user' },
      input: WaitInputSchema,
      state: WaitStateSchema,
      poll: async ({ id }, context) => {
        const source = context.source;
        void source;
        polls += 1;
        return WaitStateSchema.parse({ id, status: 'DONE' });
      },
      done: (state) => state.status !== 'FAILED',
      backoff: [0],
      render: (state) => ({ text: `job ${state.id}: ${state.status}`, isError: false }),
    });

    expect(buildToolManifest({ runtimeTools: [wait], transport: 'MCP' })).toEqual([
      expect.objectContaining({
        name: 'wait_for_job',
        inputSchema: expect.objectContaining({ type: 'object' }),
      }),
    ]);
    expect(listToolNames({ runtimeTools: [wait] })).toEqual([
      {
        name: 'wait_for_job',
        service: 'jobs',
        method: 'waitForJob',
        kind: 'runtime',
        transports: ['MCP', 'AGENT'],
      },
    ]);
    expect(summarizeTransports({ runtimeTools: [wait] }).totals).toEqual({
      HTTP: 0,
      MCP: 1,
      AGENT: 1,
      CLI: 0,
    });

    const server = buildMcpServer(
      {
        serverInfo: { name: 'managed-native', version: '1' },
        services: [],
        context: () => ({ userId: 'u1' }),
        runtimeTools: [wait],
        lifecycle: {
          beforeHandle: (context, endpoint) => {
            expect(context.userId).toBe('u1');
            expect(endpoint).toMatchObject({ serviceName: 'jobs', key: 'waitForJob' });
            phases.push('lifecycle');
          },
        },
        hooks: {
          beforeToolCall: () => void phases.push('before'),
          afterToolCall: ({ result }) => void phases.push(result.ok ? 'success' : result.code),
        },
      },
      undefined,
    );
    const client = await connect(server);
    const mcp = await client.callTool({
      name: 'wait_for_job',
      arguments: { id: 'mcp-job' },
    });
    expect(mcp.structuredContent).toEqual({ id: 'mcp-job', status: 'DONE' });
    expect(mcp.content).toEqual([{ type: 'text', text: 'job mcp-job: DONE' }]);
    expect(phases).toEqual(['before', 'lifecycle', 'success']);

    const agent = mountAgent([], { runtimeTools: [wait] });
    expect(
      await executable(agent, 'wait_for_job')(
        { id: 'agent-job' },
        { toolCallId: 'agent-job', messages: [], context: undefined },
      ),
    ).toEqual({ id: 'agent-job', status: 'DONE' });
    expect(polls).toBe(2);
    await client.close();
  });

  test('lifecycle rejects an effectful managed call before its operation runs', async () => {
    let polls = 0;
    const terminal: string[] = [];
    const wait = defineWaitTool({
      description: 'Wait under a denied scope',
      identity: { serviceName: 'jobs', action: 'wait', scope: 'admin' },
      input: WaitInputSchema,
      state: WaitStateSchema,
      poll: async ({ id }) => {
        polls += 1;
        return WaitStateSchema.parse({ id, status: 'DONE' });
      },
      done: () => true,
    });
    const client = await connect(
      buildMcpServer(
        {
          serverInfo: { name: 'managed-native', version: '1' },
          services: [],
          runtimeTools: [wait],
          lifecycle: {
            beforeHandle: () => {
              throw new AppError('FORBIDDEN', 'Denied', 403);
            },
          },
          hooks: {
            afterToolCall: ({ result }) =>
              void terminal.push(result.ok ? 'success' : result.code),
          },
        },
        undefined,
      ),
    );

    const result = await client.callTool({ name: 'wait', arguments: { id: 'blocked' } });
    expect(result.isError).toBe(true);
    expect(polls).toBe(0);
    expect(terminal).toEqual(['FORBIDDEN']);
    await client.close();
  });

  test('wait cancellation interrupts the current sleep and performs no later poll', async () => {
    let polls = 0;
    const controller = new AbortController();
    const wait = defineWaitTool({
      description: 'Cancellable wait',
      identity: { serviceName: 'jobs', action: 'wait' },
      input: WaitInputSchema,
      state: WaitStateSchema,
      poll: async ({ id }) => {
        polls += 1;
        return WaitStateSchema.parse({ id, status: 'FAILED' });
      },
      done: () => false,
      backoff: [60],
    });
    const pending = wait.handler({
      params: undefined,
      input: { id: 'cancelled' },
      source: 'mcp',
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error('cancelled by caller'));

    await expect(pending).rejects.toThrow('cancelled by caller');
    expect(polls).toBe(1);
  });

  test('download validates neutral output and forwards cancellation to guarded fetch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sk-managed-download-'));
    const files = await createManagedFileBoundary({ root: dir });
    let fetchSignal: AbortSignal | null | undefined;
    const fetchMock: typeof fetch = Object.assign(
      (_input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> => {
        fetchSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener(
            'abort',
            () => reject(fetchSignal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
      { preconnect: (): void => undefined },
    );
    const spy = spyOn(globalThis, 'fetch').mockImplementation(fetchMock);
    try {
      const download = defineDownloadTool({
        description: 'Download a URL',
        identity: { serviceName: 'files', action: 'download' },
        input: z.object({ url: z.url() }),
        resolveUrl: ({ url }) => url,
        files,
        allowPrivateHosts: true,
      });
      const controller = new AbortController();
      const pending = download.handler({
        params: undefined,
        input: { url: 'https://example.com/file.png' },
        source: 'mcp',
        signal: controller.signal,
      });
      await Promise.resolve();
      controller.abort(new Error('download cancelled'));

      await expect(pending).rejects.toThrow('download cancelled');
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('upload is a typed managed operation on MCP and Agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sk-managed-upload-'));
    await writeFile(join(dir, 'mcp.png'), 'mcp');
    await writeFile(join(dir, 'agent.png'), 'agent');
    const files = await createManagedFileBoundary({ root: dir });
    const calls: Array<{ path: string; source: string; aborted: boolean }> = [];
    const upload = defineUploadTool({
      description: 'Upload a local file',
      identity: { serviceName: 'files', action: 'upload', scope: 'user' },
      output: z.object({ url: z.url() }),
      files,
      upload: async (file, context) => {
        calls.push({
          path: file.ref.path,
          source: context.source,
          aborted: context.signal?.aborted ?? false,
        });
        return { url: `https://example.com/${file.ref.path}` };
      },
    });
    const client = await connect(
      buildMcpServer(
        {
          serverInfo: { name: 'managed-native', version: '1' },
          services: [],
          runtimeTools: [upload],
        },
        undefined,
      ),
    );
    const mcp = await client.callTool({ name: 'upload', arguments: { path: 'mcp.png' } });
    expect(mcp.structuredContent).toEqual({ url: 'https://example.com/mcp.png' });

    const agent = mountAgent([], { runtimeTools: [upload] });
    expect(
      await executable(agent, 'upload')(
        { path: 'agent.png' },
        { toolCallId: 'upload', messages: [], context: undefined },
      ),
    ).toEqual({ url: 'https://example.com/agent.png' });
    expect(calls).toEqual([
      { path: 'mcp.png', source: 'mcp', aborted: false },
      { path: 'agent.png', source: 'agent', aborted: false },
    ]);
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
});
