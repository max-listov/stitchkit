export type { McpServer } from '@modelcontextprotocol/server';
export type { ToolSurfaceProjection } from '../../tools/internal/surface-projector';
export {
  EXT_APPS_BUNDLE_PLACEHOLDER,
  inlineMcpAppBundle,
  type McpAppCsp,
  type McpAppResourceMeta,
  type McpResourceDef,
  RESOURCE_MIME_TYPE,
} from '../../tools/mcp/app';
export {
  MCP_CATALOG_META_KEY,
  type McpCatalogStamp,
  mcpCatalogMeta,
  readMcpCatalogStamp,
} from '../../tools/mcp/catalog';
export {
  createMcpHandler,
  createMcpHttpRoute,
  type McpHandlerConfig,
  type McpHttpConfig,
  type McpHttpHandler,
  type McpHttpSecurityConfig,
  type McpLegacyPolicy,
} from '../../tools/mcp/handler';
export {
  buildMcpServer,
  type DirectMcpSurfaceConfig,
  type FiniteMcpSurfaceConfig,
  type McpMountConfig,
  type McpServerBuildConfig,
  type McpServerSharedConfig,
  mountMcp,
  mountMcpResource,
  validateMcpSchemas,
} from '../../tools/mcp/mount';
export type {
  IncompatibleSchemaPolicy,
  McpSchemaValidationConfig,
  McpSurfaceDefinition,
  McpSurfaceRegistry,
  ValidateMcpSchemasConfig,
} from '../../tools/mcp/prepare';
export {
  createStdioMcpServer,
  type McpStdioHandle,
  type StdioAuthConfig,
  type StdioMcpServerConfig,
} from '../../tools/mcp/stdio';
export {
  bindStdioProcessSignals,
  type StdioCloseTarget,
  type StdioProcessSignalsBinding,
  type StdioProcessSignalsErrorPhase,
  type StdioProcessSignalsOptions,
} from '../../tools/mcp/stdio-signals';
export type { RuntimeToolDefinitionWithoutOutput } from '../../tools/runtime-tool-execution';
export type {
  RuntimeMcpPresentation,
  RuntimeMcpToolDefinition,
  RuntimeMcpToolDefinitionWithOutput,
  RuntimeMcpToolPresenters,
} from '../../tools/runtime-tool-mcp';
