import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server';
import {
  buildToolManifest,
  defineRuntimeTool,
  listToolNames,
  summarizeTransports,
} from '../src/tools';
import { runtimeToolMountable } from '../src/tools/runtime-tool';

const contract = defineContract(
  { prefix: 'catalog' },
  {
    list: {
      method: 'GET',
      path: '/',
      desc: 'List catalog entries',
      toolName: 'list_catalog',
      output: z.array(z.string()),
    },
  },
);

const service = implement(contract, { list: () => [] });

const inspect = defineRuntimeTool({
  name: 'inspect_asset',
  description: 'Inspect one asset',
  identity: { serviceName: 'assets', action: 'inspect', method: 'POST' },
  input: z.object({ assetId: z.string().min(1) }),
  output: z.object({ summary: z.string() }),
  handler: ({ input }) => ({ summary: input.assetId }),
});

const preview = defineRuntimeTool({
  name: 'preview_asset',
  description: 'Preview one asset',
  identity: { serviceName: 'assets', action: 'preview', method: 'GET' },
  input: z.object({ assetId: z.string() }),
  output: z.object({ url: z.url() }),
  transports: ['MCP'],
  handler: ({ input }) => ({ url: `https://example.com/${input.assetId}` }),
});

describe('mixed tool-surface introspection', () => {
  test('runtime-only manifest uses the canonical immutable presentation schema', () => {
    const [entry] = buildToolManifest({ runtimeTools: [inspect], transport: 'AGENT' });
    expect(entry).toEqual({
      name: inspect.name,
      description: inspect.description,
      inputSchema: runtimeToolMountable(inspect).presentationSchema,
    });
    expect(Object.isFrozen(entry?.inputSchema)).toBe(true);
  });

  test('a mixed manifest preserves actual mount order', () => {
    const manifest = buildToolManifest({
      services: [service],
      runtimeTools: [inspect],
      transport: 'AGENT',
    });
    expect(manifest.map((entry) => entry.name)).toEqual(['list_catalog', 'inspect_asset']);
  });

  test('runtime transport filters match the requested manifest surface', () => {
    const surface = { runtimeTools: [inspect, preview] };
    expect(
      buildToolManifest({ ...surface, transport: 'AGENT' }).map((entry) => entry.name),
    ).toEqual(['inspect_asset']);
    expect(
      buildToolManifest({ ...surface, transport: 'MCP' }).map((entry) => entry.name),
    ).toEqual(['inspect_asset', 'preview_asset']);
  });

  test('contract/runtime and runtime/runtime collisions fail first', () => {
    const conflicting = defineRuntimeTool({
      ...inspect,
      name: 'list_catalog',
      identity: { serviceName: 'assets', action: 'conflict', method: 'POST' },
    });
    expect(() =>
      buildToolManifest({
        services: [service],
        runtimeTools: [conflicting],
        transport: 'AGENT',
      }),
    ).toThrow('Duplicate agent tool name "list_catalog" across mounted operations');
    expect(() =>
      buildToolManifest({ runtimeTools: [inspect, inspect], transport: 'MCP' }),
    ).toThrow('Duplicate MCP tool name "inspect_asset" across mounted operations');
  });

  test('manifest compilation never executes parsing effects', () => {
    const effects: string[] = [];
    const effectful = defineRuntimeTool({
      name: 'effectful_input',
      description: 'Exercise schema compilation',
      identity: { serviceName: 'effects', action: 'compile', method: 'POST' },
      input: z.object({
        value: z
          .string()
          .default('fallback')
          .refine((value) => {
            effects.push(`refine:${value}`);
            return true;
          })
          .transform((value) => {
            effects.push(`transform:${value}`);
            return value;
          }),
      }),
      handler: () => undefined,
    });
    buildToolManifest({ runtimeTools: [effectful], transport: 'AGENT' });
    expect(effects).toEqual([]);
  });

  test('name snapshots include runtime identity and exact transports', () => {
    expect(listToolNames({ runtimeTools: [inspect, preview] })).toEqual([
      {
        kind: 'runtime',
        name: 'inspect_asset',
        service: 'assets',
        method: 'inspect',
        transports: ['MCP', 'AGENT'],
      },
      {
        kind: 'runtime',
        name: 'preview_asset',
        service: 'assets',
        method: 'preview',
        transports: ['MCP'],
      },
    ]);
  });

  test('transport summary counts runtime definitions in identity groups', () => {
    expect(
      summarizeTransports({ services: [service], runtimeTools: [inspect, preview] }),
    ).toEqual({
      contractServices: 1,
      runtimeTools: 2,
      totals: { HTTP: 1, MCP: 3, AGENT: 2, CLI: 0 },
      sources: [
        {
          kind: 'contract',
          service: 'catalog',
          counts: { HTTP: 1, MCP: 1, AGENT: 1, CLI: 0 },
        },
        {
          kind: 'runtime',
          service: 'assets',
          counts: { HTTP: 0, MCP: 2, AGENT: 1, CLI: 0 },
        },
      ],
    });
  });

  test('manifest target is restricted to model-facing tool transports', () => {
    const compileOnly = (transport: 'HTTP' | 'CLI'): void => {
      // @ts-expect-error HTTP is not a model-facing tool manifest.
      buildToolManifest({ transport });
    };
    expect(typeof compileOnly).toBe('function');
  });
});
