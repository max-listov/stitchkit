import { createAgentCodingTools } from '../../src/entrypoints/agent-runtime/coding-tools';
import { mountAgent } from '../../src/entrypoints/tools';

const { entryBoundaryControls } = await import(
  new URL(
    '../../scripts/consumer-lane/fixtures/node/src/contained-entry-controls.mjs',
    import.meta.url,
  ).href
);
await entryBoundaryControls({ createAgentCodingTools, mountAgent });
