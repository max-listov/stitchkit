/**
 * The generic native MCP tools — `mountWait`, `mountDownload`, `mountUpload`
 * (ADR 0019) — and the shared `textResult` envelope. Each tool is exercised
 * through a real in-memory `McpServer` ↔ `Client` round-trip so the asserted
 * `content` / `isError` shape is exactly what an MCP client receives. Locks in
 * the error framing (`Wait failed:` / `Download failed:` / `Upload failed:`)
 * that the try/catch boundary owns rather than leaning on the SDK's catch.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { isRecord } from '../src/internal/typed';
import { mountDownload } from '../src/tools/mount-download';
import { mountUpload } from '../src/tools/mount-upload';
import { mountWait } from '../src/tools/mount-wait';
import { textResult } from '../src/tools/native-result';

/** Spin up an in-memory MCP server with a single mounted tool, return a client. */
async function connectWith(mount: (server: McpServer) => void): Promise<Client> {
  const server = new McpServer({ name: 't', version: '1' });
  mount(server);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

/** First text block of a tool result — loose-read so no SDK types are cast. */
function firstText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  const block = result.content[0];
  return isRecord(block) && typeof block.text === 'string' ? block.text : '';
}

function isErr(result: unknown): boolean {
  return isRecord(result) && result.isError === true;
}

describe('textResult — envelope shape', () => {
  test('success carries no isError key', () => {
    const result = textResult('hi');
    expect(result).toEqual({ content: [{ type: 'text', text: 'hi' }] });
    expect('isError' in result).toBe(false);
  });

  test('error flags isError: true', () => {
    const result = textResult('boom', true);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'boom' });
  });
});

describe('mountWait', () => {
  test('returns the terminal state when done', async () => {
    const client = await connectWith((s) =>
      mountWait(s, {
        description: 'wait for a job',
        inputSchema: { id: z.string() },
        poll: async () => ({ status: 'COMPLETED' }),
        done: (st) => isRecord(st) && st.status === 'COMPLETED',
        backoff: [0],
      }),
    );
    const result = await client.callTool({ name: 'wait', arguments: { id: 'x' } });
    expect(isErr(result)).toBe(false);
    expect(firstText(result)).toContain('COMPLETED');
    await client.close();
  });

  test('a rejecting poll is framed "Wait failed:", not a raw throw', async () => {
    const client = await connectWith((s) =>
      mountWait(s, {
        description: 'wait',
        inputSchema: { id: z.string() },
        poll: async () => {
          throw new Error('poll exploded');
        },
        done: () => true,
        backoff: [0],
      }),
    );
    const result = await client.callTool({ name: 'wait', arguments: { id: 'x' } });
    expect(isErr(result)).toBe(true);
    expect(firstText(result)).toContain('Wait failed: poll exploded');
    await client.close();
  });
});

describe('mountUpload', () => {
  test('uploads a path and returns the result', async () => {
    const client = await connectWith((s) =>
      mountUpload(s, { description: 'upload', upload: async (path) => ({ url: path }) }),
    );
    const result = await client.callTool({ name: 'upload', arguments: { path: 'pic.png' } });
    expect(isErr(result)).toBe(false);
    expect(firstText(result)).toContain('pic.png');
    await client.close();
  });

  test('an empty path is rejected', async () => {
    const client = await connectWith((s) =>
      mountUpload(s, { description: 'upload', upload: async (path) => ({ url: path }) }),
    );
    const result = await client.callTool({ name: 'upload', arguments: { path: '' } });
    expect(isErr(result)).toBe(true);
    expect(firstText(result)).toContain('Provide `path`.');
    await client.close();
  });

  test('a throwing upload is framed "Upload failed:"', async () => {
    const client = await connectWith((s) =>
      mountUpload(s, {
        description: 'upload',
        upload: async () => {
          throw new Error('disk full');
        },
      }),
    );
    const result = await client.callTool({ name: 'upload', arguments: { path: 'f' } });
    expect(isErr(result)).toBe(true);
    expect(firstText(result)).toContain('Upload failed: disk full');
    await client.close();
  });
});

describe('mountDownload', () => {
  test('a null resolveUrl reports nothing to download', async () => {
    const client = await connectWith((s) =>
      mountDownload(s, {
        description: 'download',
        inputSchema: { id: z.string().optional() },
        resolveUrl: () => null,
        defaultDir: tmpdir(),
      }),
    );
    const result = await client.callTool({ name: 'download', arguments: {} });
    expect(isErr(result)).toBe(true);
    expect(firstText(result)).toContain('Nothing to download.');
    await client.close();
  });

  test('a throwing resolveUrl is framed "Download failed:"', async () => {
    const client = await connectWith((s) =>
      mountDownload(s, {
        description: 'download',
        inputSchema: { id: z.string().optional() },
        resolveUrl: () => {
          throw new Error('no such generation');
        },
        defaultDir: tmpdir(),
      }),
    );
    const result = await client.callTool({ name: 'download', arguments: {} });
    expect(isErr(result)).toBe(true);
    expect(firstText(result)).toContain('Download failed: no such generation');
    await client.close();
  });

  test('writes a fetched URL to disk with a content-type extension', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sk-dl-'));
    const spy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    );
    try {
      const client = await connectWith((s) =>
        mountDownload(s, {
          description: 'download',
          inputSchema: { url: z.string() },
          resolveUrl: (args) => (typeof args.url === 'string' ? args.url : null),
          defaultDir: dir,
        }),
      );
      const result = await client.callTool({
        name: 'download',
        // A public IP literal — the SSRF guard skips DNS for it, so the stubbed
        // fetch is reached without a real lookup of a fake hostname.
        arguments: { url: 'https://93.184.216.34/img.png' },
      });
      expect(isErr(result)).toBe(false);
      const parsed: unknown = JSON.parse(firstText(result));
      expect(isRecord(parsed)).toBe(true);
      if (isRecord(parsed)) {
        expect(parsed.mimeType).toBe('image/png');
        expect(parsed.size).toBe(3);
        expect(typeof parsed.path === 'string' && parsed.path.endsWith('img.png')).toBe(true);
      }
      await client.close();
    } finally {
      spy.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
