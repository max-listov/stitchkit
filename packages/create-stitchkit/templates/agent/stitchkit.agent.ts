import { defineAgentTui } from '@stitchkit/tui';
import { openRouterModelCatalog } from 'stitchkit/agent-runtime/openrouter';
import { readAgentConfig } from './src/config';
import { createStarterHarness } from './src/runtime';

const environment = readAgentConfig(Bun.env);

export default defineAgentTui({
  title: 'Stitchkit agent',
  context: () => ({}),
  modelCatalog: openRouterModelCatalog({ apiKey: environment.apiKey }),
  ...(environment.preferredModelId && { preferredModelId: environment.preferredModelId }),
  createRuntime: ({ catalog, selections, diagnostics }) =>
    createStarterHarness(environment, process.cwd(), { catalog, selections, diagnostics }),
});
