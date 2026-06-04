/**
 * Typed tool-path context — the tool-side mirror of `createImplement<TCtx>()`.
 *
 * A handler is already typed (`createImplement<AppContext>()` gives `ctx.user`
 * its real type on every surface). What was untyped is the *wiring*: the
 * `context` a tool transport injects, and a `ToolExtend.resolve` result, were
 * `Record<string, unknown>` — TypeScript could not catch a missing or
 * wrong-typed `user`. → ADR 0017.
 *
 * `createToolkit<AppContext>()` fixes the context shape once and returns the
 * tool-mounting functions with `context` (and `extend.resolve`) checked against
 * it — so the CLI, MCP and agent surfaces are born as type-safe as the handler.
 * It is pure typing sugar: each method forwards verbatim to the underlying
 * function, which still accepts the loose form for callers that do not opt in
 * (ADR 0002 keeps the core context loose by default).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolSet } from 'ai';
import type { ServiceDef } from '../server/types';
import { type AgentMountConfig, mountAgent } from './agent';
import { type CliConfig, createCli } from './cli';
import {
  buildMcpServer,
  type McpMountConfig,
  type McpServerBuildConfig,
  mountMcp,
} from './mcp';
import { createMcpHandler, type McpHandlerConfig } from './mcp-handler';
import { createStdioMcpServer, type StdioMcpServerConfig } from './mcp-stdio';
import type { ToolExtend } from './mount';

/** Re-type a config's static `context` (and `extend`) to the toolkit's `TContext`. */
type WithStaticContext<C, TContext extends Record<string, unknown>> = Omit<
  C,
  'context' | 'extend'
> & {
  context?: TContext;
  extend?: ToolExtend<TContext>;
};

/** Re-type a config's `(auth) => context` factory to the toolkit's `TContext`. */
type WithAuthContext<C, TAuth, TContext extends Record<string, unknown>> = Omit<
  C,
  'context'
> & {
  context?: (auth: TAuth) => TContext;
};

/** The context-pinned tool surface returned by `createToolkit`. */
export interface Toolkit<TContext extends Record<string, unknown>> {
  mountMcp(
    server: McpServer,
    services: ServiceDef | ServiceDef[],
    config?: WithStaticContext<McpMountConfig, TContext>,
  ): void;
  mountAgent(
    services: ServiceDef | ServiceDef[],
    config?: WithStaticContext<AgentMountConfig, TContext>,
  ): ToolSet;
  buildMcpServer<TAuth>(
    config: WithAuthContext<McpServerBuildConfig<TAuth>, TAuth, TContext>,
    auth: TAuth,
  ): McpServer;
  createMcpHandler<TAuth>(
    config: WithAuthContext<McpHandlerConfig<TAuth>, TAuth, TContext>,
  ): (req: Request) => Promise<Response>;
  createStdioMcpServer<TAuth>(
    config: WithAuthContext<StdioMcpServerConfig<TAuth>, TAuth, TContext>,
  ): Promise<McpServer>;
  createCli<TAuth = unknown>(config: CliConfig<TAuth, TContext>): Promise<void>;
}

/**
 * Fix the tool-handler context type once. `const tools =
 * createToolkit<AppContext>()` — then `tools.createCli`, `tools.mountMcp`, … all
 * type-check their injected `context` against `AppContext`.
 */
export function createToolkit<TContext extends Record<string, unknown>>(): Toolkit<TContext> {
  return {
    mountMcp: (server, services, config) => mountMcp(server, services, config),
    mountAgent: (services, config) => mountAgent(services, config),
    buildMcpServer: (config, auth) => buildMcpServer(config, auth),
    createMcpHandler: (config) => createMcpHandler(config),
    createStdioMcpServer: (config) => createStdioMcpServer(config),
    createCli: (config) => createCli(config),
  };
}
