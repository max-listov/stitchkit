import type { ToolApprovalConfiguration, ToolSet } from 'ai';
import type { ContractDef } from '../contract/define';
import { contractOperationEffects, type OperationEffect } from '../contract/operation-effect';
import { raceAbort } from '../internal/abort-race';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { mapObjectTypeBoundary } from '../internal/typed';
import { AgentToolError } from '../tools/agent-tool-error';
import { listContractToolNames } from '../tools/list-names';
import { carryDeferredToolCatalog } from './deferred-tools-internal';

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
  /** Reasoning one step may stream, in characters; past it the run stops as `policy_stop`. */
  maxReasoningCharsPerStep?: number;
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
   * none of its tool calls failed — the model never announces what did not happen.
   * Text held when the run is interrupted before the step ends is not shown.
   * Default `immediate`.
   */
  stepText?: 'immediate' | 'after-tools';
}

/** A step bound that stops the run was crossed: `reasoning`. */
export class AgentStepBarrierError extends Error {
  constructor(
    readonly bound: 'reasoning',
    message: string,
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
    barriers.stepText !== undefined &&
    !['immediate', 'after-tools'].includes(barriers.stepText)
  )
    throw new RangeError("stepBarriers.stepText must be 'immediate' or 'after-tools'");
}

interface CallEntry {
  refused: boolean;
  ahead: readonly Promise<void>[];
  settle: () => void;
}

interface EntityState {
  write?: Promise<void>;
  reads: Promise<void>[];
}

interface StepLedger {
  /** The history the SDK hands every call of one step: the step's identity. */
  messages: unknown;
  count: number;
  calls: Map<string, CallEntry>;
  entities: Map<string, EntityState>;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, Symbol.asyncIterator) === 'function'
  );
}

function isAsyncGeneratorFunction(value: unknown): boolean {
  return Object.prototype.toString.call(value) === '[object AsyncGeneratorFunction]';
}

/**
 * The one final result of a call that resolved to `value`: an async iterable
 * a promise resolved to is drained, and its last value is the result.
 */
async function finalOutput(value: unknown): Promise<unknown> {
  if (!isAsyncIterable(value)) return value;
  let last: unknown;
  for await (const output of value) last = output;
  return last;
}

/**
 * The step ledger of one run turn: a call is entered the first time the SDK shows
 * it — `onInputAvailable`, its approval, or its execution — which happens in the
 * order the model made the calls, before any of them runs.
 */
function createStepLedger(barriers: AgentStepBarriers) {
  let current: StepLedger | undefined;
  return (
    messages: unknown,
    toolCallId: string,
    toolName: string,
    input: unknown,
  ): CallEntry => {
    if (current === undefined || current.messages !== messages)
      current = { messages, count: 0, calls: new Map(), entities: new Map() };
    const ledger = current;
    const known = ledger.calls.get(toolCallId);
    if (known) return known;
    ledger.count += 1;
    const limit = barriers.maxToolCallsPerStep;
    const refused = limit !== undefined && ledger.count > limit;
    const own = Promise.withResolvers<void>();
    const dependencies = refused
      ? undefined
      : barriers.toolDependencies?.({ toolName, input });
    const writes = new Set(dependencies?.writes ?? []);
    const reads = new Set(
      [...(dependencies?.reads ?? [])].filter((entity) => !writes.has(entity)),
    );
    const stateOf = (entity: string): EntityState => {
      const known = ledger.entities.get(entity);
      if (known) return known;
      const fresh: EntityState = { reads: [] };
      ledger.entities.set(entity, fresh);
      return fresh;
    };
    const ahead: Promise<void>[] = [];
    for (const entity of reads) {
      const state = stateOf(entity);
      if (state.write) ahead.push(state.write);
      state.reads.push(own.promise);
    }
    for (const entity of writes) {
      const state = stateOf(entity);
      if (state.write) ahead.push(state.write);
      ahead.push(...state.reads);
      state.write = own.promise;
      state.reads = [];
    }
    const entry = { refused, ahead, settle: () => own.resolve() };
    ledger.calls.set(toolCallId, entry);
    return entry;
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof Reflect.get(value, 'then') === 'function'
  );
}

/**
 * When approval prevents a call from running in this step (`needsApproval: true`,
 * `'needs-approval'`, `'user-approval'`, `'denied'`, or an exception), settle its
 * ledger slot immediately so later calls on the same entity do not deadlock waiting
 * on an `execute()` that the SDK will never invoke.
 */
function settleOnDecision<V>(
  entry: CallEntry,
  produce: () => V | PromiseLike<V>,
  skipsExecute: (decision: V) => boolean,
): V | Promise<V> {
  let result: V | PromiseLike<V>;
  try {
    result = produce();
  } catch (error) {
    entry.settle();
    throw error;
  }
  if (isPromiseLike(result)) {
    return Promise.resolve(result).then(
      (value) => {
        if (skipsExecute(value)) entry.settle();
        return value;
      },
      (error: unknown) => {
        entry.settle();
        throw error;
      },
    );
  }
  if (skipsExecute(result)) entry.settle();
  return result;
}

function approvalSkipsExecute(decision: unknown): boolean {
  if (decision === undefined) return false;
  const status =
    typeof decision === 'object' && decision !== null && 'type' in decision
      ? Reflect.get(decision, 'type')
      : decision;
  return status !== 'approved' && status !== 'not-applicable';
}

const callLimitRefusal = (limit: number | undefined) =>
  new AgentToolError({
    code: 'STEP_TOOL_CALL_LIMIT',
    message: `Refused: a step may make at most ${limit} tool calls; make the rest in the next step`,
  });

/**
 * The run turn's tools and tool approval with the step's call bound and
 * dependency order applied. A call's result does not depend on whether it
 * waited for an earlier one: an `async *execute` still streams, and any other
 * `execute` ends in one result — an async iterable it returns, or that its
 * promise resolves to, is drained and its last value is the result. `execute`
 * runs with its tool as `this`.
 */
export function applyStepBarriers<TOOLS extends ToolSet, CONTEXT>(
  tools: TOOLS,
  toolApproval: ToolApprovalConfiguration<TOOLS, CONTEXT> | undefined,
  barriers: AgentStepBarriers | undefined,
): { tools: TOOLS; toolApproval: ToolApprovalConfiguration<TOOLS, CONTEXT> | undefined } {
  if (!barriers || (barriers.maxToolCallsPerStep === undefined && !barriers.toolDependencies))
    return { tools, toolApproval };
  const enter = createStepLedger(barriers);
  const limit = barriers.maxToolCallsPerStep;

  const executableTools = new Set<string>();
  const wrapped = mapObjectTypeBoundary<TOOLS, TOOLS>(tools, (name, tool) => {
    const toolName = String(name);
    const execute = tool.execute;
    if (typeof execute !== 'function') return tool;
    executableTools.add(toolName);
    const { onInputAvailable, needsApproval } = tool;
    type Options = Parameters<typeof execute>[1];
    const settled = (entry: CallEntry, result: unknown): unknown => {
      if (isAsyncIterable(result))
        return (async function* () {
          try {
            yield* result;
          } finally {
            entry.settle();
          }
        })();
      return Promise.resolve(result).then(finalOutput).finally(entry.settle);
    };
    return {
      ...tool,
      onInputAvailable: async (
        options: Parameters<NonNullable<typeof onInputAvailable>>[0],
      ) => {
        const entry = enter(options.messages, options.toolCallId, toolName, options.input);
        if (!onInputAvailable) return;
        try {
          await onInputAvailable.call(tool, options);
        } catch (error) {
          entry.settle();
          throw error;
        }
      },
      ...(needsApproval !== undefined && {
        needsApproval: (
          input: unknown,
          options: Parameters<Exclude<typeof needsApproval, boolean | undefined>>[1],
        ) => {
          const entry = enter(options.messages, options.toolCallId, toolName, input);
          if (entry.refused) return false;
          return settleOnDecision(
            entry,
            () =>
              typeof needsApproval === 'function'
                ? needsApproval.call(tool, input, options)
                : needsApproval,
            (value) => Boolean(value),
          );
        },
      }),
      execute: (input: unknown, options: Options) => {
        const entry = enter(options.messages, options.toolCallId, toolName, input);
        if (entry.refused) {
          entry.settle();
          throw callLimitRefusal(limit);
        }
        if (entry.ahead.length === 0) {
          try {
            return settled(entry, execute.call(tool, input, options));
          } catch (error) {
            entry.settle();
            throw error;
          }
        }
        const waitAhead = () => {
          const all = Promise.all(entry.ahead);
          return options.abortSignal ? raceAbort(all, options.abortSignal) : all;
        };
        const start = () => waitAhead().then(() => execute.call(tool, input, options));
        if (isAsyncGeneratorFunction(execute))
          return (async function* () {
            try {
              const result = await start();
              if (isAsyncIterable(result)) yield* result;
            } finally {
              entry.settle();
            }
          })();
        // Keep a Promise return shape so non-generator tools emit a single final
        // tool-result, while draining any AsyncIterable returned by a wrapper
        // before releasing the barrier.
        return Promise.resolve().then(start).then(finalOutput).finally(entry.settle);
      },
    };
  });
  carryDeferredToolCatalog(tools, wrapped);
  return { tools: wrapped, toolApproval: boundApproval(toolApproval, enter, executableTools) };
}

/** A call past the bound is refused on execution, so nobody is asked to approve it. */
function boundApproval<TOOLS extends ToolSet, CONTEXT>(
  approval: ToolApprovalConfiguration<TOOLS, CONTEXT> | undefined,
  enter: ReturnType<typeof createStepLedger>,
  executableTools: ReadonlySet<string>,
): ToolApprovalConfiguration<TOOLS, CONTEXT> | undefined {
  if (approval === undefined) return undefined;
  if (typeof approval === 'function')
    return (options) => {
      if (
        !executableTools.has(options.toolCall.toolName) ||
        options.toolCall.providerExecuted === true
      ) {
        return approval(options);
      }
      const entry = enter(
        options.messages,
        options.toolCall.toolCallId,
        options.toolCall.toolName,
        options.toolCall.input,
      );
      if (entry.refused) return 'not-applicable';
      return settleOnDecision(entry, () => approval(options), approvalSkipsExecute);
    };
  return mapObjectTypeBoundary<typeof approval, typeof approval>(approval, (name, decide) => {
    const toolName = String(name);
    if (!executableTools.has(toolName) || decide === undefined) return decide;
    return (input: unknown, options: { toolCallId: string; messages: unknown }) => {
      const entry = enter(options.messages, options.toolCallId, toolName, input);
      if (entry.refused) return 'not-applicable';
      // Reflect.apply: each entry decides for its own tool's input; this wrapper
      // only forwards what the SDK handed it.
      return settleOnDecision(
        entry,
        () =>
          typeof decide === 'function'
            ? Reflect.apply(decide, undefined, [input, options])
            : decide,
        approvalSkipsExecute,
      );
    };
  });
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
