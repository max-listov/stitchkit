import type { ZodType, z } from 'zod';
import { abortReason } from '../internal/abort-race';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { isRecord } from '../internal/typed';
import type { AgentToolSet } from '../tools/agent-tools';
import type { AgentModelDescriptor } from './models';
import { addUsage, parseOptionalAgentUsage } from './runtime-internals';
import type { AgentMessage, AgentSnapshot, AgentUsage } from './schemas';
import type { AgentRuntimeStore, AgentStoreMutationResult } from './store';
import {
  type AgentHistoryEvidencePolicy,
  isCompleteAgentHistoryTurn,
} from './terminal-status';

export interface AgentCompactionContext<SUMMARY> {
  conversationId: string;
  snapshot: AgentSnapshot;
  eligibleMessages: readonly AgentMessage[];
  previousSummary?: SUMMARY;
  signal: AbortSignal;
  /** Resolved model descriptor for the run, when invoked from `createAgentRuntime` or passed by caller. */
  model?: AgentModelDescriptor;
  /** Mounted tools for the run, when invoked from `createAgentRuntime` or passed by caller. */
  tools?: AgentToolSet;
  /** Caller or runtime context, when invoked from `createAgentRuntime` or passed by caller. */
  context?: unknown;
}

/** Return value accepted from `StructuredCompactionConfig.summarize`. */
export type AgentCompactionSummaryOutput<SUMMARY> =
  | SUMMARY
  | { readonly summary: SUMMARY; readonly usage?: AgentUsage };

export interface StructuredCompactionConfig<SUMMARY_SCHEMA extends ZodType> {
  schema: SUMMARY_SCHEMA;
  keepRecentTurns: number;
  evidencePolicy?: AgentHistoryEvidencePolicy;
  /** Total summarize/CAS attempts. A conflict always recomputes from a fresh snapshot. */
  maxAttempts?: number;
  threshold(
    input: AgentSnapshot,
    context?: {
      readonly model?: AgentModelDescriptor;
      readonly tools?: AgentToolSet;
      readonly context?: unknown;
    },
  ): boolean | Promise<boolean>;
  summarize(
    context: AgentCompactionContext<z.infer<SUMMARY_SCHEMA>>,
  ):
    | AgentCompactionSummaryOutput<z.infer<SUMMARY_SCHEMA>>
    | Promise<AgentCompactionSummaryOutput<z.infer<SUMMARY_SCHEMA>>>;
  createSummaryMessage(input: {
    conversationId: string;
    summary: z.infer<SUMMARY_SCHEMA>;
    compactedMessages: readonly AgentMessage[];
  }): AgentMessage;
  readPreviousSummary?(message: AgentMessage): z.infer<SUMMARY_SCHEMA>;
}

export interface AgentCompactionResult {
  outcome: 'not_needed' | 'nothing_eligible' | 'applied' | 'conflict' | 'not_found';
  snapshot: AgentSnapshot;
  attempts: number;
  /**
   * What summarising cost, if the implementation reported it.
   *
   * Compaction runs inside the turn and calls a model, so its spend is the
   * run's spend — but it produces no step and no event of its own. `maxAttempts`
   * can pay for it more than once on a CAS conflict; `structuredCompaction`
   * accumulates `usage` across attempts when `summarize` returns
   * `{ summary, usage }`.
   */
  usage?: AgentUsage;
}

interface MessageTurn {
  messages: AgentMessage[];
  complete: boolean;
}

function groupProviderTurns(
  messages: readonly AgentMessage[],
  evidencePolicy: AgentHistoryEvidencePolicy | undefined,
): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let current: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) {
      turns.push({
        messages: current,
        complete: isCompleteAgentHistoryTurn(current, evidencePolicy),
      });
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    turns.push({
      messages: current,
      complete: isCompleteAgentHistoryTurn(current, evidencePolicy),
    });
  }
  return turns;
}

export interface SelectCompactableHistoryOptions {
  messages: readonly AgentMessage[];
  /** Whole turns kept out of reach of compaction, counted from the newest. */
  keepRecentTurns: number;
  evidencePolicy?: AgentHistoryEvidencePolicy;
}

export interface CompactableHistory {
  /**
   * The summary already at the head of this history, when there is one.
   *
   * A second compaction replaces it rather than stacking another summary on
   * top; a caller that appends instead grows a chain of summaries of summaries.
   */
  leadingSummary?: AgentMessage;
  /** The oldest whole complete turns, safe to replace with a summary. */
  compactable: readonly AgentMessage[];
  /** Everything the model must still hear verbatim, in order. */
  retained: readonly AgentMessage[];
}

/**
 * Which of a conversation's records may be summarised away, without the store.
 *
 * This is the half of compaction that is arithmetic over a message list: it
 * needs no snapshot version, no CAS and no runtime, so it is reachable by an
 * application that drives the model itself (→ ADR 0142). `structuredCompaction`
 * is the other half — it exists to write the result back under a version check,
 * and it calls this function rather than repeating it.
 *
 * The rule it enforces is the one a hand-written compactor gets wrong: a turn
 * is cut whole or not at all, and only after it is *complete*. A turn holding a
 * tool call whose result never arrived is not evidence of anything and is never
 * eligible — summarising it away hides an unfinished exchange, and keeping half
 * of it hands the provider a call with no result, which most of them refuse.
 */
export function selectCompactableHistory(
  options: SelectCompactableHistoryOptions,
): CompactableHistory {
  if (!Number.isSafeInteger(options.keepRecentTurns) || options.keepRecentTurns < 0) {
    throw new TypeError('keepRecentTurns must be a non-negative safe integer');
  }
  const leadingSummary =
    options.messages[0]?.role === 'summary' ? options.messages[0] : undefined;
  const rest = leadingSummary ? options.messages.slice(1) : options.messages;
  const turns = groupProviderTurns(rest, options.evidencePolicy);
  const firstIncomplete = turns.findIndex((turn) => !turn.complete);
  const completeTurns = firstIncomplete === -1 ? turns : turns.slice(0, firstIncomplete);
  const eligibleCount = Math.max(0, completeTurns.length - options.keepRecentTurns);
  const compactable = completeTurns.slice(0, eligibleCount).flatMap((turn) => turn.messages);
  return {
    ...(leadingSummary !== undefined && { leadingSummary }),
    compactable,
    retained: rest.slice(compactable.length),
  };
}

function mutationSnapshot(
  result: AgentStoreMutationResult,
  fallback: AgentSnapshot,
  attempts: number,
  usage: AgentUsage | undefined,
): AgentCompactionResult {
  if (result.outcome === 'applied' || result.outcome === 'duplicate') {
    return {
      outcome: 'applied',
      snapshot: result.snapshot,
      attempts,
      ...(usage !== undefined && { usage }),
    };
  }
  return {
    outcome: result.outcome,
    snapshot: fallback,
    attempts,
    ...(usage !== undefined && { usage }),
  };
}

function unpackSummaryOutput<SUMMARY_SCHEMA extends ZodType>(
  schema: SUMMARY_SCHEMA,
  raw: unknown,
): { summary: z.infer<SUMMARY_SCHEMA>; usage?: AgentUsage } {
  if (isRecord(raw) && Object.hasOwn(raw, 'summary')) {
    const keys = Object.keys(raw);
    const onlyEnvelopeKeys = keys.every((key) => key === 'summary' || key === 'usage');
    if (onlyEnvelopeKeys) {
      const hasUsage = Object.hasOwn(raw, 'usage') && raw.usage !== undefined;
      const parsedUsage = parseOptionalAgentUsage(raw.usage);
      if (hasUsage && parsedUsage !== undefined) {
        return { summary: schema.parse(raw.summary), usage: parsedUsage };
      }
      const direct = schema.safeParse(raw);
      if (direct.success) return { summary: direct.data };
      if (hasUsage && parsedUsage === undefined) {
        throw new TypeError('Compaction summarize usage must be a valid AgentUsage');
      }
      return { summary: schema.parse(raw.summary) };
    }
  }
  return { summary: schema.parse(raw) };
}

export function structuredCompaction<SUMMARY_SCHEMA extends ZodType>(
  config: StructuredCompactionConfig<SUMMARY_SCHEMA>,
) {
  assertPositiveSafeInteger('keepRecentTurns', config.keepRecentTurns);
  const maxAttempts = config.maxAttempts ?? 1;
  assertPositiveSafeInteger('maxAttempts', maxAttempts);

  return async (input: {
    conversationId: string;
    store: AgentRuntimeStore;
    signal: AbortSignal;
    previousSummary?: z.infer<SUMMARY_SCHEMA>;
    model?: AgentModelDescriptor;
    tools?: AgentToolSet;
    context?: unknown;
  }): Promise<AgentCompactionResult> => {
    let lastSnapshot = await input.store.loadSnapshot(input.conversationId);
    let accumulatedUsage: AgentUsage | undefined;
    const thresholdContext =
      input.model !== undefined || input.tools !== undefined || input.context !== undefined
        ? {
            ...(input.model !== undefined && { model: input.model }),
            ...(input.tools !== undefined && { tools: input.tools }),
            ...(input.context !== undefined && { context: input.context }),
          }
        : undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const snapshot =
        attempt === 1 ? lastSnapshot : await input.store.loadSnapshot(input.conversationId);
      lastSnapshot = snapshot;
      if (!(await config.threshold(snapshot, thresholdContext))) {
        return {
          outcome: 'not_needed',
          snapshot,
          attempts: attempt,
          ...(accumulatedUsage !== undefined && { usage: accumulatedUsage }),
        };
      }
      const { leadingSummary, compactable: eligibleMessages } = selectCompactableHistory({
        messages: snapshot.messages,
        keepRecentTurns: config.keepRecentTurns,
        ...(config.evidencePolicy !== undefined && { evidencePolicy: config.evidencePolicy }),
      });
      if (eligibleMessages.length === 0) {
        return {
          outcome: 'nothing_eligible',
          snapshot,
          attempts: attempt,
          ...(accumulatedUsage !== undefined && { usage: accumulatedUsage }),
        };
      }

      const previousSummary =
        leadingSummary && config.readPreviousSummary
          ? config.schema.parse(config.readPreviousSummary(leadingSummary))
          : attempt === 1
            ? input.previousSummary
            : undefined;

      const rawSummary = await config.summarize({
        conversationId: input.conversationId,
        snapshot,
        eligibleMessages,
        ...(previousSummary !== undefined && { previousSummary }),
        signal: input.signal,
        ...(input.model !== undefined && { model: input.model }),
        ...(input.tools !== undefined && { tools: input.tools }),
        ...(input.context !== undefined && { context: input.context }),
      });
      const { summary, usage } = unpackSummaryOutput(config.schema, rawSummary);
      if (usage !== undefined) {
        accumulatedUsage = accumulatedUsage ? addUsage(accumulatedUsage, usage) : usage;
      }
      if (input.signal.aborted) throw abortReason(input.signal);
      const summaryMessage = config.createSummaryMessage({
        conversationId: input.conversationId,
        summary,
        compactedMessages: eligibleMessages,
      });
      if (summaryMessage.role !== 'summary' || summaryMessage.status !== 'committed') {
        throw new TypeError('Compaction summary must be one committed summary message');
      }
      const applied = await input.store.replaceCompactedRange({
        conversationId: input.conversationId,
        expectedVersion: snapshot.version,
        replacedMessageIds: [
          ...(leadingSummary ? [leadingSummary.id] : []),
          ...eligibleMessages.map((message) => message.id),
        ],
        summary: summaryMessage,
      });
      if (applied.outcome !== 'conflict' || attempt === maxAttempts) {
        return mutationSnapshot(applied, snapshot, attempt, accumulatedUsage);
      }
    }
    return {
      outcome: 'conflict',
      snapshot: lastSnapshot,
      attempts: maxAttempts,
      ...(accumulatedUsage !== undefined && { usage: accumulatedUsage }),
    };
  };
}
