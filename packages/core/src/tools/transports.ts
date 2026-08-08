/**
 * A boot-time transport summary — how many operations each service exposes on
 * each transport (HTTP / MCP / AGENT / CLI). Every project logs this by hand and
 * re-derives the `expose` combinatorics (default-on MCP/AGENT, opt-in CLI,
 * multipart is HTTP-only). This returns the data; the app formats its own line.
 *
 * Tool counts come from the mixed-surface collector the mounts use, so runtime
 * definitions cannot disappear from the boot diagnostic.
 */
import type { Transport } from '../contract';
import type { ServiceDef } from '../server/types';
import type { RuntimeToolDefinition } from './runtime-tool';
import {
  collectToolSurface,
  type ToolSurfaceDefinition,
  type ToolSurfaceTransport,
} from './surface';

/** Operation counts per transport, for one service or the whole fleet. */
export type TransportCounts = Record<Transport, number>;

/** The result of `summarizeTransports`. */
export interface TransportSummary {
  /** Number of contract services summarised. */
  contractServices: number;
  /** Number of pathless runtime definitions summarised. */
  runtimeTools: number;
  /** Operation counts per transport, summed across every service. */
  totals: TransportCounts;
  /** Per-source breakdown: contract inputs first, then runtime identity groups. */
  sources: Array<{
    kind: 'contract' | 'runtime';
    service: string;
    counts: TransportCounts;
  }>;
}

const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT', 'CLI'] satisfies Transport[];
const TOOL_TRANSPORTS = ['MCP', 'AGENT', 'CLI'] satisfies ToolSurfaceTransport[];

function emptyCounts(): TransportCounts {
  return { HTTP: 0, MCP: 0, AGENT: 0, CLI: 0 };
}

/** Summarise how the given services are exposed across the four transports. */
function contractCounts(service: ServiceDef): TransportCounts {
  const counts = emptyCounts();
  for (const method of Object.values(service.methods)) {
    if (!method.expose || method.expose.includes('HTTP')) counts.HTTP += 1;
  }
  for (const transport of TOOL_TRANSPORTS) {
    counts[transport] = collectToolSurface({
      surface: { services: [service] },
      transport,
      assertNames: false,
      assertUniqueNames: false,
    }).length;
  }
  return counts;
}

function runtimeCounts(runtimeTools: readonly RuntimeToolDefinition[]): TransportCounts {
  const counts = emptyCounts();
  for (const transport of TOOL_TRANSPORTS) {
    counts[transport] = collectToolSurface({
      surface: { runtimeTools },
      transport,
      assertNames: false,
      assertUniqueNames: false,
    }).length;
  }
  return counts;
}

function addCounts(target: TransportCounts, source: TransportCounts): void {
  for (const transport of ALL_TRANSPORTS) target[transport] += source[transport];
}

export function summarizeTransports(surface: ToolSurfaceDefinition): TransportSummary {
  const totals = emptyCounts();
  const sources: TransportSummary['sources'] = [];

  for (const service of surface.services ?? []) {
    const counts = contractCounts(service);
    addCounts(totals, counts);
    sources.push({ kind: 'contract', service: service.name, counts });
  }

  const runtimeGroups = new Map<string, RuntimeToolDefinition[]>();
  for (const definition of surface.runtimeTools ?? []) {
    const service = definition.identity.serviceName;
    const group = runtimeGroups.get(service);
    if (group) group.push(definition);
    else runtimeGroups.set(service, [definition]);
  }
  for (const [service, runtimeTools] of runtimeGroups) {
    const counts = runtimeCounts(runtimeTools);
    addCounts(totals, counts);
    sources.push({ kind: 'runtime', service, counts });
  }

  return {
    contractServices: surface.services?.length ?? 0,
    runtimeTools: surface.runtimeTools?.length ?? 0,
    totals,
    sources,
  };
}
