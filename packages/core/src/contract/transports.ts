export const ALL_TRANSPORTS = ['HTTP', 'MCP', 'AGENT', 'CLI'] as const;
export type Transport = (typeof ALL_TRANSPORTS)[number];
export const TOOL_TRANSPORTS = ['MCP', 'AGENT', 'CLI'] as const satisfies readonly Transport[];
export type ToolTransport = (typeof TOOL_TRANSPORTS)[number];
