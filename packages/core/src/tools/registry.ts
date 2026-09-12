import type { RuntimeToolDefinition } from './runtime-tool';

/**
 * The effective tool surface one composition will mount.
 *
 * `build()` returns exactly what the model sees, so introspection reads the
 * same value the mount does instead of re-deriving it from a second list.
 */
export interface AgentToolRegistry {
  readonly tools: readonly RuntimeToolDefinition[];
  readonly names: readonly string[];
}

export interface AgentToolRegistryInput {
  /**
   * The single declaration of which tools exist in this composition. A name is
   * addressable only if it appears here, so a typo in `replace`/`disable` is a
   * build error instead of a quiet no-op. → ADR 0176
   */
  defaults: readonly RuntimeToolDefinition[];
}

export interface AgentToolRegistryBuilder {
  /** Swap the default occupying `name`; the replacement must carry that name. */
  replace(name: string, tool: RuntimeToolDefinition): AgentToolRegistryBuilder;
  /** Remove the default at `name`. Repeating it is idempotent. */
  disable(name: string): AgentToolRegistryBuilder;
  build(): AgentToolRegistry;
}

/**
 * A declarative composition over a declared set of defaults.
 *
 * It is a thin layer over what `mountAgent` already accepts: `build().tools`
 * is handed to the mount unchanged, so lifecycle, hooks and presentation are
 * the mount's, not this builder's. What it adds is the one fact a hand-filtered
 * list cannot state — whether a name exists to be removed — and it says so by
 * refusing at composition time rather than silently leaving the default in
 * place. → ADR 0176
 */
export function defineToolRegistry(input: AgentToolRegistryInput): AgentToolRegistryBuilder {
  const defaults = [...input.defaults];
  const slots = new Set<string>();
  for (const tool of defaults) {
    if (!tool.name) throw new Error('A default tool must carry a non-empty name');
    if (slots.has(tool.name)) throw new Error(`Duplicate default tool name: ${tool.name}`);
    slots.add(tool.name);
  }
  const disabled = new Set<string>();
  const replacements = new Map<string, RuntimeToolDefinition>();

  const assertKnown = (name: string, verb: string): void => {
    if (!slots.has(name)) {
      throw new Error(
        `Tool registry ${verb}("${name}") names no default; declared: ${
          [...slots].sort().join(', ') || '(none)'
        }`,
      );
    }
  };

  const builder: AgentToolRegistryBuilder = {
    replace(name, tool) {
      assertKnown(name, 'replace');
      if (disabled.has(name)) {
        throw new Error(`Tool registry cannot replace "${name}": it is disabled`);
      }
      if (replacements.has(name)) {
        throw new Error(`Tool registry already replaced "${name}"`);
      }
      if (tool.name !== name) {
        throw new Error(
          `A replacement for "${name}" must carry that name, not "${tool.name}"`,
        );
      }
      replacements.set(name, tool);
      return builder;
    },
    disable(name) {
      assertKnown(name, 'disable');
      // Idempotent by construction: disabling an already-disabled slot is the
      // same declaration twice, not a mistake to refuse.
      disabled.add(name);
      return builder;
    },
    build() {
      const tools: RuntimeToolDefinition[] = [];
      const seen = new Set<string>();
      for (const tool of defaults) {
        if (disabled.has(tool.name)) continue;
        const effective = replacements.get(tool.name) ?? tool;
        if (seen.has(effective.name)) {
          throw new Error(`Duplicate composed tool name: ${effective.name}`);
        }
        seen.add(effective.name);
        tools.push(effective);
      }
      return { tools, names: tools.map((tool) => tool.name) };
    },
  };
  return builder;
}
