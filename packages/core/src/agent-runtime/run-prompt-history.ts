import { createHash } from 'node:crypto';
import type { Instructions, ModelMessage, SystemModelMessage, ToolSet } from 'ai';
import { projectAgentHistoryDetailed } from './history';
import type { AgentRuntimeConfig } from './runtime';
import {
  type AgentMessage,
  AgentMessageSchema,
  type AgentRun,
  type AgentSnapshot,
  AgentSnapshotSchema,
} from './schemas';
import { createAgentStateSlotStore, renderAgentStateSlots } from './state-slots';
import { AgentRuntimeConflictError } from './terminal-commit';

/**
 * The conversation as this run is allowed to know it.
 *
 * Durable admission may append successor inputs while acquisition or the
 * initial assistant checkpoint is awaiting I/O. Those inputs belong to later
 * runs and cannot enter this run's prompt merely because they already exist in
 * the conversation aggregate. Unowned records (summary/system) remain shared;
 * run-owned records become eligible in causal run order through this run.
 */
export function snapshotForRunPrompt(snapshot: AgentSnapshot, runId: string): AgentSnapshot {
  const runIndex = snapshot.runs.findIndex((candidate) => candidate.id === runId);
  if (runIndex < 0) throw new AgentRuntimeConflictError('prompt run lookup');
  const ownedIds = new Set(
    snapshot.runs.flatMap((candidate) => [
      ...candidate.inputMessageIds,
      candidate.assistantMessageId,
    ]),
  );
  const eligibleIds = new Set(
    snapshot.runs
      .slice(0, runIndex + 1)
      .flatMap((candidate) => [...candidate.inputMessageIds, candidate.assistantMessageId]),
  );
  return AgentSnapshotSchema.parse({
    ...snapshot,
    messages: snapshot.messages.filter(
      (message) => !ownedIds.has(message.id) || eligibleIds.has(message.id),
    ),
  });
}

/**
 * The conversation-level key under which user-role prompt sections are seeded.
 *
 * One key per conversation: the ADR's once-seeding is "on the first turn", so a
 * later set of definitions does not add a second copy — a changed brief belongs
 * to whichever run seeded the conversation first. → ADR 0178
 */
export const USER_INSTRUCTION_SEED_KEY = 'prompt.user-instructions';

/**
 * The durable identity of one seeded user-instruction message.
 *
 * Deterministic from the conversation and the section position, so a
 * conversation imported from an archive — whose seed receipt was not part of
 * that archive — matches the messages already in its history rather than
 * seeding a second copy.
 */
export function seededInstructionMessage(input: {
  conversationId: string;
  seedKey: string;
  index: number;
  text: string;
  createdAt: string;
}): AgentMessage {
  return AgentMessageSchema.parse({
    schemaVersion: 1,
    id: createHash('sha256')
      .update(`${input.conversationId}\u0000${input.seedKey}\u0000${input.index}`)
      .digest('hex'),
    conversationId: input.conversationId,
    role: 'user',
    status: 'committed',
    parts: [{ type: 'text', text: input.text }],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}

/** The rendered state slots, which every provider request carries as system content. */
export async function loadDurableSystem<CONTEXT, TOOLS extends ToolSet>(
  config: AgentRuntimeConfig<CONTEXT, TOOLS>,
  conversationId: string,
): Promise<readonly string[]> {
  if (config.stateSlots && config.stateSlots.length > 0) {
    const slotValues = await createAgentStateSlotStore({
      store: config.store,
      definitions: config.stateSlots,
    }).list(conversationId);
    const renderedSlots = renderAgentStateSlots(slotValues);
    if (renderedSlots) return [renderedSlots];
  }
  return [];
}

/** The history projection of one run, and the system content it carries out of it. */
export interface RunHistoryProjection {
  projectHistory(source: AgentSnapshot): Promise<ModelMessage[]>;
  /**
   * The same projection, for messages that are not the conversation.
   *
   * Separate from `projectHistory` because that one publishes into
   * `carriedSystem`, and running it over a single user message would
   * replace the conversation's carried system content with an empty list.
   */
  projectInputs(source: readonly AgentMessage[]): Promise<ModelMessage[]>;
  withCarriedSystem(instructions: Instructions): Instructions;
}

function detailedProjection<CONTEXT, TOOLS extends ToolSet>(
  config: AgentRuntimeConfig<CONTEXT, TOOLS>,
  source: readonly AgentMessage[],
) {
  return projectAgentHistoryDetailed(source, {
    ...(config.history?.resolveFile && { resolveFile: config.history.resolveFile }),
    ...(config.history?.unresolvedFile && {
      unresolvedFile: config.history.unresolvedFile,
    }),
    ...(config.history?.interruptedAssistant && {
      interruptedAssistant: config.history.interruptedAssistant,
    }),
    ...(config.history?.evidencePolicy && {
      evidencePolicy: config.history.evidencePolicy,
    }),
  });
}

export function createRunHistoryProjection<CONTEXT, TOOLS extends ToolSet>(input: {
  config: AgentRuntimeConfig<CONTEXT, TOOLS>;
  /** Read at projection time: the run's input ids are the ones it holds then. */
  currentRun(): AgentRun;
  durableSystem: readonly string[];
}): RunHistoryProjection {
  const { config, durableSystem } = input;
  // Carried out of the projection so the provider's instructions channel
  // gets it. `ai` refuses a system-role entry inside `messages`, so a
  // compacted conversation used to fail every run after the compaction.
  let carriedSystem: readonly string[] = durableSystem;
  return {
    async projectHistory(source) {
      if (config.history?.project) return config.history.project(source.messages);
      const detailed = await detailedProjection(config, source.messages);
      const run = input.currentRun();
      for (const decision of detailed.decisions) {
        if (
          decision.action === 'omitted' &&
          run.inputMessageIds.includes(decision.messageId) &&
          source.messages.some(
            (message) => message.id === decision.messageId && message.role === 'tool',
          )
        ) {
          // Omitting old partial evidence is allowed. Silently discarding the
          // active approval decision would turn an invalid command into a new model turn.
          throw new Error(
            `Invalid approval continuation ${decision.messageId}: ${decision.reason}`,
          );
        }
      }
      carriedSystem = [...durableSystem, ...detailed.system];
      return [...detailed.messages];
    },
    async projectInputs(source) {
      if (config.history?.project) return config.history.project(source);
      const detailed = await detailedProjection(config, source);
      return [...detailed.messages];
    },
    // `Instructions` is `string | SystemModelMessage | SystemModelMessage[]`,
    // so the composed prompt is normalised before the carried entries join it.
    withCarriedSystem(instructions) {
      if (carriedSystem.length === 0) return instructions;
      const composed: SystemModelMessage[] =
        typeof instructions === 'string'
          ? [{ role: 'system', content: instructions }]
          : Array.isArray(instructions)
            ? instructions
            : [instructions];
      return [
        ...composed,
        ...carriedSystem.map((content): SystemModelMessage => ({ role: 'system', content })),
      ];
    },
  };
}
