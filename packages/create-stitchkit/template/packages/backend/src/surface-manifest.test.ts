import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createContractFactory } from 'stitchkit/contract';
import { generateOpenApiDocument, implement } from 'stitchkit/server';
import { z } from 'zod';
import { discoverCliCommands, discoverMcpTools } from '../../../scripts/surface-conformance';
import {
  assertManifestMatchesSnapshot,
  assertSurfaceConformance,
  buildSurfaceManifest,
} from './surface-manifest';

const NoteParamsSchema = z.object({ id: z.string() });
const NoteSchema = z.object({ id: z.string() });
// Same address and presence flags as NoteSchema — a different TYPE, for the
// snapshot-digest test. Named here, never inline in a contract (the template's
// own schema-separate-from-contract policy).
const RetypedNoteSchema = z.object({ id: z.number() });
const { defineContract } = createContractFactory<'public'>();

const service = implement(
  defineContract(
    { prefix: 'notes', scope: 'public' },
    {
      read: {
        method: 'GET',
        path: '/:id',
        desc: 'Read a note',
        params: NoteParamsSchema,
        output: NoteSchema,
        expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
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
        scope: 'public',
        hasInput: false,
        hasOutput: true,
        inputShape: null,
        outputShape: expect.stringMatching(/^[0-9a-f]{16}$/),
        http: [{ method: 'GET', path: '/api/notes/{id}' }],
        tools: { AGENT: 'read_note', CLI: 'read_note', MCP: 'read_note' },
      },
    ]);
    expect(() =>
      assertSurfaceConformance({
        manifest,
        openApi,
        mcpToolNames: ['read_note'],
        agentToolNames: ['read_note'],
        cliToolNames: ['read_note'],
        // stitchkit 0.45 emits no x-stitchkit-* metadata yet — declared, not silent.
        metadata: 'ignore',
      }),
    ).not.toThrow();
  });

  test('fails with transport-specific expected and actual diagnostics', () => {
    const manifest = buildSurfaceManifest([service]);
    expect(() =>
      assertSurfaceConformance({
        manifest,
        openApi: { paths: {} },
        mcpToolNames: [],
        agentToolNames: [],
        cliToolNames: [],
      }),
    ).toThrow('HTTP/OpenAPI surface mismatch');
    expect(() =>
      assertSurfaceConformance({
        manifest: manifest.map((operation) => ({ ...operation, http: [] })),
        openApi: { paths: {} },
        mcpToolNames: ['unexpected'],
        agentToolNames: ['read_note'],
        cliToolNames: ['read_note'],
      }),
    ).toThrow('MCP discovery surface mismatch');
  });

  test('missing Stitchkit metadata is an ERROR unless the standard-document mode is declared', () => {
    const manifest = buildSurfaceManifest([service]);
    const standardDocument = {
      paths: {
        '/api/notes/{id}': {
          get: { responses: { 200: { description: 'Success' } } },
        },
      },
    };
    const names = {
      mcpToolNames: ['read_note'],
      agentToolNames: ['read_note'],
      cliToolNames: ['read_note'],
    };
    // A silent skip was the hole: no x-stitchkit-* keys meant no comparison at
    // all. The default mode now refuses; opting out is an explicit decision.
    expect(() =>
      assertSurfaceConformance({ manifest, openApi: standardDocument, ...names }),
    ).toThrow(/no x-stitchkit-\* contract metadata/);
    expect(() =>
      assertSurfaceConformance({
        manifest,
        openApi: standardDocument,
        ...names,
        metadata: 'ignore',
      }),
    ).not.toThrow();
  });

  test('a missing AGENT tool and a missing CLI command each fail conformance', () => {
    const manifest = buildSurfaceManifest([service]);
    const openApi = generateOpenApiDocument({
      info: { title: 'Test', version: '1.0.0' },
      groups: [{ pathPrefix: '/api', services: [service] }],
    });
    expect(() =>
      assertSurfaceConformance({
        manifest,
        openApi,
        mcpToolNames: ['read_note'],
        agentToolNames: [],
        cliToolNames: ['read_note'],
        metadata: 'ignore',
      }),
    ).toThrow('AGENT mount surface mismatch');
    expect(() =>
      assertSurfaceConformance({
        manifest,
        openApi,
        mcpToolNames: ['read_note'],
        agentToolNames: ['read_note'],
        cliToolNames: [],
        metadata: 'ignore',
      }),
    ).toThrow('CLI manifest surface mismatch');
  });

  test('the committed snapshot catches an expose edit that moves BOTH in-process sides together', () => {
    // The probe that defeated the old check: removing AGENT/CLI from `expose`
    // changes the manifest AND the in-process tool lists in lockstep. The
    // snapshot is the anchor that does not move with the source.
    const snapshot = buildSurfaceManifest([service]);
    const narrowed = implement(
      defineContract(
        { prefix: 'notes', scope: 'public' },
        {
          read: {
            method: 'GET',
            path: '/:id',
            desc: 'Read a note',
            params: NoteParamsSchema,
            output: NoteSchema,
            expose: ['HTTP', 'MCP'],
          },
        },
      ),
      { read: ({ params }) => ({ id: params.id }) },
    );
    expect(() =>
      assertManifestMatchesSnapshot(buildSurfaceManifest([narrowed]), snapshot),
    ).toThrow(/diverged from the committed snapshot/);
    expect(() =>
      assertManifestMatchesSnapshot(buildSurfaceManifest([service]), snapshot),
    ).not.toThrow();
  });

  test('a schema TYPE change at the same method and path flips the shape digest', () => {
    const snapshot = buildSurfaceManifest([service]);
    const retyped = implement(
      defineContract(
        { prefix: 'notes', scope: 'public' },
        {
          read: {
            method: 'GET',
            path: '/:id',
            desc: 'Read a note',
            params: NoteParamsSchema,
            // Same address, same presence flags — different output TYPE.
            output: RetypedNoteSchema,
            expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
          },
        },
      ),
      { read: ({ params }) => ({ id: Number(params.id) }) },
    );
    expect(() =>
      assertManifestMatchesSnapshot(buildSurfaceManifest([retyped]), snapshot),
    ).toThrow(/diverged from the committed snapshot/);
  });

  test('fails first on duplicate contract identity', () => {
    expect(() => buildSurfaceManifest([service, service])).toThrow(
      'Duplicate operation identity notes.read',
    );
  });

  test('a broken /mcp endpoint rejects discovery — even when zero tools are expected', async () => {
    const broken = Bun.serve({
      port: 0,
      fetch: () => new Response('not the MCP endpoint', { status: 404 }),
    });
    try {
      await expect(discoverMcpTools(`http://127.0.0.1:${broken.port}`, [])).rejects.toThrow();
    } finally {
      broken.stop(true);
    }
  });

  test('the CLI surface observed from the SPAWNED process matches the committed snapshot', async () => {
    // External observation against the external anchor — neither side is the
    // in-process `services` object, so they cannot move together.
    const root = join(import.meta.dir, '../../..');
    const commands = await discoverCliCommands(root);
    const snapshot = SurfaceSnapshotCliSchema.parse(
      JSON.parse(
        await readFile(join(root, 'packages/backend/src/surface.snapshot.json'), 'utf8'),
      ),
    );
    const expected = snapshot
      .flatMap((operation) => (operation.tools.CLI ? [operation.tools.CLI] : []))
      .sort();
    expect([...commands].sort()).toEqual(expected);
  });
});

const SurfaceSnapshotCliSchema = z.array(
  z.object({ tools: z.object({ CLI: z.string().optional() }) }),
);
