import type { McpServer, RegisteredTool } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { isRecord } from '../../internal/typed';
import type { ErrorHintFn, ToolCallHooks, ToolLifecycle } from '../execute-hooks';
import { rankToolsByQuery } from '../internal/rank-tools';
import { defineRuntimeTool } from '../runtime-tool';
import type { McpCatalogStamp } from './catalog-stamp';
import { formatMcpResult, prepareMcpServerSurface } from './prepare';
import { mountPreparedRuntimeMcp } from './runtime-tools';

const DEFAULT_SEARCH_TOOL_NAME = 'tool_search';
const DEFAULT_MAX_RESULTS = 10;
const HARD_MAX_RESULTS = 50;

/** Opt-in lazy tool discovery configuration for stateful `stitchkit/tools/mcp` mounts. */
export interface McpLazyDiscoveryConfig {
  readonly mode: 'lazy';
  /** Contract tool names enabled immediately on session start; all other contract tools start disabled. */
  readonly initialTools: readonly string[];
  /** Name of the built-in discovery tool. Default `'tool_search'`. */
  readonly searchToolName?: string;
  /** Maximum matching hidden tools returned and enabled per search call (`1..50`). Default `10`. */
  readonly maxResults?: number;
}

/** Normalized lazy discovery parameters returned by {@link validateMcpLazyDiscovery}. */
export interface ValidatedMcpLazyDiscovery {
  readonly initialTools: ReadonlySet<string>;
  readonly searchToolName: string;
  readonly maxResults: number;
}

/** One contract tool handle managed by lazy discovery on a single `McpServer` session. */
export interface ManagedLazyMcpTool {
  readonly name: string;
  readonly description: string;
  readonly registered: RegisteredTool;
}

const LazySearchInputSchema = z.strictObject({
  query: z.string().trim().min(1).max(256),
  limit: z.int().positive().max(HARD_MAX_RESULTS).optional(),
});

const LazySearchMatchSchema = z.strictObject({
  name: z.string().min(1),
  description: z.string(),
  newlyEnabled: z.boolean(),
});

const LazySearchOutputSchema = z.strictObject({
  query: z.string(),
  enabledTools: z.array(z.string()),
  matches: z.array(LazySearchMatchSchema),
  totalHiddenRemaining: z.int().nonnegative(),
});

/**
 * Synchronously validate `discovery` configuration before any tools are registered on `McpServer`.
 * Refuses unknown `initialTools`, name collisions with contract or runtime tools, and invalid bounds.
 */
export function validateMcpLazyDiscovery(
  rawConfig: unknown,
  contractToolNames: readonly string[],
  reservedToolNames: readonly string[] = [],
): ValidatedMcpLazyDiscovery {
  if (!isRecord(rawConfig)) {
    throw new TypeError('[stitchkit] MCP discovery config must be an object');
  }
  if (rawConfig.mode !== 'lazy') {
    throw new TypeError(
      `[stitchkit] MCP discovery mode must be "lazy" (received ${JSON.stringify(rawConfig.mode)})`,
    );
  }
  if (!Array.isArray(rawConfig.initialTools)) {
    throw new TypeError(
      '[stitchkit] MCP discovery.initialTools must be an array of tool names',
    );
  }
  const searchToolName =
    rawConfig.searchToolName === undefined
      ? DEFAULT_SEARCH_TOOL_NAME
      : typeof rawConfig.searchToolName === 'string'
        ? rawConfig.searchToolName.trim()
        : '';
  if (searchToolName.length === 0) {
    throw new TypeError('[stitchkit] MCP discovery.searchToolName must be a non-empty string');
  }
  if (rawConfig.maxResults !== undefined && typeof rawConfig.maxResults !== 'number') {
    throw new TypeError('[stitchkit] MCP discovery.maxResults must be a positive integer');
  }
  const maxResults = rawConfig.maxResults ?? DEFAULT_MAX_RESULTS;
  assertPositiveSafeInteger('[stitchkit] MCP discovery.maxResults', maxResults);
  if (maxResults > HARD_MAX_RESULTS) {
    throw new RangeError(
      `[stitchkit] MCP discovery.maxResults (${maxResults}) must not exceed ${HARD_MAX_RESULTS}`,
    );
  }
  const knownContract = new Set(contractToolNames);
  const allOccupied = new Set([...contractToolNames, ...reservedToolNames]);
  if (allOccupied.has(searchToolName)) {
    throw new Error(
      `[stitchkit] MCP discovery.searchToolName "${searchToolName}" collides with an existing mounted tool`,
    );
  }
  const initialTools = new Set<string>();
  for (const name of rawConfig.initialTools) {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError(
        '[stitchkit] MCP discovery.initialTools entries must be non-empty strings',
      );
    }
    if (!knownContract.has(name)) {
      throw new Error(
        `[stitchkit] MCP discovery.initialTools contains unknown contract tool "${name}"`,
      );
    }
    initialTools.add(name);
  }
  return { initialTools, searchToolName, maxResults };
}

/**
 * Hide non-initial contract tools on this `McpServer` session and register the built-in discovery
 * tool through Stitchkit's standard runtime-tool pipeline (`access`, `hooks`, `catalog` stamp).
 */
export function applyMcpLazyDiscovery(input: {
  readonly server: McpServer;
  readonly discovery: ValidatedMcpLazyDiscovery;
  readonly tools: readonly ManagedLazyMcpTool[];
  readonly lifecycle: ToolLifecycle;
  readonly hooks?: ToolCallHooks;
  readonly context?: Record<string, unknown>;
  readonly catalog?: McpCatalogStamp;
  readonly coerceJsonArgs?: boolean;
  readonly errorHint?: ErrorHintFn;
  readonly onOutputStrip?: (toolName: string, paths: string[]) => void;
}): void {
  const { server, discovery, tools } = input;
  const hiddenTools: ManagedLazyMcpTool[] = [];
  for (const entry of tools) {
    if (!discovery.initialTools.has(entry.name)) {
      entry.registered.enabled = false;
      hiddenTools.push(entry);
    }
  }

  const searchTool = defineRuntimeTool({
    name: discovery.searchToolName,
    description:
      'Search hidden tools by name or description and enable matching tools for this MCP session. ' +
      'An exact tool name ranks first, followed by whole-phrase matches and multi-word matches.',
    identity: { serviceName: 'mcp', action: discovery.searchToolName, method: 'POST' },
    input: LazySearchInputSchema,
    output: LazySearchOutputSchema,
    expose: ['MCP'],
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: ({ input: args }) => {
      const cap = Math.min(args.limit ?? discovery.maxResults, discovery.maxResults);
      const ranked = rankToolsByQuery(args.query, hiddenTools).slice(0, cap);
      const enabledTools: string[] = [];
      const matches: Array<z.infer<typeof LazySearchMatchSchema>> = [];
      for (const entry of ranked) {
        const newlyEnabled = !entry.registered.enabled;
        if (newlyEnabled) {
          entry.registered.enabled = true;
          enabledTools.push(entry.name);
        }
        matches.push({
          name: entry.name,
          description: entry.description,
          newlyEnabled,
        });
      }
      if (enabledTools.length > 0) {
        server.sendToolListChanged();
      }
      const totalHiddenRemaining = hiddenTools.filter(
        (entry) => !entry.registered.enabled,
      ).length;
      return {
        query: args.query,
        enabledTools,
        matches,
        totalHiddenRemaining,
      };
    },
  });

  const prepared = prepareMcpServerSurface({ services: [], runtimeTools: [searchTool] });
  mountPreparedRuntimeMcp(server, prepared.runtimeTools, {
    catalog: input.catalog,
    context: input.context,
    hooks: input.hooks,
    lifecycle: input.lifecycle,
    coerceJsonArgs: input.coerceJsonArgs,
    onOutputStrip: input.onOutputStrip,
    formatResult: (result, mode, toolName) =>
      formatMcpResult(result, mode, toolName, input.errorHint),
  });
}
