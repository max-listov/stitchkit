import { z } from 'zod';
import {
  type ExecutorDelta,
  type ExecutorModelUsage,
  ExecutorModelUsageSchema,
} from '../vocabulary';

const MAX_MODEL_USAGE_ENTRIES = 64;

/** Input and output token pair computed for non-primary (subagent/compaction) work. */
export const ClaudeSdkTokenPairSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
});

/** Inferred from {@link ClaudeSdkTokenPairSchema}. */
export type ClaudeSdkTokenPair = z.infer<typeof ClaudeSdkTokenPairSchema>;

/**
 * Per-turn usage summary derived from one Claude SDK `result` record while preserving the
 * cumulative process-wide `modelUsage` ledger.
 */
export const ClaudeSdkTurnUsageSchema = z.strictObject({
  turnId: z.string().min(1),
  /** Primary (root) model observed on the turn's assistant messages or query `system/init`. */
  primaryModel: z.string().min(1).max(256).optional(),
  /**
   * Additive per-turn delta of `result.modelUsage` since the previous turn on the same query
   * process. `undefined` when no valid baseline exists or any counter moved backwards.
   */
  modelUsageDelta: z
    .record(z.string().min(1).max(256), ExecutorModelUsageSchema)
    .refine(
      (entries) => Object.keys(entries).length <= MAX_MODEL_USAGE_ENTRIES,
      `modelUsageDelta must carry at most ${MAX_MODEL_USAGE_ENTRIES} models`,
    )
    .optional(),
  /**
   * Non-primary token usage (such as subagents and compaction) calculated as
   * `(ledgerDelta - mainAgentUsage)` when both are known and non-negative; `undefined` otherwise.
   */
  otherUsage: ClaudeSdkTokenPairSchema.optional(),
  /** Cumulative process-wide `modelUsage` exactly as emitted on `ExecutorUsageDelta.modelUsage`. */
  cumulativeModelUsage: z
    .record(z.string().min(1).max(256), ExecutorModelUsageSchema)
    .refine(
      (entries) => Object.keys(entries).length <= MAX_MODEL_USAGE_ENTRIES,
      `cumulativeModelUsage must carry at most ${MAX_MODEL_USAGE_ENTRIES} models`,
    )
    .optional(),
});

/** Inferred from {@link ClaudeSdkTurnUsageSchema}. */
export type ClaudeSdkTurnUsage = z.infer<typeof ClaudeSdkTurnUsageSchema>;

type UsageDelta = Extract<ExecutorDelta, { type: 'usage' }>;

interface CounterDiff {
  readonly ok: boolean;
  readonly value: number | undefined;
}

function diffOptionalCounter(
  before: number | undefined,
  after: number | undefined,
  isNewModel: boolean,
): CounterDiff {
  if (isNewModel) return { ok: true, value: after };
  if (before === undefined) {
    // Missing baseline for a newly populated counter on an existing model: emit undefined (I13).
    return { ok: true, value: undefined };
  }
  if (after === undefined || after < before) return { ok: false, value: undefined };
  return { ok: true, value: after - before };
}

function diffModelRow(
  before: ExecutorModelUsage | undefined,
  after: ExecutorModelUsage,
): { readonly row: ExecutorModelUsage; readonly ledgerInput: number | undefined } | undefined {
  const isNewModel = before === undefined;
  const baseInput = isNewModel ? 0 : before.inputTokens;
  const baseOutput = isNewModel ? 0 : before.outputTokens;
  if (after.inputTokens < baseInput || after.outputTokens < baseOutput) return undefined;

  const cacheRead = diffOptionalCounter(
    before?.cacheReadInputTokens,
    after.cacheReadInputTokens,
    isNewModel,
  );
  const cacheCreate = diffOptionalCounter(
    before?.cacheCreationInputTokens,
    after.cacheCreationInputTokens,
    isNewModel,
  );
  const thinking = diffOptionalCounter(
    before?.thinkingTokens,
    after.thinkingTokens,
    isNewModel,
  );
  const cache5m = diffOptionalCounter(
    before?.cacheCreationEphemeral5mInputTokens,
    after.cacheCreationEphemeral5mInputTokens,
    isNewModel,
  );
  const cache1h = diffOptionalCounter(
    before?.cacheCreationEphemeral1hInputTokens,
    after.cacheCreationEphemeral1hInputTokens,
    isNewModel,
  );
  const webSearch = diffOptionalCounter(
    before?.webSearchRequests,
    after.webSearchRequests,
    isNewModel,
  );
  const cost = diffOptionalCounter(before?.costUsd, after.costUsd, isNewModel);

  if (
    !cacheRead.ok ||
    !cacheCreate.ok ||
    !thinking.ok ||
    !cache5m.ok ||
    !cache1h.ok ||
    !webSearch.ok ||
    !cost.ok
  ) {
    return undefined;
  }

  const inputDelta = after.inputTokens - baseInput;
  const outputDelta = after.outputTokens - baseOutput;
  const missingCacheBaseline =
    (!isNewModel &&
      before.cacheReadInputTokens === undefined &&
      after.cacheReadInputTokens !== undefined) ||
    (!isNewModel &&
      before.cacheCreationInputTokens === undefined &&
      after.cacheCreationInputTokens !== undefined);
  const ledgerInput = missingCacheBaseline
    ? undefined
    : inputDelta + (cacheRead.value ?? 0) + (cacheCreate.value ?? 0);

  return {
    ledgerInput,
    row: {
      inputTokens: inputDelta,
      outputTokens: outputDelta,
      ...(cacheRead.value !== undefined && { cacheReadInputTokens: cacheRead.value }),
      ...(cacheCreate.value !== undefined && { cacheCreationInputTokens: cacheCreate.value }),
      ...(thinking.value !== undefined && { thinkingTokens: thinking.value }),
      ...(cache5m.value !== undefined && {
        cacheCreationEphemeral5mInputTokens: cache5m.value,
      }),
      ...(cache1h.value !== undefined && {
        cacheCreationEphemeral1hInputTokens: cache1h.value,
      }),
      ...(webSearch.value !== undefined && { webSearchRequests: webSearch.value }),
      ...(cost.value !== undefined && { costUsd: cost.value }),
      ...(after.contextWindow !== undefined && { contextWindow: after.contextWindow }),
      ...(after.maxOutputTokens !== undefined && { maxOutputTokens: after.maxOutputTokens }),
      ...(after.canonicalModel !== undefined && { canonicalModel: after.canonicalModel }),
      ...(after.provider !== undefined && { provider: after.provider }),
      ...(after.costBasis !== undefined && { costBasis: after.costBasis }),
    },
  };
}

function computeDeltaMap(
  baseline: ReadonlyMap<string, ExecutorModelUsage>,
  current: Readonly<Record<string, ExecutorModelUsage>>,
):
  | {
      readonly modelUsageDelta: Record<string, ExecutorModelUsage>;
      readonly ledgerTotals: ClaudeSdkTokenPair | undefined;
    }
  | undefined {
  for (const model of baseline.keys()) {
    if (!Object.hasOwn(current, model)) return undefined;
  }
  const deltaEntries = new Map<string, ExecutorModelUsage>();
  let totalLedgerInput = 0;
  let totalLedgerOutput = 0;
  let hasCompleteLedgerInput = true;
  for (const [model, after] of Object.entries(current)) {
    const diff = diffModelRow(baseline.get(model), after);
    if (diff === undefined) return undefined;
    deltaEntries.set(model, diff.row);
    if (diff.ledgerInput === undefined) hasCompleteLedgerInput = false;
    else totalLedgerInput += diff.ledgerInput;
    totalLedgerOutput += diff.row.outputTokens;
  }
  return {
    modelUsageDelta: Object.fromEntries(deltaEntries),
    ledgerTotals: hasCompleteLedgerInput
      ? { inputTokens: totalLedgerInput, outputTokens: totalLedgerOutput }
      : undefined,
  };
}

function computeOtherUsage(
  ledgerTotals: ClaudeSdkTokenPair | undefined,
  usageDelta: UsageDelta | undefined,
): ClaudeSdkTokenPair | undefined {
  if (ledgerTotals === undefined || usageDelta === undefined) return undefined;
  if (usageDelta.inputTokens === undefined || usageDelta.outputTokens === undefined) {
    return undefined;
  }
  const mainInput =
    usageDelta.inputTokens +
    (usageDelta.cachedInputTokens ?? 0) +
    (usageDelta.cacheCreationInputTokens ?? 0);
  const mainOutput = usageDelta.outputTokens;
  if (ledgerTotals.inputTokens < mainInput || ledgerTotals.outputTokens < mainOutput) {
    return undefined;
  }
  return {
    inputTokens: ledgerTotals.inputTokens - mainInput,
    outputTokens: ledgerTotals.outputTokens - mainOutput,
  };
}

/**
 * Per-query cumulative `modelUsage` baseline tracker. Instantiate one per spawned Claude SDK
 * `Query` handle so restarting the process resets the baseline to zero automatically.
 */
export interface ClaudeSdkTurnUsageTracker {
  recordTurn(input: {
    readonly turnId: string;
    readonly primaryModel?: string;
    readonly usageDelta?: UsageDelta;
  }): ClaudeSdkTurnUsage;
}

/** Create a fresh per-query usage tracker anchored at an empty (zero) process ledger. */
export function createClaudeSdkTurnUsageTracker(): ClaudeSdkTurnUsageTracker {
  // A freshly spawned Claude CLI process starts its in-memory modelUsage ledger at zero.
  let baseline: Map<string, ExecutorModelUsage> | undefined = new Map();

  return {
    recordTurn({ turnId, primaryModel, usageDelta }) {
      const cumulative = usageDelta?.modelUsage;
      if (cumulative === undefined || Object.keys(cumulative).length === 0) {
        // Without a reported ledger on this result, future turns cannot assume zero growth here.
        baseline = undefined;
        return {
          turnId,
          ...(primaryModel !== undefined && { primaryModel }),
        };
      }
      const nextSnapshot = new Map(Object.entries(cumulative));
      if (baseline === undefined) {
        // Re-anchor baseline for subsequent turns, but emit undefined delta for this turn (I13).
        baseline = nextSnapshot;
        return {
          turnId,
          ...(primaryModel !== undefined && { primaryModel }),
          cumulativeModelUsage: cumulative,
        };
      }
      const computed = computeDeltaMap(baseline, cumulative);
      if (computed === undefined) {
        // A counter went backwards or disappeared: invalidate baseline and report undefined (I13).
        baseline = undefined;
        return {
          turnId,
          ...(primaryModel !== undefined && { primaryModel }),
          cumulativeModelUsage: cumulative,
        };
      }
      baseline = nextSnapshot;
      const otherUsage = computeOtherUsage(computed.ledgerTotals, usageDelta);
      return {
        turnId,
        ...(primaryModel !== undefined && { primaryModel }),
        modelUsageDelta: computed.modelUsageDelta,
        ...(otherUsage !== undefined && { otherUsage }),
        cumulativeModelUsage: cumulative,
      };
    },
  };
}
