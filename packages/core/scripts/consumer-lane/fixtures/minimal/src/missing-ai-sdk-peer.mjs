// This fixture intentionally omits the AI SDK peer. Static ESM resolution must
// fail at the opted-in AI SDK adapter boundary and name the exact package.
await import('stitchkit/agent-runtime/ai-sdk');
