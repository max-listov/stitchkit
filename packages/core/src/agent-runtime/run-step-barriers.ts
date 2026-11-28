import type { ContractDef } from '../contract/define';
import { contractOperationEffects, type OperationEffect } from '../contract/operation-effect';
import { raceAbort } from '../internal/abort-race';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { AgentToolError } from '../tools/agent-tool-error';
import { listContractToolNames } from '../tools/list-names';
import type { AgentModelFinishReason } from './models-driver';
import type { AgentStepToolCall, AgentStepToolResult } from './models-driver-step';

/**
 * What one tool call touches, by entity key. Within a step a read waits for the
 * earlier writes of its entity, and a write for the earlier reads and writes.
 */
export interface AgentToolCallDependencies {
  reads?: readonly string[];
  writes?: readonly string[];
}

/**
 * Guards on one model step. A step is one provider response and the tool calls it
 * asked for; every bound resets at the next step.
 */
export interface AgentStepBarriers {
  /**
   * Tool calls one step may make. A call past it is refused to the model as a tool
   * error naming the bound, without asking for its approval.
   */
  maxToolCallsPerStep?: number;
  /** Reasoning one step may stream, in characters; see `onMaxReasoningChars` for overflow action. */
  maxReasoningCharsPerStep?: number;
  /**
   * What happens when a step exceeds `maxReasoningCharsPerStep`:
   * - `'abort'` (default): stops the run immediately as `policy_stop`.
   * - `'finish-length'`: cuts off the current step cleanly with `finishReason: 'length'`
   *   so `protocol.acceptTerminal` can decide whether to accept, reject, or continue recovery.
   */
  onMaxReasoningChars?: 'abort' | 'finish-length';
  /**
   * Which entities a call reads and writes. Calls run in the order the model made
   * them as far as their entities allow: a read waits until every earlier write of
   * its entity in the step has finished, a write until every earlier read and write
   * of it has — never a read of a value about to change, never two writes racing.
   */
  toolDependencies?: (call: {
    toolName: string;
    input: unknown;
  }) => AgentToolCallDependencies | undefined;
  /**
   * `after-tools`: a step's text is held until the step ends, and shown only when
   * none of its tool calls failed or requested approval — the model never announces
   * what did not happen. Default `immediate`.
   */
  stepText?: 'immediate' | 'after-tools';
  /**
   * What happens to text held by `stepText: 'after-tools'` if the run is interrupted
   * before the step completes (when no tool in the step has failed):
   * - `'drop'` (default): held text is discarded on interrupt.
   * - `'flush'`: held text is flushed to the assistant message before committing the interrupt.
   */
  stepTextOnInterrupt?: 'drop' | 'flush';
  /**
   * Optional transform/filter invoked before releasing held step text under `stepText: 'after-tools'`.
   * Return a replacement string to emit, or `undefined` / empty string to suppress the held text.
   */
  filterStepText?: (
    text: string,
    context: {
      readonly step: number;
      readonly interrupted: boolean;
      readonly finishReason: AgentModelFinishReason;
      readonly toolCalls: readonly AgentStepToolCall[];
      readonly toolResults: readonly AgentStepToolResult[];
    },
  ) => string | undefined;
  /**
   * What a dependent tool call does when an earlier call it waited on for the same
   * entity failed in the same step: `'run'` executes as usual (default); `'refuse'`
   * refuses the dependent call with a structured `AgentToolError` without running it.
   */
  onPredecessorFailure?: 'run' | 'refuse';
}

/** A step bound that stops the run (or cuts the current step cleanly) was crossed: `reasoning`. */
export class AgentStepBarrierError extends Error {
  constructor(
    readonly bound: 'reasoning',
    message: string,
    readonly action: 'abort' | 'finish-length' = 'abort',
  ) {
    super(message);
    this.name = 'AgentStepBarrierError';
  }
}

/** Refuse a bound no step could meet, when the runtime is created. */
export function assertStepBarriers(barriers: AgentStepBarriers | undefined): void {
  if (!barriers) return;
  assertPositiveSafeInteger(
    'stepBarriers.maxToolCallsPerStep',
    barriers.maxToolCallsPerStep,
    RangeError,
  );
  assertPositiveSafeInteger(
    'stepBarriers.maxReasoningCharsPerStep',
    barriers.maxReasoningCharsPerStep,
    RangeError,
  );
  if (
    barriers.onMaxReasoningChars !== undefined &&
    !['abort', 'finish-length'].includes(barriers.onMaxReasoningChars)
  )
    throw new RangeError(
      "stepBarriers.onMaxReasoningChars must be 'abort' or 'finish-length'",
    );
  if (
    barriers.stepText !== undefined &&
    !['immediate', 'after-tools'].includes(barriers.stepText)
  )
    throw new RangeError("stepBarriers.stepText must be 'immediate' or 'after-tools'");
  if (
    barriers.stepTextOnInterrupt !== undefined &&
    !['drop', 'flush'].includes(barriers.stepTextOnInterrupt)
  )
    throw new RangeError("stepBarriers.stepTextOnInterrupt must be 'drop' or 'flush'");
  if (
    barriers.onPredecessorFailure !== undefined &&
    !['run', 'refuse'].includes(barriers.onPredecessorFailure)
  )
    throw new RangeError("stepBarriers.onPredecessorFailure must be 'run' or 'refuse'");
}

/** Refusal raised when a step exceeds `maxToolCallsPerStep`. */
export function stepToolCallLimitRefusal(limit: number): AgentToolError {
  return new AgentToolError({
    code: 'STEP_TOOL_CALL_LIMIT',
    message: `Refused: a step may make at most ${limit} tool calls; make the rest in the next step`,
  });
}

export interface StepCallSlot {
  readonly refused: boolean;
  readonly limit?: number;
  waitAhead(signal?: AbortSignal): Promise<void>;
  settle(ok?: boolean): void;
}

interface EntityState {
  write?: Promise<boolean>;
  reads: Promise<boolean>[];
}

/**
 * Per-step tool-call scheduler enforcing `maxToolCallsPerStep` and entity read/write
 * ordering directly as scheduling policy rather than wrapping tool functions. → ADR 0336.
 */
export function createStepCallScheduler(barriers: AgentStepBarriers | undefined) {
  let count = 0;
  const entities = new Map<string, EntityState>();
  const limit = barriers?.maxToolCallsPerStep;
  const stateOf = (entity: string): EntityState => {
    const known = entities.get(entity);
    if (known) return known;
    const fresh: EntityState = { reads: [] };
    entities.set(entity, fresh);
    return fresh;
  };

  const registerDependencies = (
    dependencies: AgentToolCallDependencies,
    ownPromise: Promise<boolean>,
  ): Promise<boolean>[] => {
    const writes = new Set(dependencies.writes ?? []);
    const reads = new Set(
      [...(dependencies.reads ?? [])].filter((entity) => !writes.has(entity)),
    );
    const ahead: Promise<boolean>[] = [];
    for (const entity of reads) {
      const state = stateOf(entity);
      if (state.write) ahead.push(state.write);
      state.reads.push(ownPromise);
    }
    for (const entity of writes) {
      const state = stateOf(entity);
      if (state.write) ahead.push(state.write);
      ahead.push(...state.reads);
      state.write = ownPromise;
      state.reads = [];
    }
    return ahead;
  };

  return {
    /**
     * Record a failed predecessor (invalid input or batch refusal) on its entities
     * without consuming `maxToolCallsPerStep`, so subsequent dependent calls in this
     * step see the failure when `onPredecessorFailure: 'refuse'` is active.
     */
    recordFailedPredecessor(toolName: string, input: unknown): readonly string[] {
      if (!barriers?.toolDependencies) return [];
      let dependencies: AgentToolCallDependencies | undefined;
      try {
        dependencies = barriers.toolDependencies({ toolName, input });
      } catch {
        return [];
      }
      if (!dependencies) return [];
      registerDependencies(dependencies, Promise.resolve(false));
      return [...(dependencies.reads ?? []), ...(dependencies.writes ?? [])];
    },
    enter(toolName: string, input: unknown): StepCallSlot {
      count += 1;
      const refused = limit !== undefined && count > limit;
      if (refused) {
        return {
          refused: true,
          limit,
          waitAhead: async () => undefined,
          settle: () => undefined,
        };
      }
      const dependencies = barriers?.toolDependencies?.({ toolName, input });
      if (!dependencies) {
        return {
          refused: false,
          waitAhead: async () => undefined,
          settle: () => undefined,
        };
      }
      const own = Promise.withResolvers<boolean>();
      let settled = false;
      const settle = (ok = true): void => {
        if (settled) return;
        settled = true;
        own.resolve(ok);
      };
      const ahead = registerDependencies(dependencies, own.promise);
      return {
        refused: false,
        async waitAhead(signal?: AbortSignal) {
          if (ahead.length === 0) return;
          const all = Promise.all(ahead);
          const outcomes = await (signal ? raceAbort(all, signal) : all);
          if (
            barriers?.onPredecessorFailure === 'refuse' &&
            outcomes.some((ok) => ok === false)
          ) {
            throw new AgentToolError({
              code: 'STEP_PREDECESSOR_FAILED',
              message: 'Refused: an earlier tool call on the same entity failed in this step',
            });
          }
        },
        settle,
      };
    },
  };
}

/**
 * Step dependencies from operation effects — the `effect` of each endpoint of
 * `contracts`, under the name its tool is mounted as, and `effects` for tools of
 * no contract — and the application's own `entityOf`: a `write` tool writes its
 * entity, a `read` tool reads it, a tool with no entity or no effect is unordered.
 */
export function createToolDependencyResolver(input: {
  contracts?: readonly ContractDef[];
  effects?: Readonly<Record<string, OperationEffect>>;
  entityOf: (toolName: string, input: unknown) => string | undefined;
}): NonNullable<AgentStepBarriers['toolDependencies']> {
  const effects = new Map<string, OperationEffect>();
  for (const contract of input.contracts ?? []) {
    const byEndpoint = contractOperationEffects(contract);
    for (const entry of listContractToolNames([contract])) {
      const effect = byEndpoint[entry.method];
      if (effect !== undefined) effects.set(entry.name, effect);
    }
  }
  for (const [toolName, effect] of Object.entries(input.effects ?? {})) {
    if (effects.has(toolName))
      throw new RangeError(
        `Tool "${toolName}" already has the effect of its contract endpoint`,
      );
    effects.set(toolName, effect);
  }
  return ({ toolName, input: callInput }) => {
    const effect = effects.get(toolName);
    const entity = effect && input.entityOf(toolName, callInput);
    if (entity === undefined || effect === undefined) return undefined;
    return effect === 'write' ? { writes: [entity] } : { reads: [entity] };
  };
}
