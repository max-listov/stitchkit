import type { AgentModelMessage } from '../agent-parts/model';
import type { AgentToolSet } from '../tools/agent-tools';
import { issueRunContext } from './context-issue';
import { AgentContextOverflowError } from './context-refusal';
import { createAgentToolFenceLifecycle } from './managed-tools';
import type { AgentResolvedModel } from './models';
import type { AgentToolApprovalConfiguration } from './models-driver-step';
import type { ComposedAgentPrompt } from './prompt';
import { adoptSnapshot, type RunExecution } from './run-execution-state';
import {
  createRunHistoryProjection,
  loadDurableSystem,
  type RunHistoryProjection,
  seededInstructionMessage,
  snapshotForRunPrompt,
  USER_INSTRUCTION_SEED_KEY,
} from './run-prompt-history';
import { recordStepSpend } from './run-step-spend';
import type { AgentContextUsage, AgentRuntimeRunContext } from './runtime';
import type { AgentSnapshot } from './schemas';
import { appliedSnapshot } from './terminal-commit';

/** Everything the model phase needs that turn preparation settled once for the run. */
export interface PreparedTurn<CONTEXT, TOOLS extends AgentToolSet> {
  selectedModel: AgentResolvedModel;
  runtimeContext: AgentRuntimeRunContext<CONTEXT>;
  prompt: ComposedAgentPrompt;
  tools: TOOLS;
  toolApproval: AgentToolApprovalConfiguration<TOOLS, CONTEXT> | undefined;
  history: AgentModelMessage[];
  projection: RunHistoryProjection;
}

async function compactHistory<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  selectedModel: AgentResolvedModel,
  tools: TOOLS,
): Promise<void> {
  const { config, runtimeEpoch, generateId } = execution.dependencies;
  const { state, operationLifecycle, executionSignal } = execution;
  const compact = config.history?.compact;
  if (!compact) return;
  await operationLifecycle.startCompaction(generateId());
  let compacted: Awaited<ReturnType<typeof compact>>;
  try {
    compacted = await compact({
      conversationId: state.run.conversationId,
      store: config.store,
      signal: executionSignal,
      context: execution.input.context,
      model: selectedModel.descriptor,
      tools,
    });
  } catch (error) {
    const latest = await config.store.loadRun({
      conversationId: state.run.conversationId,
      runId: state.run.id,
    });
    if (latest?.run.ownerId === runtimeEpoch) {
      state.observedVersion = latest.snapshotVersion;
      state.run = latest.run;
    }
    await operationLifecycle.finish(executionSignal.aborted ? 'cancelled' : 'failed');
    throw error;
  }
  // A model call the run caused is the run's cost, even though it made no
  // step and emitted no model stream event of its own. Record it before
  // adopting the snapshot or finishing the operation lifecycle so a CAS
  // conflict cannot erase already-billed compaction spend.
  if (compacted.usage) {
    await recordStepSpend(execution, {
      phase: 'compaction',
      usage: compacted.usage,
      // Counted from one, like a model step's attempt: the try that produced the summary.
      attempt: compacted.attempts,
    });
  }
  adoptSnapshot(state, compacted.snapshot);
  await operationLifecycle.finish('completed');
}

function createRuntimeContext<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): AgentRuntimeRunContext<CONTEXT> {
  const { runtimeEpoch, config } = execution.dependencies;
  const { state, executionSignal } = execution;
  const assertCurrent = async (): Promise<'stale_run' | 'run_interrupted' | undefined> => {
    if (executionSignal.aborted) return 'run_interrupted';
    // Runs before EVERY tool call. Reading the whole conversation here is
    // what made a long conversation quadratic in its own length.
    const current = await config.store.loadRun({
      conversationId: state.run.conversationId,
      runId: state.run.id,
    });
    const currentRun = current?.run;
    if (!currentRun || currentRun.ownerId !== runtimeEpoch) return 'stale_run';
    if (currentRun.fencingToken !== state.run.fencingToken) return 'stale_run';
    if (currentRun.state === 'interrupt_requested') return 'run_interrupted';
    if (currentRun.state !== 'running') return 'stale_run';
    return undefined;
  };
  const toolFenceLifecycle = createAgentToolFenceLifecycle({
    runId: state.run.id,
    assertCurrent,
    context: () => ({
      ...(state.run.fencingToken !== undefined && { fencingToken: state.run.fencingToken }),
    }),
  });
  return issueRunContext({
    context: execution.input.context,
    get run() {
      return state.run;
    },
    signal: executionSignal,
    toolFenceLifecycle,
    // A getter, because a step reads it after the previous step landed and a
    // snapshot taken here would be one step stale for the whole run.
    get contextUsage(): AgentContextUsage | undefined {
      const descriptor = state.selectedModel?.descriptor;
      if (!descriptor) return undefined;
      return { usedTokens: state.lastPromptTokens, contextWindow: descriptor.contextWindow };
    },
    get selectedModel(): AgentResolvedModel | undefined {
      return state.selectedModel;
    },
  });
}

/**
 * User-role instructions are durable history, not a per-call prelude:
 * seeded once under one conversation key and read back from the store, so
 * compaction may summarize them, a clear removes them, and a retry or
 * replay cannot append a second copy. → ADR 0178
 *
 * Answers whether this call inserted any, which is what `finalizeSeed` asks,
 * or `undefined` when the prompt had nothing to seed and no store was touched.
 */
async function seedUserInstructions<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
  prompt: ComposedAgentPrompt,
): Promise<boolean | undefined> {
  const { config, now } = execution.dependencies;
  const { state } = execution;
  if (!prompt.userInstructions || prompt.userInstructions.length === 0) return undefined;
  const conversationId = state.run.conversationId;
  const seededAt = now().toISOString();
  const seeded = await config.store.seedConversationInput({
    conversationId,
    seedKey: USER_INSTRUCTION_SEED_KEY,
    inputs: prompt.userInstructions.map((section, index) =>
      seededInstructionMessage({
        conversationId,
        seedKey: USER_INSTRUCTION_SEED_KEY,
        index,
        text: section.text,
        createdAt: seededAt,
      }),
    ),
  });
  const seededSnapshot = appliedSnapshot(seeded, 'user instruction seed');
  const previousIds = new Set(state.snapshot.messages.map((message) => message.id));
  const inserted = seededSnapshot.messages.some(
    (message) =>
      !previousIds.has(message.id) && message.role === 'user' && message.runId === undefined,
  );
  adoptSnapshot(state, seededSnapshot);
  return inserted;
}

/**
 * Everything before the first provider call: compaction, the model, the
 * composed prompt and tools, the seeded instructions, the context decision
 * and the projected history.
 */
export async function prepareTurn<CONTEXT, TOOLS extends AgentToolSet>(
  execution: RunExecution<CONTEXT, TOOLS>,
): Promise<PreparedTurn<CONTEXT, TOOLS>> {
  const { config } = execution.dependencies;
  const { state, executionSignal } = execution;
  const runtimeContext = createRuntimeContext(execution);
  execution.runtimeContext = runtimeContext;
  const selectedModel = await config.models.resolve({
    context: execution.input.context,
    conversationId: state.run.conversationId,
    run: state.run,
    snapshot: state.snapshot,
  });
  state.selectedModel = selectedModel;
  let tools: TOOLS;
  let composedPrompt: ComposedAgentPrompt;
  let promptSnapshot: AgentSnapshot;
  if (config.history?.compact) {
    tools = await config.tools(runtimeContext);
    await compactHistory(execution, selectedModel, tools);
    promptSnapshot = snapshotForRunPrompt(state.snapshot, state.run.id);
    composedPrompt = await config.prompt({
      context: execution.input.context,
      signal: executionSignal,
      event: promptSnapshot.runs[0]?.id === state.run.id ? 'session.started' : 'turn.started',
      model: selectedModel,
      snapshot: promptSnapshot,
    });
  } else {
    promptSnapshot = snapshotForRunPrompt(state.snapshot, state.run.id);
    [composedPrompt, tools] = await Promise.all([
      config.prompt({
        context: execution.input.context,
        signal: executionSignal,
        event:
          promptSnapshot.runs[0]?.id === state.run.id ? 'session.started' : 'turn.started',
        model: selectedModel,
        snapshot: promptSnapshot,
      }),
      config.tools(runtimeContext),
    ]);
  }
  const toolApproval = config.loop?.toolApproval;
  let prompt = composedPrompt;
  const userInstructionsInserted = await seedUserInstructions(execution, prompt);
  if (userInstructionsInserted !== undefined) {
    promptSnapshot = snapshotForRunPrompt(state.snapshot, state.run.id);
  }
  if (prompt.finalizeSeed)
    prompt = { ...prompt, ...prompt.finalizeSeed(userInstructionsInserted ?? false) };
  if (prompt.contextDecision === 'oversized') {
    throw new AgentContextOverflowError();
  }
  if (prompt.contextDecision === 'requires-compaction') {
    throw new AgentContextOverflowError(
      'Agent context still exceeds the model budget after compaction',
    );
  }
  const projection = createRunHistoryProjection({
    config,
    currentRun: () => state.run,
    durableSystem: await loadDurableSystem(config, state.run.conversationId),
    tools,
  });
  const history: AgentModelMessage[] = [...(await projection.projectHistory(promptSnapshot))];
  return { selectedModel, runtimeContext, prompt, tools, toolApproval, history, projection };
}
