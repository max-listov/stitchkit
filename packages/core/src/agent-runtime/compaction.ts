import type { ZodType, z } from 'zod';
import type { AgentMessage, AgentSnapshot } from './schemas';
import type { AgentRuntimeStore, AgentStoreMutationResult } from './store';

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
}

interface MessageTurn {
  messages: AgentMessage[];
  complete: boolean;
}

function providerValidTurn(messages: readonly AgentMessage[]): boolean {
  if (messages[0]?.role !== 'user') return false;
  const assistant = messages.find((message) => message.role === 'assistant');
  if (!assistant || assistant.status === 'streaming' || assistant.status === 'failed') {
    return false;
  }
  const calls = new Set(
    assistant.parts.filter((part) => part.type === 'tool-call').map((part) => part.callId),
  );
  const results = new Set(
    assistant.parts.filter((part) => part.type === 'tool-result').map((part) => part.callId),
  );
  return (
    [...calls].every((callId) => results.has(callId)) &&
    [...results].every((callId) => calls.has(callId))
  );
}

function groupProviderTurns(messages: readonly AgentMessage[]): MessageTurn[] {
  const turns: MessageTurn[] = [];
  let current: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'user' && current.length > 0) {
      turns.push({
        messages: current,
        complete: providerValidTurn(current),
      });
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    turns.push({
      messages: current,
      complete: providerValidTurn(current),
    });
  }
  return turns;
}

function eligibleForCompaction(
  messages: readonly AgentMessage[],
  keepRecentTurns: number,
): AgentMessage[] {
  const withoutLeadingSummary = messages[0]?.role === 'summary' ? messages.slice(1) : messages;
  const turns = groupProviderTurns(withoutLeadingSummary);
  const firstIncomplete = turns.findIndex((turn) => !turn.complete);
  const completeTurns = firstIncomplete === -1 ? turns : turns.slice(0, firstIncomplete);
  const eligibleCount = Math.max(0, completeTurns.length - keepRecentTurns);
  return completeTurns.slice(0, eligibleCount).flatMap((turn) => turn.messages);
}

function mutationSnapshot(
  result: AgentStoreMutationResult,
  fallback: AgentSnapshot,
): AgentCompactionResult {
  if (result.outcome === 'applied' || result.outcome === 'duplicate') {
    return { outcome: 'applied', snapshot: result.snapshot };
  }
  return { outcome: result.outcome, snapshot: fallback };
}

export function structuredCompaction<SUMMARY_SCHEMA extends ZodType>(
  config: StructuredCompactionConfig<SUMMARY_SCHEMA>,
) {
  if (!Number.isSafeInteger(config.keepRecentTurns) || config.keepRecentTurns < 1) {
    throw new TypeError('keepRecentTurns must be a positive safe integer');
  }

  return async (input: {
    conversationId: string;
    store: AgentRuntimeStore;
    signal: AbortSignal;
    previousSummary?: z.infer<SUMMARY_SCHEMA>;
  }): Promise<AgentCompactionResult> => {
    const snapshot = await input.store.loadSnapshot(input.conversationId);
    if (!(await config.threshold(snapshot))) return { outcome: 'not_needed', snapshot };
    const eligibleMessages = eligibleForCompaction(snapshot.messages, config.keepRecentTurns);
    if (eligibleMessages.length === 0) return { outcome: 'nothing_eligible', snapshot };

    const leadingSummary =
      snapshot.messages[0]?.role === 'summary' ? snapshot.messages[0] : undefined;
    const previousSummary =
      input.previousSummary ??
      (leadingSummary && config.readPreviousSummary
        ? config.schema.parse(config.readPreviousSummary(leadingSummary))
        : undefined);

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
    const previousSummaryMessage =
      previousSummary !== undefined && leadingSummary ? leadingSummary : undefined;
    const applied = await input.store.replaceCompactedRange({
      conversationId: input.conversationId,
      expectedVersion: snapshot.version,
      replacedMessageIds: [
        ...(previousSummaryMessage ? [previousSummaryMessage.id] : []),
        ...eligibleMessages.map((message) => message.id),
      ],
      summary: summaryMessage,
    });
    return mutationSnapshot(applied, snapshot);
  };
}
