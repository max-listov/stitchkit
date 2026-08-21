import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import {
  createManagedFileBoundary,
  type ManagedFileBoundary,
  ManagedFileError,
} from '../src/files/boundary';
import { mountAgent } from '../src/tools/agent';
import { defineViewFileTool } from '../src/tools/define-view-file-tool';
import { buildMcpServer } from '../src/tools/mcp';
import { mountViewFile, runViewFileOperation } from '../src/tools/view-file';

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'managed-view-file-test', version: '1' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('managed view_file definition', () => {
  let root = '';
  let files: ManagedFileBoundary;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'sk-managed-view-'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, 'nested', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'secret.json'), '{"secret":true}');
    files = await createManagedFileBoundary({ root });
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test('one definition preserves MCP/Agent media and honest mixed-batch errors', async () => {
    const phases: string[] = [];
    const definition = defineViewFileTool({
      description: 'Inspect protected media',
      identity: { serviceName: 'media', action: 'view', scope: 'user' },
      files,
    });
    const client = await connect(
      buildMcpServer(
        {
          serverInfo: { name: 'managed-view', version: '1' },
          services: [],
          runtimeTools: [definition],
          lifecycle: {
            beforeHandle: (_context, endpoint) => {
              phases.push(`${endpoint.serviceName}:${endpoint.key}`);
            },
          },
          hooks: {
            afterToolCall: ({ result }) => {
              phases.push(`hook:${result.ok}`);
            },
          },
        },
        undefined,
      ),
    );
    const mcp = await client.callTool({
      name: 'view_file',
      arguments: { paths: ['nested/pic.png', 'secret.json'] },
    });
    expect(mcp.isError).not.toBe(true);
    expect(mcp.content).toEqual([
      expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
      { type: 'text', text: '[image] image/png, 0KB' },
      {
        type: 'text',
        text: '[secret.json] Error: refusing to read a non-media file',
      },
    ]);
    expect(mcp.structuredContent).toMatchObject({
      errors: [{ path: 'secret.json', message: 'refusing to read a non-media file' }],
    });

    const agentTools = mountAgent([], {
      runtimeTools: [definition],
      lifecycle: {
        beforeHandle: (_context, endpoint) => {
          phases.push(`${endpoint.serviceName}:${endpoint.key}`);
        },
      },
      hooks: {
        afterToolCall: ({ result }) => {
          phases.push(`hook:${result.ok}`);
        },
      },
    });
    const execute = agentTools.view_file?.execute;
    if (!execute) throw new Error('expected executable managed view_file');
    const output = await execute(
      { paths: 'nested/pic.png' },
      { toolCallId: 'view', messages: [], context: undefined },
    );
    const toModelOutput = agentTools.view_file?.toModelOutput;
    if (!toModelOutput) throw new Error('expected view_file Agent presenter');
    const agent = await toModelOutput({
      toolCallId: 'view',
      input: { paths: 'nested/pic.png' },
      output,
    });
    expect(agent).toEqual({
      type: 'content',
      value: [
        expect.objectContaining({
          type: 'file',
          mediaType: 'image/png',
        }),
        { type: 'text', text: '[image] image/png, 0KB' },
      ],
    });
    expect(phases).toEqual(['media:view', 'hook:true', 'media:view', 'hook:true']);
    await client.close();
  });

  test('the raw mount keeps its content-only MCP envelope over the shared operation', async () => {
    const server = new McpServer({ name: 'raw-view', version: '1' });
    mountViewFile(server, { files });
    const client = await connect(server);
    const result = await client.callTool({
      name: 'view_file',
      arguments: { paths: ['nested/pic.png', 'secret.json'] },
    });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'image', mimeType: 'image/png' }),
    );
    expect(result.content).toContainEqual({
      type: 'text',
      text: '[secret.json] Error: refusing to read a non-media file',
    });
    await client.close();
  });

  test('a batch shares one total inline byte budget', async () => {
    const bytes = new Uint8Array(12 * 1024 * 1024);
    const fetchImplementation: typeof fetch = Object.assign(
      async (): Promise<Response> =>
        new Response(bytes, {
          headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.length),
          },
        }),
      { preconnect: (): void => undefined },
    );
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
    try {
      const result = await runViewFileOperation(
        ['http://127.0.0.1/one.png', 'http://127.0.0.1/two.png'],
        { allowPrivateHosts: true },
      );
      expect(result.content.filter((part) => part.type === 'image')).toHaveLength(1);
      expect(result.content).toContainEqual({
        type: 'text',
        text: '[image/png] too large to inline — http://127.0.0.1/two.png',
      });
      expect(result.errors).toEqual([]);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('managed cancellation reaches the guarded fetch instead of becoming an item error', async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetchImplementation: typeof fetch = Object.assign(
      async (
        _input: string | URL | Request,
        init?: BunFetchRequestInit,
      ): Promise<Response> => {
        fetchSignal = init?.signal ?? undefined;
        return await new Promise<Response>((_resolve, reject) => {
          fetchSignal?.addEventListener(
            'abort',
            () => reject(fetchSignal?.reason ?? new Error('aborted')),
            { once: true },
          );
        });
      },
      { preconnect: (): void => undefined },
    );
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(fetchImplementation);
    try {
      const definition = defineViewFileTool({
        description: 'Inspect remote media',
        identity: { serviceName: 'media', action: 'view' },
        allowPrivateHosts: true,
      });
      const controller = new AbortController();
      const pending = definition.handler({
        params: undefined,
        input: { paths: 'https://example.com/image.png' },
        source: 'mcp',
        signal: controller.signal,
      });
      await Promise.resolve();
      controller.abort(new Error('view cancelled'));
      await expect(pending).rejects.toThrow('view cancelled');
      expect(fetchSignal?.aborted).toBe(true);
    } finally {
      fetchMock.mockRestore();
    }
  });

  test('partial failures keep caller input but scrub derived filesystem causes', async () => {
    const derivedPath = '/srv/private/application-root/image.png';
    const internalFiles: ManagedFileBoundary = {
      read: async () => {
        throw new ManagedFileError('FILE_IO_ERROR', `EACCES ${derivedPath}`);
      },
      write: async () => {
        throw new Error('unused');
      },
    };
    const log = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const internal = await runViewFileOperation('caller-image.png', {
        files: internalFiles,
      });
      expect(internal.errors).toEqual([
        { path: 'caller-image.png', message: 'Internal server error' },
      ]);
      expect(JSON.stringify(internal)).not.toContain(derivedPath);
      expect(log).toHaveBeenCalled();

      const safeFiles: ManagedFileBoundary = {
        read: async () => {
          throw new ManagedFileError('FILE_NOT_FOUND', `missing at ${derivedPath}`);
        },
        write: async () => {
          throw new Error('unused');
        },
      };
      const safe = await runViewFileOperation('caller-image.png', { files: safeFiles });
      expect(safe.errors).toEqual([
        { path: 'caller-image.png', message: 'Managed file not found' },
      ]);
      expect(JSON.stringify(safe)).not.toContain(derivedPath);
    } finally {
      log.mockRestore();
    }
  });
});
