import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mountAgent } from 'stitchkit/tools';
import { z } from 'zod';
import { createSurface } from '../packages/backend/src/surface';
import {
  assertManifestMatchesSnapshot,
  assertSurfaceConformance,
  buildSurfaceManifest,
  type SurfaceManifestOperation,
} from '../packages/backend/src/surface-manifest';

export const SURFACE_SNAPSHOT_PATH = 'packages/backend/src/surface.snapshot.json';

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

/**
 * Observe the CLI surface EXTERNALLY — spawn the real CLI process and parse
 * its command table, instead of re-deriving the list from the same in-process
 * `services` the manifest was built from (which could only ever agree).
 */
export async function discoverCliCommands(root = process.cwd()): Promise<string[]> {
  const child = Bun.spawn({
    cmd: ['bun', 'packages/backend/src/cli.ts', '--help'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, errors, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`CLI --help exited with ${exitCode}: ${errors || output}`);
  }
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.trim() === 'Commands:');
  if (start === -1) throw new Error('CLI --help output carries no "Commands:" section');
  const commands: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('  ')) break;
    const name = line.trim().split(/\s+/)[0];
    if (name) commands.push(name);
  }
  return commands;
}

export async function discoverMcpTools(
  apiOrigin: string,
  _manifest: readonly SurfaceManifestOperation[],
): Promise<string[]> {
  const client = new Client(
    { name: 'surface-conformance', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${apiOrigin}/mcp`));
  try {
    await client.connect(transport);
    return (await client.listTools()).tools.map((tool) => tool.name);
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
    // The committed snapshot is the anchor no source edit can move along with
    // itself: removing a transport from `expose` changes the live manifest but
    // not the snapshot, so the lane fails until the snapshot is deliberately
    // regenerated and reviewed.
    const snapshot = SurfaceSnapshotSchema.parse(
      JSON.parse(await readFile(join(process.cwd(), SURFACE_SNAPSHOT_PATH), 'utf8')),
    );
    assertManifestMatchesSnapshot(manifest, snapshot);
    const openApi = await readJson(`${apiOrigin}/openapi.json`);
    const mcpToolNames = await discoverMcpTools(apiOrigin, manifest);
    assertSurfaceConformance({
      manifest,
      openApi: OpenApiSnapshotSchema.parse(openApi),
      mcpToolNames,
      // AGENT has no external process to observe — it is anchored by the
      // snapshot above; CLI is observed by spawning the real CLI.
      agentToolNames: Object.keys(mountAgent(services)),
      cliToolNames: await discoverCliCommands(),
    });
    for (const probe of probes) {
      try {
        await probe.run();
      } catch (cause) {
        throw new Error(`Surface probe "${probe.name}" failed`, { cause });
      }
    }
  } finally {
    await socket.close();
  }
}

const OpenApiSnapshotSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

const SurfaceSnapshotSchema: z.ZodType<SurfaceManifestOperation[]> = z.array(
  z.object({
    service: z.string(),
    action: z.string(),
    scope: z.string(),
    hasInput: z.boolean(),
    hasOutput: z.boolean(),
    inputShape: z.string().nullable(),
    outputShape: z.string().nullable(),
    http: z.array(
      z.object({
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
        path: z.string(),
      }),
    ),
    tools: z.object({
      MCP: z.string().optional(),
      AGENT: z.string().optional(),
      CLI: z.string().optional(),
    }),
  }),
);
