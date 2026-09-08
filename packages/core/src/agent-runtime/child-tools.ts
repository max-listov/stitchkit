import { z } from 'zod';
import { defineAgentTool } from './agent-tool';
import {
  AgentChildBudgetSchema,
  type AgentChildManager,
  AgentChildRecordSchema,
} from './children';

function childTool(manager: AgentChildManager, fork: boolean) {
  return defineAgentTool({
    name: fork ? 'subagent_fork' : 'subagent',
    description: fork
      ? 'Run a child conversation seeded from the parent through one exact event sequence.'
      : 'Run a child conversation seeded from the current durable parent history.',
    identity: {
      serviceName: 'agent-children',
      action: fork ? 'fork' : 'spawn',
      method: 'POST',
    },
    input: z
      .object({
        parentConversationId: z.string().min(1),
        childInput: z.json(),
        budget: AgentChildBudgetSchema,
        seedUptoSeq: z.int().positive().optional(),
      })
      .strict(),
    output: z.object({
      childConversationId: z.string(),
      state: z.string(),
      resultReference: z.string().optional(),
    }),
    transports: ['AGENT'],
    handler: async ({ input }) => {
      if (fork && input.seedUptoSeq === undefined) {
        throw new TypeError('subagent_fork requires seedUptoSeq');
      }
      const child = await manager.spawnChild({
        parentConversationId: input.parentConversationId,
        childInput: input.childInput,
        budget: input.budget,
        ...(input.seedUptoSeq !== undefined && { seedUptoSeq: input.seedUptoSeq }),
      });
      await manager.waitChild(child.childConversationId);
      const finished = manager
        .listChildren(input.parentConversationId)
        .find((record) => record.childConversationId === child.childConversationId);
      if (!finished) throw new Error('Child record disappeared after settlement');
      return {
        childConversationId: finished.childConversationId,
        state: finished.state,
        ...(finished.resultReference && { resultReference: finished.resultReference }),
      };
    },
  });
}

export function createAgentChildTools(manager: AgentChildManager) {
  return [
    childTool(manager, false),
    childTool(manager, true),
    defineAgentTool({
      name: 'list_agents',
      description: 'List the durable child graph for one parent conversation.',
      identity: { serviceName: 'agent-children', action: 'list', method: 'GET' },
      input: z.object({ parentConversationId: z.string().min(1) }).strict(),
      output: z.object({ children: z.array(AgentChildRecordSchema) }),
      transports: ['AGENT'],
      handler: ({ input }) => ({
        children: [...manager.listChildren(input.parentConversationId)],
      }),
    }),
    defineAgentTool({
      name: 'send_message',
      description: 'Send one follow-up input to an active child conversation.',
      identity: { serviceName: 'agent-children', action: 'message', method: 'POST' },
      input: z
        .object({
          parentConversationId: z.string().min(1),
          childConversationId: z.string().min(1),
          input: z.json(),
        })
        .strict(),
      output: z.object({ sent: z.literal(true) }),
      transports: ['AGENT'],
      handler: async ({ input }) => {
        await manager.sendMessage(
          input.parentConversationId,
          input.childConversationId,
          input.input,
        );
        return { sent: true as const };
      },
    }),
    defineAgentTool({
      name: 'interrupt_agent',
      description: 'Stop one active child conversation at a durable policy boundary.',
      identity: { serviceName: 'agent-children', action: 'interrupt', method: 'POST' },
      input: z
        .object({
          parentConversationId: z.string().min(1),
          childConversationId: z.string().min(1),
        })
        .strict(),
      output: z.object({ interrupted: z.literal(true) }),
      transports: ['AGENT'],
      handler: async ({ input }) => {
        await manager.interruptChild(input.parentConversationId, input.childConversationId);
        return { interrupted: true as const };
      },
    }),
  ] as const;
}
