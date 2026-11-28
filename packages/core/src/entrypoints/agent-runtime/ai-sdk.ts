/**
 * `stitchkit/agent-runtime/ai-sdk` — thin optional adapter for AI SDK models and tool sets.
 *
 * Its own subpath because `ai` is an optional peer: `stitchkit/agent-runtime` owns
 * the single step loop behind `AgentModelDriver`, and this leaf adapts any AI SDK v4
 * `LanguageModel` or `ToolSet` without importing `streamText` or `generateText`. → ADR 0336.
 */
export {
  type FromAiSdkModelOptions,
  fromAiSdkModel,
  fromAiSdkTools,
} from '../../agent-runtime/ai-sdk';
