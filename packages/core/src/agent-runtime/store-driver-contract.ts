import { z } from 'zod';
import type {
  AgentStoreEventEnvelope,
  AgentStoreEventPage,
  ReadAgentStoreEventsSchema,
} from '../durability/events';
import {
  type AgentMessage,
  AgentMessageSchema,
  AgentRecordIdSchema,
  AgentRecordVersionSchema,
  type AgentRun,
  AgentRunSchema,
} from './schemas';
import type { AgentRecoverablePage } from './store';
import type { AgentConversationArchive, AgentStoreEventDraft } from './store-events';
import type { AgentConversationPurgeDriver } from './store-purge';

export const AgentRuntimeHeadSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  version: AgentRecordVersionSchema,
});

export const AgentStoredRunSchema = z.object({
  schemaVersion: z.literal(1),
  run: AgentRunSchema,
  terminalAssistant: AgentMessageSchema.optional(),
});

export const AgentAdmissionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  idempotencyKey: z.string().min(1),
  input: AgentMessageSchema,
  runId: AgentRecordIdSchema,
  assistantMessageId: AgentRecordIdSchema,
});

export type AgentRuntimeHead = z.infer<typeof AgentRuntimeHeadSchema>;
export type AgentStoredRun = z.infer<typeof AgentStoredRunSchema>;
export type AgentAdmissionReceipt = z.infer<typeof AgentAdmissionReceiptSchema>;

/**
 * The durable record that a keyed user-instruction seed already happened.
 *
 * Kept beside the history rather than derived from it: compaction and `clear`
 * legitimately remove the seeded messages, and the seed must not return when
 * they do. `messageIds` lets an archive round trip match an imported seed's
 * messages without this record.
 */
export const AgentSeedReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  conversationId: AgentRecordIdSchema,
  seedKey: z.string().min(1),
  messageIds: z.array(AgentRecordIdSchema).min(1),
});

export type AgentSeedReceipt = z.infer<typeof AgentSeedReceiptSchema>;

export const AgentHistoryMutationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('admit'), input: AgentMessageSchema }),
  z.object({
    type: z.literal('upsert-assistant'),
    message: AgentMessageSchema,
  }),
  z.object({
    type: z.literal('replace-compacted-range'),
    replacedMessageIds: z.array(AgentRecordIdSchema).min(1),
    summary: AgentMessageSchema,
  }),
  z.object({
    type: z.literal('seed'),
    message: AgentMessageSchema,
  }),
]);

export type AgentHistoryMutation = z.infer<typeof AgentHistoryMutationSchema>;

export type AgentStoreCompareAndSwapResult =
  | { outcome: 'applied' }
  | { outcome: 'conflict'; actualVersion: number };

export interface AgentRuntimeStoreDriver<TRANSACTION> {
  conversations?: AgentConversationPurgeDriver<TRANSACTION>;
  /**
   * Run one coherent store operation. `read` lets an adapter take a stable
   * snapshot without reserving its writer slot; absent options retain the
   * write-safe transaction used by existing adapters.
   */
  transaction<RESULT>(
    work: (transaction: TRANSACTION) => Promise<RESULT>,
    options?: { access: 'read' | 'write' },
  ): Promise<RESULT>;
  head: {
    load(
      transaction: TRANSACTION,
      conversationId: string,
    ): Promise<AgentRuntimeHead | undefined>;
    compareAndSwap(
      transaction: TRANSACTION,
      input: {
        conversationId: string;
        expectedVersion: number;
        next: AgentRuntimeHead;
      },
    ): Promise<AgentStoreCompareAndSwapResult>;
  };
  runs: {
    load(
      transaction: TRANSACTION,
      input: { conversationId: string; runId: string },
    ): Promise<AgentStoredRun | undefined>;
    loadByAssistantMessageId(
      transaction: TRANSACTION,
      input: { conversationId: string; assistantMessageId: string },
    ): Promise<AgentStoredRun | undefined>;
    loadMany(
      transaction: TRANSACTION,
      input: { conversationId: string; runIds: readonly string[] },
    ): Promise<readonly AgentStoredRun[]>;
    listActive(
      transaction: TRANSACTION,
      conversationId: string,
    ): Promise<readonly AgentStoredRun[]>;
    save(transaction: TRANSACTION, record: AgentStoredRun): Promise<void>;
  };
  admissions: {
    load(
      transaction: TRANSACTION,
      input: { conversationId: string; idempotencyKey: string },
    ): Promise<AgentAdmissionReceipt | undefined>;
    loadByInputMessageId(
      transaction: TRANSACTION,
      input: { conversationId: string; inputMessageId: string },
    ): Promise<AgentAdmissionReceipt | undefined>;
    create(transaction: TRANSACTION, receipt: AgentAdmissionReceipt): Promise<void>;
  };
  seeds: {
    load(
      transaction: TRANSACTION,
      input: { conversationId: string; seedKey: string },
    ): Promise<AgentSeedReceipt | undefined>;
    create(transaction: TRANSACTION, receipt: AgentSeedReceipt): Promise<void>;
  };
  history: {
    load(transaction: TRANSACTION, conversationId: string): Promise<readonly AgentMessage[]>;
    /**
     * Whether any stored message — active or compacted — already carries this
     * identity.
     *
     * `load` deliberately hides compacted rows, so a seed restored into a
     * conversation whose receipts were not restored can match a message the
     * active view does not show. Optional because a driver with no inactive
     * store has nothing `load` hides; the seed write is idempotent either way.
     */
    hasMessage?(
      transaction: TRANSACTION,
      input: { conversationId: string; messageId: string },
    ): Promise<boolean>;
    apply(transaction: TRANSACTION, mutation: AgentHistoryMutation): Promise<void>;
  };
  events: {
    append(
      transaction: TRANSACTION,
      event: AgentStoreEventDraft,
    ): Promise<AgentStoreEventEnvelope>;
    list(
      transaction: TRANSACTION,
      input: z.infer<typeof ReadAgentStoreEventsSchema>,
    ): Promise<AgentStoreEventPage>;
  };
  /** Optional driver-owned durable payloads included in the canonical archive. */
  archive?: {
    export(
      transaction: TRANSACTION,
      conversationId: string,
    ): Promise<Pick<AgentConversationArchive, 'projections' | 'spills'>>;
    import(transaction: TRANSACTION, archive: AgentConversationArchive): Promise<void>;
  };
  scanRecoverable(input: { cursor?: string; limit: number }): Promise<AgentRecoverablePage>;
}

/**
 * The run states a recovery pass and an active listing must consider.
 *
 * Exported because a driver author needs it: `runs.listActive` and
 * `scanRecoverable` are driver members, so this list crossed the public
 * boundary as a literal every adapter had to guess and hardcode — the reference
 * adapter repeats it three times. Adding a run state silently broke every
 * deployed driver. Same reasoning as `isSpeakableAssistantStatus`, applied to
 * the enum that a consumer implements against rather than reads.
 */
export const ACTIVE_AGENT_RUN_STATES: readonly AgentRun['state'][] = [
  'queued',
  'running',
  'interrupt_requested',
];

export function isActiveRunState(state: AgentRun['state']): boolean {
  return ACTIVE_AGENT_RUN_STATES.includes(state);
}

export function emptyHead(conversationId: string): AgentRuntimeHead {
  return AgentRuntimeHeadSchema.parse({
    schemaVersion: 1,
    conversationId,
    version: 0,
  });
}
