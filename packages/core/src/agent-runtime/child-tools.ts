import { z } from 'zod';
import { bindAgentTool, defineAgentToolDescriptor } from './agent-tool';
import {
  AgentChildBudgetSchema,
  type AgentChildManager,
  AgentChildRecordSchema,
} from './children';
import { conversationOfRun } from './context-issue';
import type { AgentRuntimeRunContext } from './runtime';

const ChildSpawnInputSchema = z
  .object({
    childInput: z.json(),
    budget: AgentChildBudgetSchema,
    seedUptoSeq: z.int().positive().optional(),
  })
  .strict();

const ChildSpawnOutputSchema = z.object({
  childConversationId: z.string(),
  state: z.string(),
  resultReference: z.string().optional(),
});

const SUBAGENT_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'subagent',
  description: 'Run a child conversation seeded from the current durable parent history.',
  identity: { serviceName: 'agent-children', action: 'spawn', method: 'POST' },
  input: ChildSpawnInputSchema,
  output: ChildSpawnOutputSchema,
  expose: ['AGENT'],
});

const SUBAGENT_FORK_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'subagent_fork',
  description:
    'Run a child conversation seeded from the parent through one exact event sequence.',
  identity: { serviceName: 'agent-children', action: 'fork', method: 'POST' },
  input: ChildSpawnInputSchema,
  output: ChildSpawnOutputSchema,
  expose: ['AGENT'],
});

const LIST_AGENTS_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'list_agents',
  description: 'List the durable child graph of this conversation.',
  identity: { serviceName: 'agent-children', action: 'list', method: 'GET' },
  input: z.object({}).strict(),
  output: z.object({ children: z.array(AgentChildRecordSchema) }),
  expose: ['AGENT'],
});

const SEND_MESSAGE_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'send_message',
  description: 'Send one follow-up input to an active child conversation.',
  identity: { serviceName: 'agent-children', action: 'message', method: 'POST' },
  input: z
    .object({
      childConversationId: z.string().min(1),
      input: z.json(),
    })
    .strict(),
  output: z.object({ sent: z.literal(true) }),
  expose: ['AGENT'],
});

const INTERRUPT_AGENT_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'interrupt_agent',
  description: 'Stop one active child conversation at a durable policy boundary.',
  identity: { serviceName: 'agent-children', action: 'interrupt', method: 'POST' },
  input: z.object({ childConversationId: z.string().min(1) }).strict(),
  output: z.object({ interrupted: z.literal(true) }),
  expose: ['AGENT'],
});

/**
 * Static non-executable descriptors for the built-in child tools (`createAgentChildTools`).
 * Single source of truth for catalog generation, preset validation, and live run-bound tools.
 */
export const AGENT_CHILD_TOOL_DESCRIPTORS = Object.freeze([
  SUBAGENT_DESCRIPTOR,
  SUBAGENT_FORK_DESCRIPTOR,
  LIST_AGENTS_DESCRIPTOR,
  SEND_MESSAGE_DESCRIPTOR,
  INTERRUPT_AGENT_DESCRIPTOR,
] as const);

/** Configuration binding child-management agent tools to a manager and active run context. */
export interface AgentChildToolsConfig {
  /**
   * What the tools call; any child manager has it. Its own limits — the
   * parent's remaining budget, the number of active children — bound what the
   * model may ask for: the tools add none of their own.
   */
  manager: Pick<
    AgentChildManager,
    'spawnChild' | 'waitChild' | 'listChildren' | 'sendMessage' | 'interruptChild'
  >;
  /** The run context `tools()` received: every tool acts for its conversation and no other. */
  run: AgentRuntimeRunContext<unknown>;
}

function childTool(
  { manager, run }: AgentChildToolsConfig,
  conversationId: string,
  fork: boolean,
) {
  return bindAgentTool(
    fork ? SUBAGENT_FORK_DESCRIPTOR : SUBAGENT_DESCRIPTOR,
    async ({ input }) => {
      if (fork && input.seedUptoSeq === undefined) {
        throw new TypeError('subagent_fork requires seedUptoSeq');
      }
      // A run already stopped spawns nothing: its cascade may have run, and a
      // child started after it would have no stop to meet. From here on the
      // spawn is the manager's, which a stop of the parent reaches.
      run.signal.throwIfAborted();
      const child = await manager.spawnChild({
        parentConversationId: conversationId,
        childInput: input.childInput,
        budget: input.budget,
        ...(input.seedUptoSeq !== undefined && { seedUptoSeq: input.seedUptoSeq }),
      });
      await manager.waitChild(child.childConversationId);
      const finished = (await manager.listChildren(conversationId)).find(
        (record) => record.childConversationId === child.childConversationId,
      );
      if (!finished) throw new Error('Child record disappeared after settlement');
      return {
        childConversationId: finished.childConversationId,
        state: finished.state,
        ...(finished.resultReference && { resultReference: finished.resultReference }),
      };
    },
  );
}

/**
 * Child tools bound to the parent conversation of one run. The address of a
 * live conversation is authority, so it comes from the run the runtime
 * started, never from the model and never from a free host argument.
 */
export function createAgentChildTools(config: AgentChildToolsConfig) {
  const { manager } = config;
  const conversationId = conversationOfRun(config.run, 'createAgentChildTools');
  return [
    childTool(config, conversationId, false),
    childTool(config, conversationId, true),
    bindAgentTool(LIST_AGENTS_DESCRIPTOR, async () => ({
      children: [...(await manager.listChildren(conversationId))],
    })),
    bindAgentTool(SEND_MESSAGE_DESCRIPTOR, async ({ input }) => {
      await manager.sendMessage(conversationId, input.childConversationId, input.input);
      return { sent: true as const };
    }),
    bindAgentTool(INTERRUPT_AGENT_DESCRIPTOR, async ({ input }) => {
      await manager.interruptChild(conversationId, input.childConversationId);
      return { interrupted: true as const };
    }),
  ] as const;
}
