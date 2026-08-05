/**
 * Tool-name baseline — the final mounted name of every tool across the tool
 * transports, with its `(service, method)` identity. Tool names are partly
 * derived (`toolName` override, else `toToolName(service, method)`), so a
 * consumer pins them with a snapshot test / CI diff: an upgrade that would
 * shift a derived name — and silently break MCP client configs — fails the
 * consumer's build instead. Also the mechanical "what changed" diff when
 * migrating a service between contract shapes.
 *
 * Built on `collectTools`, the exact resolver `mountMcp` / `mountAgent` /
 * `createCli` use — the listing can never drift from what actually mounts.
 */
import type { Transport } from '../contract';
import type { ServiceDef } from '../server/types';
import { collectTools } from './mount';

/** One mounted tool name and where it comes from. */
export interface ToolNameEntry {
  /** Final tool name — the `toolName` override, else derived from service + method. */
  name: string;
  /** Owning service (`ServiceDef.name` — the contract's prefix). */
  service: string;
  /** Endpoint key in the contract (e.g. `updatePartial`). */
  method: string;
  /** Tool transports the name is exposed on (mount order: MCP, AGENT, CLI). */
  transports: Transport[];
}

const TOOL_TRANSPORTS = ['MCP', 'AGENT', 'CLI'] satisfies Transport[];

/**
 * Resolve every tool name the given services expose, sorted by name (then
 * service) — a stable shape to snapshot. Multipart endpoints are absent
 * (never mounted as tools) and CLI appears only where `expose` opts in,
 * mirroring the real mounts.
 */
export function listToolNames(services: ServiceDef[]): ToolNameEntry[] {
  const entries = new Map<string, ToolNameEntry>();
  for (const service of services) {
    for (const transport of TOOL_TRANSPORTS) {
      // `assertNames: false` — this lister is the documented way to FIND an
      // illegal name before an upgrade, so it must report one, not die on it.
      // → ADR 0035.
      for (const tool of collectTools(service, transport, { assertNames: false })) {
        // NUL-joined so the composite key can never collide with real names.
        const id = `${service.name}\u0000${tool.method.key}`;
        const existing = entries.get(id);
        if (existing) {
          existing.transports.push(transport);
        } else {
          entries.set(id, {
            name: tool.name,
            service: service.name,
            method: tool.method.key,
            transports: [transport],
          });
        }
      }
    }
  }
  return [...entries.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.service.localeCompare(b.service),
  );
}
