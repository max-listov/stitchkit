import { z } from 'zod';
import { defineAgentTool } from './agent-tool';
import { conversationOfRun } from './context-issue';
import type { AgentRuntimeRunContext } from './runtime';
import type { AgentStateSlotStore } from './state-slots';

const GoalSchema = z
  .object({
    objective: z.string().min(1),
    status: z.enum(['active', 'complete', 'blocked']),
  })
  .strict();

const TodoItemSchema = z
  .object({
    step: z.string().min(1),
    status: z.enum(['pending', 'in_progress', 'completed']),
  })
  .strict();

/** Configuration binding durable state-slot agent tools to a store and active run context. */
export interface AgentStateToolsConfig {
  state: AgentStateSlotStore;
  /** The run context `tools()` received: every tool acts for its conversation and no other. */
  run: AgentRuntimeRunContext<unknown>;
}

/** Agent tools bound to the conversation of one run; callers cannot address a sibling's state. */
export function createAgentStateTools(config: AgentStateToolsConfig) {
  const input = {
    state: config.state,
    conversationId: conversationOfRun(config.run, 'createAgentStateTools'),
  };
  const writeGoal = async (value: z.infer<typeof GoalSchema>) => {
    const stored = await input.state.set({
      conversationId: input.conversationId,
      name: 'goal',
      value,
      actor: 'agent',
    });
    return GoalSchema.parse(stored.value);
  };

  return [
    defineAgentTool({
      name: 'create_goal',
      description: 'Create the durable objective for this conversation.',
      identity: { serviceName: 'agent-state', action: 'create-goal', method: 'POST' },
      input: z.object({ objective: z.string().min(1) }).strict(),
      output: GoalSchema,
      expose: ['AGENT'],
      handler: async ({ input: request }) => {
        if (await input.state.get(input.conversationId, 'goal')) {
          throw new TypeError('A durable goal already exists for this conversation');
        }
        return writeGoal({ objective: request.objective, status: 'active' });
      },
    }),
    defineAgentTool({
      name: 'update_goal',
      description: 'Update the durable objective or lifecycle status.',
      identity: { serviceName: 'agent-state', action: 'update-goal', method: 'POST' },
      input: z
        .object({
          objective: z.string().min(1).optional(),
          status: z.enum(['active', 'complete', 'blocked']).optional(),
        })
        .strict()
        .refine((request) => request.objective !== undefined || request.status !== undefined, {
          message: 'At least one goal field must be supplied',
        }),
      output: GoalSchema,
      expose: ['AGENT'],
      handler: async ({ input: request }) => {
        const current = await input.state.get(input.conversationId, 'goal');
        if (!current) throw new TypeError('No durable goal exists for this conversation');
        const goal = GoalSchema.parse(current.value);
        return writeGoal({ ...goal, ...request });
      },
    }),
    defineAgentTool({
      name: 'get_goal',
      description: 'Read the durable objective for this conversation.',
      identity: { serviceName: 'agent-state', action: 'get-goal', method: 'GET' },
      input: z.object({}).strict(),
      output: z.object({ goal: GoalSchema.optional() }).strict(),
      expose: ['AGENT'],
      handler: async () => {
        const current = await input.state.get(input.conversationId, 'goal');
        return { ...(current && { goal: GoalSchema.parse(current.value) }) };
      },
    }),
    defineAgentTool({
      name: 'todo_write',
      description: 'Replace the durable ordered work plan for this conversation.',
      identity: { serviceName: 'agent-state', action: 'write-todo', method: 'POST' },
      input: z.object({ items: z.array(TodoItemSchema) }).strict(),
      output: z.object({ items: z.array(TodoItemSchema) }).strict(),
      expose: ['AGENT'],
      handler: async ({ input: request }) => {
        const stored = await input.state.set({
          conversationId: input.conversationId,
          name: 'todo',
          value: request,
          actor: 'agent',
        });
        return z
          .object({ items: z.array(TodoItemSchema) })
          .strict()
          .parse(stored.value);
      },
    }),
  ] as const;
}
