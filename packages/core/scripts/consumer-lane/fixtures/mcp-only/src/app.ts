import { createMcpHandler } from 'stitchkit/tools/mcp';

if (typeof createMcpHandler !== 'function') throw new Error('MCP server entrypoint missing');
console.log('MCP-only consumer: ok');
