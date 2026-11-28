import type { AgentChildManager } from './children-contract';
import type { AgentRuntimeStopPolicy } from './runtime';
import { statedUsage } from './runtime-internals';

/**
 * The child runtime's own budget policy.
 *
 * `recordStepUsage` measures and decides; something has to call it at every
 * step boundary of the child's run, and that is the child's runtime. Given to
 * `createAgentRuntime({ loop: { stopPolicies: [agentChildBudgetStopPolicy(…)] } })`
 * in the host that runs the child, it reads the last step's provenance-aware
 * usage, records it, and stops the run as `policy_stop` (`child-budget`)
 * when the budget is spent.
 */
export function agentChildBudgetStopPolicy(input: {
  manager: Pick<AgentChildManager, 'recordStepUsage'>;
  childConversationId: string;
}): AgentRuntimeStopPolicy {
  let stepsSeen = 0;
  let lastBoundary = performance.now();
  return {
    name: 'child-budget',
    when: async ({ steps }) => {
      const step = steps.at(-1);
      if (!step || steps.length <= stepsSeen) return false;
      stepsSeen = steps.length;
      const elapsedMs = Math.round(Math.max(0, performance.now() - lastBoundary));
      lastBoundary = performance.now();
      const usage = statedUsage(step.usage);
      const boundary = await input.manager.recordStepUsage({
        childConversationId: input.childConversationId,
        usage,
        elapsedMs,
      });
      return boundary.stop;
    },
  };
}
