import type { ToolSet } from 'ai';
import {
  type AgentPromptBudget,
  type AgentRuntimeConfig,
  type AgentTokenCount,
  composeAgentPrompt,
  createAgentRuntime,
} from 'stitchkit/agent-runtime';
import { z } from 'zod';

export const AgentHarnessResourceSchema = z.object({
  name: z.string().min(1),
  text: z.string(),
  provenance: z.string().min(1),
});

export const AgentHarnessResourceDiagnosticSchema = z.object({
  resource: z.string().min(1),
  severity: z.enum(['warning', 'error']),
  message: z.string().min(1),
});

export type AgentHarnessResource = z.infer<typeof AgentHarnessResourceSchema>;
export type AgentHarnessResourceDiagnostic = z.infer<
  typeof AgentHarnessResourceDiagnosticSchema
>;

export interface AgentHarnessResourceResult {
  resources: readonly AgentHarnessResource[];
  diagnostics: readonly AgentHarnessResourceDiagnostic[];
}

export interface HeadlessAgentHarnessConfig<CONTEXT, TOOLS extends ToolSet>
  extends Omit<AgentRuntimeConfig<CONTEXT, TOOLS>, 'prompt'> {
  resources: {
    load(input: {
      context: CONTEXT;
      signal: AbortSignal;
    }): AgentHarnessResourceResult | Promise<AgentHarnessResourceResult>;
    onDiagnostics?(input: {
      context: CONTEXT;
      diagnostics: readonly AgentHarnessResourceDiagnostic[];
    }): void | Promise<void>;
  };
  promptBudget(input: {
    context: CONTEXT;
    contextWindow: number;
  }): AgentPromptBudget | Promise<AgentPromptBudget>;
  estimateResourceTokens?(text: string): AgentTokenCount | Promise<AgentTokenCount>;
}

/**
 * Executable composition over the public runtime. It adds resource loading,
 * provenance and diagnostics, but deliberately adds no execution loop or queue.
 */
export function createHeadlessAgentHarness<CONTEXT, TOOLS extends ToolSet>(
  config: HeadlessAgentHarnessConfig<CONTEXT, TOOLS>,
) {
  const { resources, promptBudget, estimateResourceTokens, ...runtime } = config;
  return createAgentRuntime({
    ...runtime,
    prompt: async ({ context, signal, model }) => {
      const rawResult = await resources.load({ context, signal });
      const loaded: AgentHarnessResourceResult = {
        resources: AgentHarnessResourceSchema.array().parse(rawResult.resources),
        diagnostics: AgentHarnessResourceDiagnosticSchema.array().parse(rawResult.diagnostics),
      };
      await resources.onDiagnostics?.({
        context,
        diagnostics: loaded.diagnostics,
      });
      const prompt = composeAgentPrompt<CONTEXT>([
        {
          name: 'resources',
          stability: 'dynamic',
          render: () =>
            loaded.resources
              .map(
                (resource) =>
                  `<resource name="${resource.name}" provenance="${resource.provenance}">\n${resource.text}\n</resource>`,
              )
              .join('\n'),
          ...(estimateResourceTokens && {
            estimateTokens: estimateResourceTokens,
          }),
        },
      ]);
      return prompt({
        context,
        signal,
        budget: await promptBudget({
          context,
          contextWindow: model.descriptor.contextWindow,
        }),
      });
    },
  });
}
