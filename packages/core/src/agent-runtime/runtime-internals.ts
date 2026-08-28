import type { LanguageModelUsage } from 'ai';
import { z } from 'zod';
import {
  AgentJsonObjectSchema,
  type AgentMessagePart,
  AgentMessagePartSchema,
  type AgentRun,
  type AgentTerminalReason,
  type AgentUsage,
} from './schemas';
import { AgentRuntimeConflictError } from './terminal-commit';

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

export function appendText(parts: AgentMessagePart[], text: string): void {
  const previous = parts.at(-1);
  if (previous?.type === 'text') {
    const next = AgentMessagePartSchema.parse({ ...previous, text: previous.text + text });
    parts.splice(parts.length - 1, 1, next);
    return;
  }
  parts.push(AgentMessagePartSchema.parse({ type: 'text', text }));
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
 * because the SDK's own aggregate carries no cost, made even a *successful*
 * multi-step run report one step's money beside every step's tokens.
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
 * The SDK's own model-step total where it has one, our per-step sum where it does not.
 *
 * `totalUsage` is the SDK's sum over the steps it saw, and it covers only the
 * five token fields it knows about — a `normalizeUsage` hook that reads
 * reasoning or cache counts out of provider metadata has nowhere to put them in
 * it. Overwriting wholesale therefore made a terminal event contradict its own
 * `step-finished` events, and made the same run report those fields on an
 * aborted path and lose them on a successful one.
 *
 * The label is `computed` either way, and deliberately so: `totalUsage` is a sum
 * the AI SDK performed over per-step provider figures, not a total any provider
 * handed us. Which loop did the adding is not a difference a caller filtering
 * for a billable figure cares about, and pretending otherwise made one run
 * report `provider-reported` on success and `computed` on abort.
 */
export function mergeModelTotals(
  sdkTotal: AgentUsage,
  accumulated: AgentUsage | undefined,
): AgentUsage {
  const pick = (
    total: AgentUsage['inputTokens'] | undefined,
    ours: AgentUsage['inputTokens'] | undefined,
  ): AgentUsage['inputTokens'] =>
    total?.value !== undefined
      ? { value: total.value, provenance: 'computed' }
      : (ours ?? { provenance: 'unavailable' });
  return {
    inputTokens: pick(sdkTotal.inputTokens, accumulated?.inputTokens),
    outputTokens: pick(sdkTotal.outputTokens, accumulated?.outputTokens),
    reasoningTokens: pick(sdkTotal.reasoningTokens, accumulated?.reasoningTokens),
    cacheReadTokens: pick(sdkTotal.cacheReadTokens, accumulated?.cacheReadTokens),
    cacheWriteTokens: pick(sdkTotal.cacheWriteTokens, accumulated?.cacheWriteTokens),
    // Never from the SDK: `totalUsage` carries no cost at all.
    cost: accumulated?.cost ?? { provenance: 'unavailable' },
  };
}

/**
 * Every field present, so a reader never has to tell an absent key from a
 * reported zero.
 *
 * Without this a single-step run under a provider with no `normalizeUsage` hook
 * had no `cost` key at all, while the same run with two steps had
 * `cost: { provenance: 'unavailable' }` — the absent-versus-unknown ambiguity
 * this whole change exists to remove, surviving at field level and varying with
 * the step count.
 */
export function statedUsage(usage: AgentUsage | undefined): AgentUsage {
  const stated = (value: AgentUsage['inputTokens'] | undefined): AgentUsage['inputTokens'] =>
    value ?? { provenance: 'unavailable' };
  if (!usage) return unknownUsage();
  return {
    inputTokens: stated(usage.inputTokens),
    outputTokens: stated(usage.outputTokens),
    reasoningTokens: stated(usage.reasoningTokens),
    cacheReadTokens: stated(usage.cacheReadTokens),
    cacheWriteTokens: stated(usage.cacheWriteTokens),
    cost: stated(usage.cost),
  };
}

/** Every field `unavailable` — a run that reported nothing, said out loud. */
export function unknownUsage(): AgentUsage {
  const nothing = { provenance: 'unavailable' } as const;
  return {
    inputTokens: nothing,
    outputTokens: nothing,
    reasoningTokens: nothing,
    cacheReadTokens: nothing,
    cacheWriteTokens: nothing,
    cost: nothing,
  };
}

export function normalizeSdkUsage(value: LanguageModelUsage): AgentUsage {
  // A fractional or negative figure is not a token count, and this is the one
  // place a provider's number enters the runtime. Refusing it *here* means
  // `unavailable` — an honest "we do not know" — rather than a `ZodError`
  // thrown out of the terminal commit, which would fail a run that had already
  // produced its answer over a number nobody reads until the invoice arrives.
  // The schema refuses the same value, so a driver or a consumer that
  // fabricates one still fails loudly; only the provider path degrades.
  const reported = (tokens: number | undefined): AgentUsage['inputTokens'] =>
    tokens === undefined || !Number.isSafeInteger(tokens) || tokens < 0
      ? { provenance: 'unavailable' }
      : { value: tokens, provenance: 'provider-reported' };
  return {
    inputTokens: reported(value.inputTokens),
    outputTokens: reported(value.outputTokens),
    reasoningTokens: reported(value.outputTokenDetails.reasoningTokens),
    cacheReadTokens: reported(value.inputTokenDetails.cacheReadTokens),
    cacheWriteTokens: reported(value.inputTokenDetails.cacheWriteTokens),
  };
}

export function createIdleDeadline(parent: AbortSignal, timeoutMs: number | undefined) {
  if (timeoutMs === undefined) {
    const noop = (): void => undefined;
    return { signal: parent, touch: noop, dispose: noop };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
  };
  touch();
  return {
    signal: AbortSignal.any([parent, controller.signal]),
    touch,
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
