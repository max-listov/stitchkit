import { describe, expect, test } from 'bun:test';
import { defineContract } from 'stitchkit/contract';
import { generateOpenApiDocument, implement } from 'stitchkit/server';
import { z } from 'zod';
import { assertSurfaceConformance, buildSurfaceManifest } from './surface-manifest';

const service = implement(
  defineContract(
    { prefix: 'notes' },
    {
      read: {
        method: 'GET',
        path: '/:id',
        desc: 'Read a note',
        params: z.object({ id: z.string() }),
        output: z.object({ id: z.string() }),
      },
    },
  ),
  { read: ({ params }) => ({ id: params.id }) },
);

describe('surface conformance', () => {
  test('derives matching HTTP and MCP discovery identities without calling handlers', () => {
    const manifest = buildSurfaceManifest([service]);
    const openApi = generateOpenApiDocument({
      info: { title: 'Test', version: '1.0.0' },
      groups: [{ pathPrefix: '/api', services: [service] }],
    });
    expect(manifest).toEqual([
      {
        service: 'notes',
        action: 'read',
        http: [{ method: 'GET', path: '/api/notes/{id}' }],
        tools: { AGENT: 'read_note', MCP: 'read_note' },
      },
    ]);
    expect(() =>
      assertSurfaceConformance({ manifest, openApi, mcpToolNames: ['read_note'] }),
    ).not.toThrow();
  });

  test('fails with transport-specific expected and actual diagnostics', () => {
    const manifest = buildSurfaceManifest([service]);
    expect(() =>
      assertSurfaceConformance({ manifest, openApi: { paths: {} }, mcpToolNames: [] }),
    ).toThrow('HTTP/OpenAPI surface mismatch');
    expect(() =>
      assertSurfaceConformance({
        manifest: manifest.map((operation) => ({ ...operation, http: [] })),
        openApi: { paths: {} },
        mcpToolNames: ['unexpected'],
      }),
    ).toThrow('MCP discovery surface mismatch');
  });

  test('fails first on duplicate contract identity', () => {
    expect(() => buildSurfaceManifest([service, service])).toThrow(
      'Duplicate operation identity notes.read',
    );
  });
});
