import { z } from 'zod';
import { linkAbortSignals } from '../internal/abort-race';
import {
  AgentJsonObjectSchema,
  AgentProviderResponseSchema,
  type AgentRun,
  type AgentTerminalReason,
  type AgentUsage,
  AgentUsageSchema,
} from './schemas';
import { statedUsage, unknownUsage } from './schemas-usage-state';
import { AgentRuntimeConflictError } from './terminal-commit';

export { statedUsage, unknownUsage };

/**
 * Pure helpers shared by the runtime factory and the run executor.
 *
 * They live apart from both so neither has to import the other: the factory
 * wires dependencies, the executor runs one turn, and these belong to neither.
 */

export function findRun(runs: readonly AgentRun[], runId: string): AgentRun {
  const run = runs.find((candidate) => candidate.id === runId);
  if (!run) throw new AgentRuntimeConflictError('run lookup');
  return run;
}

export function jsonValue(value: unknown): z.infer<ReturnType<typeof z.json>> {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : { message: 'Non-JSON tool output omitted' };
}

export function providerEnvelope(value: unknown) {
  const parsed = AgentJsonObjectSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return { schemaVersion: 1, provider: 'ai-sdk', data: parsed.data };
}

/** Validate an untrusted optional `AgentUsage` object (used by `structuredCompaction`). */
export function parseOptionalAgentUsage(value: unknown): AgentUsage | undefined {
  if (value === undefined) return undefined;
  const parsed = AgentUsageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Keep only the provider facts that form the public response identity.
 *
 * The upstream provider name arrives already resolved, from the model's own
 * adapter. Reading it out of `providerMetadata` here would name one gateway's
 * key inside the neutral runtime — the boundary whose rule is that it carries
 * no vendor's model.
 */
export function providerResponseIdentity(
  id: string,
  provider: string | undefined,
  extra?: { readonly modelId?: string; readonly timestamp?: Date | string },
) {
  const timestamp =
    extra?.timestamp instanceof Date
      ? Number.isFinite(extra.timestamp.getTime())
        ? extra.timestamp.toISOString()
        : undefined
      : typeof extra?.timestamp === 'string' && extra.timestamp.length > 0
        ? extra.timestamp
        : undefined;
  return AgentProviderResponseSchema.parse({
    id,
    ...(typeof provider === 'string' && provider.length > 0 ? { provider } : {}),
    ...(typeof extra?.modelId === 'string' && extra.modelId.length > 0
      ? { modelId: extra.modelId }
      : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  });
}

export function abortTerminalReason(signal: AbortSignal): AgentTerminalReason {
  if (signal.reason === 'shutdown') return 'shutdown';
  if (signal.reason === 'timeout') return 'timeout';
  if (signal.reason === 'supersede') return 'superseded';
  return 'interrupted';
}

/**
 * What a run has spent so far, as the sum of the steps that reported.
 *
 * Assigning the latest step instead of adding it is what made an abandoned
 * multi-step run report its last step as though it were the whole run — and,
 * because an attempt-level token aggregate carries no cost, made even a
 * *successful* multi-step run report one step's money beside every step's tokens.
 *
 * Provenance is per field and answers only "how did we get this number".
 * A sum this code performed is `computed`, never `provider-reported`, however
 * provider-reported its parts were: a caller filtering on `provider-reported`
 * is asking for a figure it can bill against unchanged, and a sum is not that.
 * A field no step ever reported stays `unavailable` rather than becoming a
 * zero, because those are different facts — and a sum with an `unavailable`
 * component is a floor, so it does not get to claim otherwise either.
 */
export function addUsage(total: AgentUsage | undefined, step: AgentUsage): AgentUsage {
  // Past the `!total` guard below, every call here is an accumulation, so any
  // surviving value is one this code produced — including the case where only
  // one side reported. That branch used to return the reporting side untouched,
  // which made the label depend on step ORDER: an unreported step followed by a
  // reported one kept `provider-reported` on what was really a floor, while the
  // same two steps the other way round said `computed`. A caller filtering on
  // `provider-reported` to decide what to bill against would have billed it.
  const sum = (
    left: AgentUsage['inputTokens'] | undefined,
    right: AgentUsage['inputTokens'] | undefined,
  ): AgentUsage['inputTokens'] => {
    if (left?.value === undefined && right?.value === undefined) {
      return { provenance: 'unavailable' };
    }
    if (left?.value === undefined) return { ...right, provenance: 'computed' };
    if (right?.value === undefined) return { ...left, provenance: 'computed' };
    return { value: left.value + right.value, provenance: 'computed' };
  };
  // Money is all-or-nothing, and tokens are not. A token floor labelled
  // `computed` is a useful diagnostic; a *cost* floor is a number someone bills
  // against, and one step that did not report its cost makes the run's cost
  // unknown — not smaller. Saying `unavailable` is the only honest answer, and
  // it has the property the alternative lacked: it stays unknown. A floor kept
  // no memory of having been poisoned, so `USD 1 → EUR 2 → USD 4` recovered
  // into a confident `4` for a run that really cost $5 and €2.
  const sumCost = (
    left: AgentUsage['cost'],
    right: AgentUsage['cost'],
  ): AgentUsage['cost'] => {
    if (left?.value === undefined || right?.value === undefined) {
      return { provenance: 'unavailable' };
    }
    // Two currencies cannot be added, and the core does not convert one into
    // another (→ ADR 0002). Keeping the first and dropping the second would
    // report a number that is quietly not the total, so it reports neither.
    // An unlabelled cost is the same case: it is not *provably* the same
    // currency, and guessing that it is would be a conversion by omission.
    if (left.currency !== right.currency) return { provenance: 'unavailable' };
    return {
      value: left.value + right.value,
      ...(left.currency && { currency: left.currency }),
      provenance: 'computed',
    };
  };
  if (!total) return step;
  const cost = sumCost(total.cost, step.cost);
  return {
    inputTokens: sum(total.inputTokens, step.inputTokens),
    outputTokens: sum(total.outputTokens, step.outputTokens),
    reasoningTokens: sum(total.reasoningTokens, step.reasoningTokens),
    cacheReadTokens: sum(total.cacheReadTokens, step.cacheReadTokens),
    cacheWriteTokens: sum(total.cacheWriteTokens, step.cacheWriteTokens),
    ...(cost && { cost }),
  };
}

/**
 * Merge the loop's attempt-level token total with the per-step accumulated usage.
 *
 * `attemptTotal` covers the token fields summed across completed steps in one attempt,
 * while `accumulated` preserves per-step cost and `unavailable` provenance so terminal
 * totals never contradict `step-finished` events or synthesize `0` for fields no step
 * reported.
 *
 * The provenance label is always `computed` because the figure is summed across steps
 * rather than reported as a single billable provider receipt, keeping success and abort
 * paths consistent.
 */
export function mergeModelTotals(
  attemptTotal: AgentUsage,
  accumulated: AgentUsage | undefined,
): AgentUsage {
  const pick = (
    total: AgentUsage['inputTokens'] | undefined,
    ours: AgentUsage['inputTokens'] | undefined,
  ): AgentUsage['inputTokens'] => {
    if (ours?.provenance === 'unavailable') return ours;
    return total?.value !== undefined
      ? { value: total.value, provenance: 'computed' }
      : (ours ?? { provenance: 'unavailable' });
  };
  return {
    inputTokens: pick(attemptTotal.inputTokens, accumulated?.inputTokens),
    outputTokens: pick(attemptTotal.outputTokens, accumulated?.outputTokens),
    reasoningTokens: pick(attemptTotal.reasoningTokens, accumulated?.reasoningTokens),
    cacheReadTokens: pick(attemptTotal.cacheReadTokens, accumulated?.cacheReadTokens),
    cacheWriteTokens: pick(attemptTotal.cacheWriteTokens, accumulated?.cacheWriteTokens),
    cost: accumulated?.cost ?? { provenance: 'unavailable' },
  };
}

/** Provider-reported token counts normalized with provenance (used by drivers and adapters). */
export function normalizeTokenUsage(value: {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}): AgentUsage {
  const reported = (tokens: number | undefined): AgentUsage['inputTokens'] =>
    tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0
      ? { provenance: 'unavailable' }
      : { value: tokens, provenance: 'provider-reported' };
  return {
    inputTokens: reported(value.inputTokens),
    outputTokens: reported(value.outputTokens),
    reasoningTokens: reported(value.reasoningTokens),
    cacheReadTokens: reported(value.cacheReadTokens),
    cacheWriteTokens: reported(value.cacheWriteTokens),
  };
}

/**
 * The run's signal plus optional idle timer and wall-clock run deadline (`maxDurationMs`).
 * `dispose` disarms every timer once the run stops working; `release` detaches from the
 * parent signal once its terminal is committed — until then a late cancellation still reads.
 */
export function createIdleDeadline(
  parent: AbortSignal,
  timeoutMs: number | undefined,
  maxDurationMs?: number | undefined,
) {
  if (timeoutMs === undefined && maxDurationMs === undefined) {
    const noop = (): void => undefined;
    return {
      signal: parent,
      touch: noop,
      start: noop,
      stop: noop,
      suspend: noop,
      resume: noop,
      dispose: noop,
      release: noop,
    };
  }
  const controller = new AbortController();
  const link = linkAbortSignals(parent, controller.signal);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let suspended = 0;
  if (maxDurationMs !== undefined) {
    durationTimer = setTimeout(() => controller.abort('timeout'), maxDurationMs);
  }
  const clearIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const clearDuration = (): void => {
    if (durationTimer !== undefined) clearTimeout(durationTimer);
    durationTimer = undefined;
  };
  const touch = (): void => {
    clearIdle();
    if (timeoutMs === undefined || !active || suspended > 0 || controller.signal.aborted) {
      return;
    }
    idleTimer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  };
  return {
    signal: link.signal,
    touch,
    start() {
      active = true;
      touch();
    },
    stop() {
      active = false;
      clearIdle();
    },
    suspend() {
      suspended += 1;
      clearIdle();
    },
    resume() {
      suspended = Math.max(0, suspended - 1);
      touch();
    },
    dispose() {
      active = false;
      clearIdle();
      clearDuration();
    },
    release() {
      clearIdle();
      clearDuration();
      link.release();
    },
  };
}
