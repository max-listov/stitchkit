/**
 * A boot-time transport summary — how many operations each service exposes on
 * each transport (HTTP / MCP / AGENT / CLI). Every project logs this by hand and
 * re-derives the `expose` combinatorics (default-on MCP/AGENT, opt-in CLI,
 * multipart is HTTP-only). This returns the data; the app formats its own line.
 *
 * Tool counts come from `collectTools` — the exact resolver the mounts use, so
 * the summary can't drift from what actually mounts.
 */
import type { Transport } from '../contract';
import type { ServiceDef } from '../server/types';
import { collectTools } from './mount';

/** Operation counts per transport, for one service or the whole fleet. */
export type TransportCounts = Record<Transport, number>;

/** The result of `summarizeTransports`. */
export interface TransportSummary {
  /** Number of services summarised. */
  services: number;
  /** Operation counts per transport, summed across every service. */
  totals: TransportCounts;
  /** Per-service breakdown, in input order. */
  perService: Array<{ service: string; counts: TransportCounts }>;
}

const TOOL_TRANSPORTS = ['MCP', 'AGENT', 'CLI'] satisfies Transport[];

function emptyCounts(): TransportCounts {
  return { HTTP: 0, MCP: 0, AGENT: 0, CLI: 0 };
}

/** Summarise how the given services are exposed across the four transports. */
export function summarizeTransports(services: ServiceDef[]): TransportSummary {
  const totals = emptyCounts();
  const perService = services.map((service) => {
    const counts = emptyCounts();
    // HTTP: every method is an HTTP route unless `expose` drops it (multipart
    // endpoints included — they are HTTP-only, never tools).
    for (const method of Object.values(service.methods)) {
      if (!method.expose || method.expose.includes('HTTP')) counts.HTTP += 1;
    }
    // Tool transports: exactly what the mounts would collect.
    for (const transport of TOOL_TRANSPORTS) {
      counts[transport] = collectTools(service, transport).length;
    }
    for (const transport of Object.keys(counts) as Transport[]) {
      totals[transport] += counts[transport];
    }
    return { service: service.name, counts };
  });
  return { services: services.length, totals, perService };
}
