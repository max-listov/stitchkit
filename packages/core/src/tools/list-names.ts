/**
 * Tool-name baseline — the final mounted name of every tool across the tool
 * transports, with its `(service, method)` identity. Tool names are partly
 * derived (`toolName` override, else `toToolName(service, method)`), so a
 * consumer pins them with a snapshot test / CI diff: an upgrade that would
 * shift a derived name — and silently break MCP client configs — fails the
 * consumer's build instead. Also the mechanical "what changed" diff when
 * migrating a service between contract shapes.
 *
 * Built on the mixed-surface collector used by the mounts — the listing cannot
 * drift when pathless runtime tools sit beside contract operations.
 */
import type { Transport } from '../contract';
import {
  collectToolSurface,
  type ToolSurfaceDefinition,
  type ToolSurfaceTransport,
} from './surface';

/** One mounted tool name and where it comes from. */
export interface ToolNameEntry {
  /** Whether the operation comes from a contract or a pathless runtime definition. */
  kind: 'contract' | 'runtime';
  /** Final tool name — the `toolName` override, else derived from service + method. */
  name: string;
  /** Owning service (`ServiceDef.name` — the contract's prefix). */
  service: string;
  /** Endpoint key in the contract (e.g. `updatePartial`). */
  method: string;
  /** Tool transports the name is exposed on (mount order: MCP, AGENT, CLI). */
  transports: Transport[];
}

const TOOL_TRANSPORTS = ['MCP', 'AGENT', 'CLI'] satisfies ToolSurfaceTransport[];

/**
 * Resolve every tool name the surface exposes, sorted by name (then service) —
 * a stable shape to snapshot. Multipart and raw-response endpoints
 * are absent
 * (never mounted as tools) and CLI appears only where `expose` opts in,
 * mirroring the real mounts.
 */
export function listToolNames(surface: ToolSurfaceDefinition): ToolNameEntry[] {
  const entries = new Map<string, ToolNameEntry>();
  for (const transport of TOOL_TRANSPORTS) {
    // Diagnostics deliberately keep invalid and duplicate names visible.
    for (const entry of collectToolSurface({
      surface,
      transport,
      assertNames: false,
      assertUniqueNames: false,
    })) {
      // NUL-joined so the composite key can never collide with real names.
      const id = `${entry.kind}\u0000${entry.service}\u0000${entry.action}`;
      const existing = entries.get(id);
      if (existing) {
        existing.transports.push(transport);
      } else {
        entries.set(id, {
          kind: entry.kind,
          name: entry.mountable.name,
          service: entry.service,
          method: entry.action,
          transports: [transport],
        });
      }
    }
  }
  return [...entries.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.service.localeCompare(b.service),
  );
}
