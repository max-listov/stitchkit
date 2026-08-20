import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineContract } from '../src/contract';
import { implement } from '../src/server/implement';
import { generateOpenApiDocument } from '../src/server/openapi';
import {
  assertSurfaceDiscovery,
  assertSurfaceManifestSnapshot,
  buildSurfaceManifest,
  runSurfaceProbes,
  serializeSurfaceValue,
} from '../src/testing';
import { defineCliCommand } from '../src/tools/cli-command';
import { defineRuntimeTool } from '../src/tools/runtime-tool';

const ParamsSchema = z.object({ id: z.string() });
const InputSchema = z.object({ query: z.string() });
const OutputSchema = z.object({ value: z.string() });

const contract = defineContract(
  { prefix: 'items', scope: 'user' },
  {
    read: {
      method: 'GET',
      path: '/:id',
      desc: 'Read item',
      params: ParamsSchema,
      input: InputSchema,
      output: OutputSchema,
      expose: ['HTTP', 'MCP', 'AGENT', 'CLI'],
    },
  },
);

const service = implement(contract, {
  read: () => ({ value: 'ok' }),
});

const runtimeTool = defineRuntimeTool({
  name: 'jobs_status',
  description: 'Read job status',
  identity: { serviceName: 'jobs', action: 'status', method: 'GET', scope: 'user' },
  input: z.object({ id: z.string() }),
  output: z.object({ state: z.string() }),
  transports: ['MCP', 'AGENT', 'CLI'],
  handler: () => ({ state: 'done' }),
});

const cliOnly = defineCliCommand({
  name: 'doctor',
  description: 'Inspect local state',
  input: z.object({ verbose: z.boolean().optional() }),
  output: z.object({ ok: z.boolean() }),
  handler: () => ({ ok: true }),
});

describe('transport conformance kit', () => {
  test('manifests contract, runtime and CLI-only surfaces with actual topology', () => {
    const manifest = buildSurfaceManifest({
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
      runtimeTools: [runtimeTool],
      cliCommands: [cliOnly],
      extensions: [{ name: '/health', transport: 'HTTP' }],
    });

    expect(manifest.operations).toHaveLength(2);
    expect(manifest.operations[0]?.http).toEqual([
      { method: 'GET', path: '/api/v1/items/:id' },
    ]);
    expect(manifest.operations[0]?.schemas.params).not.toBeNull();
    expect(manifest.operations[1]?.kind).toBe('runtime');
    expect(manifest.operations[1]?.tools).toEqual({
      MCP: 'jobs_status',
      AGENT: 'jobs_status',
      CLI: 'jobs_status',
    });
    expect(manifest.cliOnly.map((command) => command.name)).toEqual(['doctor']);
    expect(manifest.extensions).toEqual([{ name: '/health', transport: 'HTTP' }]);
  });

  test('canonical schema digests ignore object key insertion order', () => {
    const firstTool = defineRuntimeTool({
      name: 'first',
      description: 'First',
      identity: { serviceName: 'digest', action: 'read', method: 'GET' },
      input: z.object({ alpha: z.string(), beta: z.number() }),
      output: OutputSchema,
      handler: () => ({ value: 'ok' }),
    });
    const secondTool = defineRuntimeTool({
      name: 'first',
      description: 'First',
      identity: { serviceName: 'digest', action: 'read', method: 'GET' },
      input: z.object({ beta: z.number(), alpha: z.string() }),
      output: OutputSchema,
      handler: () => ({ value: 'ok' }),
    });

    const first = buildSurfaceManifest({ runtimeTools: [firstTool] });
    const second = buildSurfaceManifest({ runtimeTools: [secondTool] });

    expect(first.operations[0]?.schemas.input).toBe(second.operations[0]?.schemas.input);
    expect(serializeSurfaceValue(first)).toBe(serializeSurfaceValue(second));
  });

  test('snapshot and live discovery fail on real drift', () => {
    const manifest = buildSurfaceManifest({
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
      runtimeTools: [runtimeTool],
      cliCommands: [cliOnly],
    });
    const openApi = generateOpenApiDocument({
      info: { title: 'test', version: '1' },
      groups: [{ pathPrefix: '/api/v1', services: [service] }],
    });
    const contractOperation = manifest.operations.find(
      (operation) => operation.kind === 'contract',
    );
    const runtimeOperation = manifest.operations.find(
      (operation) => operation.kind === 'runtime',
    );

    assertSurfaceManifestSnapshot(manifest, manifest);
    assertSurfaceDiscovery(manifest, {
      openApi,
      MCP: [contractOperation?.tools.MCP ?? '', runtimeOperation?.tools.MCP ?? ''],
      AGENT: [contractOperation?.tools.AGENT ?? '', runtimeOperation?.tools.AGENT ?? ''],
      CLI: [contractOperation?.tools.CLI ?? '', runtimeOperation?.tools.CLI ?? ''],
      cliOnly: ['doctor'],
    });

    expect(() => assertSurfaceDiscovery(manifest, { MCP: ['missing'] })).toThrow(
      'MCP discovery mismatch',
    );
  });

  test('behavioral probes are explicit, bounded and always tear down', async () => {
    const phases: string[] = [];
    await runSurfaceProbes({
      probes: [
        {
          name: 'read',
          fixture: { id: '1' },
          transports: ['HTTP', 'MCP'],
          expected: {
            HTTP: { outcome: 'success', data: { value: 'ok' } },
            MCP: { outcome: 'domain_error', code: 'DENIED' },
          },
          setup: () => void phases.push('setup'),
          teardown: () => void phases.push('teardown'),
        },
      ],
      drivers: {
        HTTP: {
          invoke: async (_fixture, signal) => {
            expect(signal.aborted).toBe(false);
            phases.push('http');
            return { outcome: 'success', data: { value: 'ok' } };
          },
        },
        MCP: {
          invoke: async () => {
            phases.push('mcp');
            return { outcome: 'domain_error', code: 'DENIED' };
          },
        },
      },
    });

    expect(phases).toEqual(['setup', 'http', 'mcp', 'teardown']);
  });

  test('a non-cooperative driver cannot hold the runner past its timeout', async () => {
    await expect(
      runSurfaceProbes({
        probes: [
          {
            name: 'hung',
            fixture: undefined,
            transports: ['HTTP'],
            expected: { HTTP: { outcome: 'success' } },
          },
        ],
        drivers: { HTTP: { invoke: () => new Promise(() => undefined) } },
        timeoutMs: 5,
      }),
    ).rejects.toBeDefined();
  });
});
