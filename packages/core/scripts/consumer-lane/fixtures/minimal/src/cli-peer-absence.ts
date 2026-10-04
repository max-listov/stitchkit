// biome-ignore-all assist/source/organizeImports: Each compiler control must remain next to its export.
/** The strict CLI proof must fail when either SDK is visible to its own resolver. */
// @ts-expect-error The neutral installation must not resolve the MCP peer.
export type { CallToolResult } from '@modelcontextprotocol/server';
// @ts-expect-error The neutral installation must not resolve the AI peer.
export type { Tool } from 'ai';
