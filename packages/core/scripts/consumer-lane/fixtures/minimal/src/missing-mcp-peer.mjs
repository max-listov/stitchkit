// This fixture intentionally omits the MCP server peer. Static ESM resolution
// must fail at the opted-in tools boundary and name the exact package whose
// install command is documented in the feature-to-peer matrix.
await import('stitchkit/tools');
