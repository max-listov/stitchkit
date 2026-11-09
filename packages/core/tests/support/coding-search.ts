import { SearchOutputSchema } from '../../src/agent-runtime/coding-search-contract';
import {
  type AgentCodingToolConfig,
  createAgentCodingTools,
} from '../../src/entrypoints/agent-runtime/coding-tools';
import { type AgentMountConfig, mountAgent } from '../../src/entrypoints/tools/agent';

export function searchWorkspace(
  config: AgentCodingToolConfig,
  hooks?: AgentMountConfig['hooks'],
) {
  const tools = mountAgent([], { runtimeTools: createAgentCodingTools(config), hooks });
  const execute = tools.search_files?.execute;
  if (!execute) throw new Error('Missing search_files');
  return async (
    input: Record<string, unknown> = { query: 'needle' },
    abortSignal?: AbortSignal,
  ) =>
    SearchOutputSchema.parse(
      await execute(input, {
        toolCallId: 'search-proof',
        messages: [],
        context: undefined,
        abortSignal,
      }),
    );
}
