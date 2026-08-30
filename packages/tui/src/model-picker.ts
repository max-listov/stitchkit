import type { AgentModelCatalog } from 'stitchkit/agent-runtime';
import { searchAgentModelCatalog } from 'stitchkit/agent-runtime';

export const AGENT_TUI_MODEL_RESULT_LIMIT = 200;

/** Search the complete catalog while bounding the options retained by the renderer. */
export function searchAgentTuiModels(catalog: AgentModelCatalog, query: string) {
  return searchAgentModelCatalog(catalog, {
    query,
    limit: AGENT_TUI_MODEL_RESULT_LIMIT,
  });
}
