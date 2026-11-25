import { z } from 'zod';
import { bindAgentTool, defineAgentToolDescriptor } from './agent-tool';
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

const TodoOutputSchema = z.object({ items: z.array(TodoItemSchema) }).strict();

const CREATE_GOAL_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'create_goal',
  description: 'Create the durable objective for this conversation.',
  identity: { serviceName: 'agent-state', action: 'create-goal', method: 'POST' },
  input: z.object({ objective: z.string().min(1) }).strict(),
  output: GoalSchema,
  expose: ['AGENT'],
});

const UPDATE_GOAL_DESCRIPTOR = defineAgentToolDescriptor({
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
});

const GET_GOAL_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'get_goal',
  description: 'Read the durable objective for this conversation.',
  identity: { serviceName: 'agent-state', action: 'get-goal', method: 'GET' },
  input: z.object({}).strict(),
  output: z.object({ goal: GoalSchema.optional() }).strict(),
  expose: ['AGENT'],
});

const TODO_WRITE_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'todo_write',
  description: 'Replace the durable ordered work plan for this conversation.',
  identity: { serviceName: 'agent-state', action: 'write-todo', method: 'POST' },
  input: TodoOutputSchema,
  output: TodoOutputSchema,
  expose: ['AGENT'],
});

/**
 * Static non-executable descriptors for the built-in durable state tools (`createAgentStateTools`).
 * Single source of truth for catalog generation, preset validation, and live run-bound tools.
 */
export const AGENT_STATE_TOOL_DESCRIPTORS = Object.freeze([
  CREATE_GOAL_DESCRIPTOR,
  UPDATE_GOAL_DESCRIPTOR,
  GET_GOAL_DESCRIPTOR,
  TODO_WRITE_DESCRIPTOR,
] as const);

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
    bindAgentTool(CREATE_GOAL_DESCRIPTOR, async ({ input: request }) => {
      if (await input.state.get(input.conversationId, 'goal')) {
        throw new TypeError('A durable goal already exists for this conversation');
      }
      return writeGoal({ objective: request.objective, status: 'active' });
    }),
    bindAgentTool(UPDATE_GOAL_DESCRIPTOR, async ({ input: request }) => {
      const current = await input.state.get(input.conversationId, 'goal');
      if (!current) throw new TypeError('No durable goal exists for this conversation');
      const goal = GoalSchema.parse(current.value);
      return writeGoal({ ...goal, ...request });
    }),
    bindAgentTool(GET_GOAL_DESCRIPTOR, async () => {
      const current = await input.state.get(input.conversationId, 'goal');
      return { ...(current && { goal: GoalSchema.parse(current.value) }) };
    }),
    bindAgentTool(TODO_WRITE_DESCRIPTOR, async ({ input: request }) => {
      const stored = await input.state.set({
        conversationId: input.conversationId,
        name: 'todo',
        value: request,
        actor: 'agent',
      });
      return TodoOutputSchema.parse(stored.value);
    }),
  ] as const;
}
