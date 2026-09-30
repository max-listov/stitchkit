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
import { buildMcpServer } from '../src/tools/mcp/mount';
import { defineViewFileTool } from '../src/tools/transfer/define-view-file-tool';
import {
  mountViewFile,
  resolveMedia,
  runViewFileOperation,
  ViewFileInputSchema,
  ViewFileOutputSchema,
} from '../src/tools/transfer/view-file';

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
    await writeFile(join(root, '[preview].PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
        text: '[secret.json] Error: refusing to read "secret.json" — ".json" is not a media extension',
      },
    ]);
    expect(mcp.structuredContent).toMatchObject({
      errors: [
        {
          path: 'secret.json',
          message: 'refusing to read "secret.json" — ".json" is not a media extension',
        },
      ],
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
      text: '[secret.json] Error: refusing to read "secret.json" — ".json" is not a media extension',
    });
    await client.close();
  });

  test('JSON lists written as text fail validation before managed MCP/Agent IO', async () => {
    const definition = defineViewFileTool({
      description: 'Inspect protected media',
      identity: { serviceName: 'media', action: 'view' },
      files,
    });
    const client = await connect(
      buildMcpServer(
        {
          serverInfo: { name: 'view-input', version: '1' },
          services: [],
          runtimeTools: [definition],
        },
        undefined,
      ),
    );
    const execute = mountAgent([], { runtimeTools: [definition] }).view_file?.execute;
    if (!execute) throw new Error('expected executable managed view_file');
    const read = spyOn(files, 'read');
    const fetchMock = spyOn(globalThis, 'fetch');
    const hint = 'paths is a list written as text — pass an array of paths or one path';
    try {
      for (const paths of [
        '["nested/pic.png"]',
        '  ["https://example.com/pic.png"]\n',
        '["nested/pic.png", "nested/pic.png"]',
        '[]',
        ['["nested/pic.png"]'],
      ]) {
        const input = { paths };
        const parsed = ViewFileInputSchema.safeParse(input);
        expect(parsed.success).toBe(false);
        if (parsed.success) throw new Error('expected a validation error');
        expect(parsed.error.issues).toContainEqual(expect.objectContaining({ message: hint }));
        const mcp = await client.callTool({ name: 'view_file', arguments: input });
        expect(mcp.isError).toBe(true);
        expect(JSON.stringify(mcp)).toContain('VALIDATION_ERROR');
        expect(JSON.stringify(mcp)).toContain(hint);
        await expect(
          execute(input, { toolCallId: 'invalid', messages: [], context: undefined }),
        ).rejects.toMatchObject({ output: { error: 'VALIDATION_ERROR' } });
      }
      expect(read).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      for (const paths of ['nested/pic.png', ['nested/pic.png', '[preview].PNG']]) {
        const input = { paths };
        const images = Array.isArray(paths) ? paths.length : 1;
        const mcp = await client.callTool({ name: 'view_file', arguments: input });
        expect(mcp.isError).not.toBe(true);
        expect(mcp.content.filter((part) => part.type === 'image')).toHaveLength(images);
        const agent = ViewFileOutputSchema.parse(
          await execute(input, { toolCallId: 'valid', messages: [], context: undefined }),
        );
        expect(agent.errors).toEqual([]);
        expect(agent.content.filter((part) => part.type === 'image')).toHaveLength(images);
      }
    } finally {
      read.mockRestore();
      fetchMock.mockRestore();
      await client.close();
    }
  });

  test('raw MCP refuses a text list and reads one path or a real array', async () => {
    const server = new McpServer({ name: 'raw-view-input', version: '1' });
    mountViewFile(server, { files });
    const client = await connect(server);
    const read = spyOn(files, 'read');
    try {
      const rejected = await client.callTool({
        name: 'view_file',
        arguments: { paths: '["nested/pic.png"]' },
      });
      expect(rejected.isError).toBe(true);
      expect(JSON.stringify(rejected)).toContain('paths is a list written as text');
      expect(read).not.toHaveBeenCalled();
      for (const paths of ['nested/pic.png', ['nested/pic.png', '[preview].PNG']]) {
        const accepted = await client.callTool({ name: 'view_file', arguments: { paths } });
        expect(accepted.isError).not.toBe(true);
        expect(accepted.content.filter((part) => part.type === 'image')).toHaveLength(
          Array.isArray(paths) ? paths.length : 1,
        );
      }
    } finally {
      read.mockRestore();
      await client.close();
    }
  });

  test('local extension refusal identifies caller input without reading the file', async () => {
    const read = spyOn(files, 'read');
    try {
      for (const path of ['secret.json', 'missing', '["nested/pic.png"]']) {
        const extension =
          path === 'secret.json' ? '.json' : path === 'missing' ? '' : '.png"]';
        await expect(resolveMedia(path, { files })).rejects.toMatchObject({
          code: 'FILE_INSPECTION_REJECTED',
          message: `refusing to read ${JSON.stringify(path)} — ${JSON.stringify(extension)} is not a media extension`,
        });
      }
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
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
