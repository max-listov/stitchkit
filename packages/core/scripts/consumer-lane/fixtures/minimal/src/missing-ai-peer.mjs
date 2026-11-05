// This fixture intentionally omits the AI SDK peer. Static ESM resolution must
// fail at the opted-in agent boundary and name the exact package.
await import('stitchkit/tools/agent');
