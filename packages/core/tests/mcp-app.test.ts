/**
 * MCP Apps primitives — a contract tool carries `_meta.ui` for the MCP surface,
 * and a UI resource is served over `resources/list` / `resources/read` with the
 * apps MIME type. The generic plumbing an app builds its widgets on.
 */

import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import { buildMcpServer } from '../src/tools/mcp';
import {
  EXT_APPS_BUNDLE_PLACEHOLDER,
  inlineMcpAppBundle,
  RESOURCE_MIME_TYPE,
} from '../src/tools/mcp-app';

const RESOURCE_URI = 'ui://test/view.html';

const contract = defineContract(
  { prefix: 'gen', scope: 'public' },
  {
    show: {
      method: 'GET',
      path: '/:id',
      toolName: 'show',
      desc: 'Show a generation with a widget',
      params: z.object({ id: z.string() }),
      output: z.object({ url: z.string() }),
      ui: { resourceUri: RESOURCE_URI },
    },
  },
);

const service = implement(contract, {
  show: ({ params }) => ({ url: `https://cdn/${params.id}.png` }),
});

async function connect(): Promise<Client> {
  const server = buildMcpServer(
    {
      serverInfo: { name: 't', version: '1' },
      services: [service],
      resources: [
        {
          uri: RESOURCE_URI,
          name: 'Test View',
          ui: { csp: { resourceDomains: ['https://cdn'] } },
          read: () => '<!doctype html><img id="i">',
        },
      ],
    },
    undefined,
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
}

describe('MCP Apps — _meta.ui on tool', () => {
  test('tool list carries _meta.ui.resourceUri', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const show = tools.find((t) => t.name === 'show');
    expect(show?._meta?.ui).toEqual({ resourceUri: RESOURCE_URI });
    await client.close();
  });
});

describe('MCP Apps — UI resource', () => {
  test('resource is listed with the apps MIME type', async () => {
    const client = await connect();
    const { resources } = await client.listResources();
    const res = resources.find((r) => r.uri === RESOURCE_URI);
    expect(res?.mimeType).toBe(RESOURCE_MIME_TYPE);
    await client.close();
  });

  test('resource read returns the widget HTML + ui meta', async () => {
    const client = await connect();
    const read = await client.readResource({ uri: RESOURCE_URI });
    const content = read.contents[0];
    expect(content?.mimeType).toBe(RESOURCE_MIME_TYPE);
    expect(content && 'text' in content ? content.text : '').toContain('<img');
    expect(content?._meta?.ui).toEqual({ csp: { resourceDomains: ['https://cdn'] } });
    await client.close();
  });
});

describe('inlineMcpAppBundle', () => {
  test('HTML without the placeholder is returned unchanged', () => {
    const html = '<!doctype html><body>no bundle</body>';
    expect(inlineMcpAppBundle(html)).toBe(html);
  });

  test('inlines the installed ext-apps runtime', () => {
    const html = `<script>${EXT_APPS_BUNDLE_PLACEHOLDER}</script>`;
    const inlined = inlineMcpAppBundle(html);

    expect(inlined).not.toContain(EXT_APPS_BUNDLE_PLACEHOLDER);
    expect(inlined).toContain('globalThis.ExtApps=');
    expect(inlined.length).toBeGreaterThan(html.length);
  });
});
