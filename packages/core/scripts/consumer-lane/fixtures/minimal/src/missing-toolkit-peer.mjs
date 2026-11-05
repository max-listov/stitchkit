// This fixture intentionally omits the MCP server and AI SDK peers. Static ESM
// resolution must fail at the opted-in toolkit boundary and name the exact
// package whose install command is documented in the feature-to-peer matrix.
await import('stitchkit/tools/toolkit');
