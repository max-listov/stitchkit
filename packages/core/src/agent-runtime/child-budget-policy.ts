import type { LanguageModelUsage } from 'ai';
import type { AgentChildManager } from './children-contract';
import type { AgentRuntimeStopPolicy } from './runtime';
import { normalizeSdkUsage } from './runtime-internals';
import type { AgentUsage } from './schemas';

/**
 * The child runtime's own budget policy.
 *
 * `recordStepUsage` measures and decides; something has to call it at every
 * step boundary of the child's run, and that is the child's runtime. Given to
 * `createAgentRuntime({ loop: { stopPolicies: [agentChildBudgetStopPolicy(…)] } })`
 * in the host that runs the child, it records the last step's usage and stops
 * the run as `policy_stop` (`child-budget`) when the budget is spent — the
 * enforcement the guide promises, in the package rather than in every host.
 */
export function agentChildBudgetStopPolicy(input: {
  manager: Pick<AgentChildManager, 'recordStepUsage'>;
  childConversationId: string;
  /** Cost of a step, when a USD budget is set; tokens come from the step itself. */
  cost?: (step: { usage: LanguageModelUsage }) => AgentUsage['cost'];
}): AgentRuntimeStopPolicy {
  let stepsSeen = 0;
  let lastBoundary = performance.now();
  return {
    name: 'child-budget',
    when: async ({ steps }) => {
      const step = steps.at(-1);
      if (!step || steps.length <= stepsSeen) return false;
      stepsSeen = steps.length;
      const elapsedMs = Math.max(0, performance.now() - lastBoundary);
      lastBoundary = performance.now();
      const usage = normalizeSdkUsage(step.usage);
      const cost = input.cost?.({ usage: step.usage });
      const boundary = await input.manager.recordStepUsage({
        childConversationId: input.childConversationId,
        usage: { ...usage, ...(cost && { cost }) },
        elapsedMs,
      });
      return boundary.stop;
    },
  };
}
