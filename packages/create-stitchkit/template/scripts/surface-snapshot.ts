#!/usr/bin/env bun
/**
 * Committed surface snapshot and live-surface discovery check backed directly
 * by `stitchkit/testing`. Run this script directly (`bun run surface:snapshot`)
 * after an intended surface change and review the diff like any contract edit.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { ServiceDef } from 'stitchkit/server';
import {
  assertSurfaceDiscovery,
  assertSurfaceManifestSnapshot,
  buildSurfaceManifest,
  type SurfaceManifest,
  SurfaceManifestSchema,
} from 'stitchkit/testing';
import { mountAgent } from 'stitchkit/tools/agent';
import { z } from 'zod';
import { createSurface } from '../packages/backend/src/surface';

export const SURFACE_SNAPSHOT_PATH = 'packages/backend/src/surface.snapshot.json';

const OpenApiSnapshotSchema = z.object({
  paths: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export function buildAppSurfaceManifest(services: readonly ServiceDef[]): SurfaceManifest {
  return buildSurfaceManifest({
    groups: [{ pathPrefix: '/api', services: [...services] }],
    toolSurfaces: {
      MCP: { services },
      AGENT: { services },
      CLI: { services },
    },
  });
}

/**
 * Observe the CLI surface externally — spawn the real CLI process and parse
 * its command table instead of re-deriving the list from in-process `services`.
 */
export async function discoverCliCommands(
  root = process.cwd(),
  timeoutMs = 30_000,
): Promise<string[]> {
  const child = Bun.spawn({
    cmd: ['bun', 'packages/backend/src/cli.ts', '--help'],
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  let output: string;
  let errors: string;
  let exitCode: number;
  try {
    [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (timedOut) {
    throw new Error(`CLI --help timed out after ${timeoutMs}ms`);
  }
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

export async function discoverMcpTools(apiOrigin: string): Promise<string[]> {
  const client = new Client(
    { name: 'surface-conformance', version: '1.0.0' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${apiOrigin}/mcp`));
  try {
    await client.connect(transport);
    if (!client.getServerCapabilities()?.tools) return [];
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

export async function assertLiveSurface(
  apiOrigin: string,
  root = process.cwd(),
): Promise<void> {
  const { services, socket, hub, board } = await createSurface();
  try {
    const manifest = buildAppSurfaceManifest(services);
    const snapshot = SurfaceManifestSchema.parse(
      JSON.parse(await readFile(join(root, SURFACE_SNAPSHOT_PATH), 'utf8')),
    );
    assertSurfaceManifestSnapshot(manifest, snapshot);
    const response = await fetch(`${apiOrigin}/openapi.json`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`GET ${apiOrigin}/openapi.json returned ${response.status}`);
    }
    const openApi = OpenApiSnapshotSchema.parse(await response.json());
    assertSurfaceDiscovery(manifest, {
      openApi,
      MCP: await discoverMcpTools(apiOrigin),
      AGENT: Object.keys(mountAgent(services, { access: { open: 'local-operator' } })),
      CLI: await discoverCliCommands(root),
    });
  } finally {
    await Promise.allSettled([hub.close(), board.close(), socket.close()]);
  }
}

if (import.meta.main) {
  const { services, socket, hub, board } = await createSurface();
  try {
    const manifest = buildAppSurfaceManifest(services);
    const target = join(process.cwd(), SURFACE_SNAPSHOT_PATH);
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Wrote ${manifest.operations.length} operation(s) to ${SURFACE_SNAPSHOT_PATH}`);
  } finally {
    await Promise.allSettled([hub.close(), board.close(), socket.close()]);
  }
}
