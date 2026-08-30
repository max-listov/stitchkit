import type { ZodType, z } from 'zod';
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
}

export interface StructuredCompactionConfig<SUMMARY_SCHEMA extends ZodType> {
  schema: SUMMARY_SCHEMA;
  keepRecentTurns: number;
  evidencePolicy?: AgentHistoryEvidencePolicy;
  /** Total summarize/CAS attempts. A conflict always recomputes from a fresh snapshot. */
  maxAttempts?: number;
  threshold(input: AgentSnapshot): boolean | Promise<boolean>;
  summarize(
    context: AgentCompactionContext<z.infer<SUMMARY_SCHEMA>>,
  ): z.infer<SUMMARY_SCHEMA> | Promise<z.infer<SUMMARY_SCHEMA>>;
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
   * What summarising cost, if the implementation counted it.
   *
   * Compaction runs inside the turn and calls a model, so its spend is the
   * run's spend — but it produces no step and no event of its own, so without
   * this it was invisible. `maxAttempts` can pay for it more than once on a CAS
   * conflict; report the total, not the last attempt.
   *
   * `structuredCompaction` cannot fill this in for you: it hands `summarize` a
   * context and takes a summary back, and what the summariser spent getting
   * there is known only inside it. Return it from your own wrapper.
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

function eligibleForCompaction(
  messages: readonly AgentMessage[],
  keepRecentTurns: number,
  evidencePolicy: AgentHistoryEvidencePolicy | undefined,
): AgentMessage[] {
  const withoutLeadingSummary = messages[0]?.role === 'summary' ? messages.slice(1) : messages;
  const turns = groupProviderTurns(withoutLeadingSummary, evidencePolicy);
  const firstIncomplete = turns.findIndex((turn) => !turn.complete);
  const completeTurns = firstIncomplete === -1 ? turns : turns.slice(0, firstIncomplete);
  const eligibleCount = Math.max(0, completeTurns.length - keepRecentTurns);
  return completeTurns.slice(0, eligibleCount).flatMap((turn) => turn.messages);
}

function mutationSnapshot(
  result: AgentStoreMutationResult,
  fallback: AgentSnapshot,
  attempts: number,
): AgentCompactionResult {
  if (result.outcome === 'applied' || result.outcome === 'duplicate') {
    return { outcome: 'applied', snapshot: result.snapshot, attempts };
  }
  return { outcome: result.outcome, snapshot: fallback, attempts };
}

export function structuredCompaction<SUMMARY_SCHEMA extends ZodType>(
  config: StructuredCompactionConfig<SUMMARY_SCHEMA>,
) {
  if (!Number.isSafeInteger(config.keepRecentTurns) || config.keepRecentTurns < 1) {
    throw new TypeError('keepRecentTurns must be a positive safe integer');
  }
  const maxAttempts = config.maxAttempts ?? 1;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('maxAttempts must be a positive safe integer');
  }

  return async (input: {
    conversationId: string;
    store: AgentRuntimeStore;
    signal: AbortSignal;
    previousSummary?: z.infer<SUMMARY_SCHEMA>;
  }): Promise<AgentCompactionResult> => {
    let lastSnapshot = await input.store.loadSnapshot(input.conversationId);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const snapshot =
        attempt === 1 ? lastSnapshot : await input.store.loadSnapshot(input.conversationId);
      lastSnapshot = snapshot;
      if (!(await config.threshold(snapshot))) {
        return { outcome: 'not_needed', snapshot, attempts: attempt };
      }
      const eligibleMessages = eligibleForCompaction(
        snapshot.messages,
        config.keepRecentTurns,
        config.evidencePolicy,
      );
      if (eligibleMessages.length === 0) {
        return { outcome: 'nothing_eligible', snapshot, attempts: attempt };
      }

      const leadingSummary =
        snapshot.messages[0]?.role === 'summary' ? snapshot.messages[0] : undefined;
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
      });
      const summary = config.schema.parse(rawSummary);
      if (input.signal.aborted) throw input.signal.reason;
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
        return mutationSnapshot(applied, snapshot, attempt);
      }
    }
    return { outcome: 'conflict', snapshot: lastSnapshot, attempts: maxAttempts };
  };
}
