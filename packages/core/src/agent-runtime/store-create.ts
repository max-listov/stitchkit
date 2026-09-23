import { z } from 'zod';
import {
  AcceptInputAndAssignRunSchema,
  AcquireAgentRunSchema,
  AgentRecoverablePageSchema,
  type AgentRuntimeStore,
  CheckpointRunAssistantSchema,
  CommitRunTerminalSchema,
  RecordRunOperationSchema,
  RecoverAgentRunSchema,
  ReplaceCompactedRangeSchema,
  RequestRunInterruptSchema,
  SeedConversationInputSchema,
} from './store';
import { exportConversation, importConversation } from './store-archive';
import type { AgentRuntimeStoreDriver } from './store-driver-contract';
import { mutateStore } from './store-mutate';
import { createStoreConversationPurge } from './store-purge';
import { appendEvent, listActiveRuns, loadRun, loadSnapshot, readEvents } from './store-reads';
import type { StoreOperation } from './store-reduce-shared';

const AgentRecoverableScanInputSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1_000),
});

/**
 * The runtime store over any driver.
 *
 * Only the wiring lives here. Reads are in `store-reads`, the archive in
 * `store-archive`, and every mutation goes through `store-mutate`, which runs
 * the pure reducer (`store-reducer`) inside one driver transaction.
 */
export function createAgentRuntimeStore<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
): AgentRuntimeStore {
  const mutate = (operation: StoreOperation) => mutateStore(driver, operation);
  return {
    loadSnapshot: (conversationId) => loadSnapshot(driver, conversationId),
    loadRun: (input) => loadRun(driver, input),
    listActiveRuns: (conversationId) => listActiveRuns(driver, conversationId),
    appendEvent: (input) => appendEvent(driver, input),
    readEvents: (input) => readEvents(driver, input),
    exportConversation: (conversationId) => exportConversation(driver, conversationId),
    importConversation: (bytes) => importConversation(driver, bytes),
    ...(driver.conversations && {
      purgeConversation: createStoreConversationPurge(driver, driver.conversations),
    }),
    acceptInputAndAssignRun: (input) =>
      mutate({
        type: 'accept',
        input: AcceptInputAndAssignRunSchema.parse(input),
      }),
    acquireRun: (input) =>
      mutate({ type: 'acquire', input: AcquireAgentRunSchema.parse(input) }),
    checkpointRunAssistant: (input) =>
      mutate({
        type: 'checkpoint',
        input: CheckpointRunAssistantSchema.parse(input),
      }),
    recordRunOperation: (input) =>
      mutate({
        type: 'operation',
        input: RecordRunOperationSchema.parse(input),
      }),
    requestRunInterrupt: (input) =>
      mutate({
        type: 'interrupt',
        input: RequestRunInterruptSchema.parse(input),
      }),
    recoverRun: (input) =>
      mutate({ type: 'recover', input: RecoverAgentRunSchema.parse(input) }),
    commitRunTerminal: (input) =>
      mutate({ type: 'terminal', input: CommitRunTerminalSchema.parse(input) }),
    replaceCompactedRange: (input) =>
      mutate({
        type: 'compact',
        input: ReplaceCompactedRangeSchema.parse(input),
      }),
    seedConversationInput: (input) =>
      mutate({
        type: 'seed',
        input: SeedConversationInputSchema.parse(input),
      }),
    async scanRecoverable(input) {
      const parsed = AgentRecoverableScanInputSchema.parse(input);
      return AgentRecoverablePageSchema.parse(await driver.scanRecoverable(parsed));
    },
  };
}
