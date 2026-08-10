import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { createSurface } from '../packages/backend/src/surface';
import {
  assertSurfaceConformance,
  buildSurfaceManifest,
  type SurfaceManifestOperation,
} from '../packages/backend/src/surface-manifest';

export interface SurfaceProbe {
  name: string;
  run: () => Promise<void>;
}

export function defineSurfaceProbe<TInput, TOutput>({
  name,
  input,
  fixture,
  output,
  run,
}: {
  name: string;
  input: z.ZodType<TInput>;
  fixture: unknown;
  output?: z.ZodType<TOutput>;
  run: (input: TInput) => Promise<TOutput>;
}): SurfaceProbe {
  return {
    name,
    run: async () => {
      const result = await run(input.parse(fixture));
      output?.parse(result);
    },
  };
}

interface SurfaceConformanceOptions {
  apiOrigin: string;
  probes?: readonly SurfaceProbe[];
}

async function readJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`);
  return response.json();
}

async function discoverMcpTools(
  apiOrigin: string,
  manifest: readonly SurfaceManifestOperation[],
): Promise<string[]> {
  const expectedCount = manifest.filter((operation) => operation.tools.MCP).length;
  const client = new Client(
    { name: 'surface-conformance', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${apiOrigin}/mcp`));
  try {
    await client.connect(transport);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name);
    } catch (error) {
      if (
        expectedCount === 0 &&
        error instanceof Error &&
        error.message.includes('not supported by the negotiated protocol version')
      ) {
        return [];
      }
      throw error;
    }
  } finally {
    await client.close();
  }
}

export async function runSurfaceConformance({
  apiOrigin,
  probes = [],
}: SurfaceConformanceOptions): Promise<void> {
  const { services, socket } = await createSurface();
  try {
    const manifest = buildSurfaceManifest(services);
    const openApi = await readJson(`${apiOrigin}/openapi.json`);
    const mcpToolNames = await discoverMcpTools(apiOrigin, manifest);
    assertSurfaceConformance({
      manifest,
      openApi: OpenApiSnapshotSchema.parse(openApi),
      mcpToolNames,
    });
    for (const probe of probes) {
      try {
        await probe.run();
      } catch (cause) {
        throw new Error(`Surface probe "${probe.name}" failed`, { cause });
      }
    }
  } finally {
    await socket.io.close();
  }
}

const OpenApiSnapshotSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});
