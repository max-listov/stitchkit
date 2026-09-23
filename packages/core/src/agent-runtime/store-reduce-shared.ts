import {
  type AgentMessage,
  type AgentRun,
  type AgentSnapshot,
  AgentSnapshotSchema,
} from './schemas';
import type {
  AcceptInputAndAssignRun,
  AcquireAgentRun,
  CheckpointRunAssistant,
  CommitRunTerminal,
  RecordRunOperation,
  RecoverAgentRun,
  ReplaceCompactedRange,
  RequestRunInterrupt,
  SeedConversationInput,
} from './store';
import type {
  AgentAdmissionReceipt,
  AgentHistoryMutation,
  AgentSeedReceipt,
  AgentStoredRun,
} from './store-driver-contract';
import { orderRunMessages } from './store-snapshot';

/** One store mutation, as the public store methods hand it to the reducer. */
export type StoreOperation =
  | { type: 'accept'; input: AcceptInputAndAssignRun }
  | { type: 'acquire'; input: AcquireAgentRun }
  | { type: 'checkpoint'; input: CheckpointRunAssistant }
  | { type: 'operation'; input: RecordRunOperation }
  | { type: 'interrupt'; input: RequestRunInterrupt }
  | { type: 'recover'; input: RecoverAgentRun }
  | { type: 'terminal'; input: CommitRunTerminal }
  | { type: 'compact'; input: ReplaceCompactedRange }
  | { type: 'seed'; input: SeedConversationInput };

export interface ReducedApplied {
  outcome: 'applied';
  snapshot: AgentSnapshot;
  /**
   * Plural because one mutation can settle two runs.
   *
   * A terminal commit that absorbs a queued successor writes both records, and
   * it must write them in one transaction or the absorption is exactly the
   * split-brain the 0.63.0 design shipped.
   */
  runRecords?: readonly AgentStoredRun[];
  admissionReceipt?: AgentAdmissionReceipt;
  seedReceipt?: AgentSeedReceipt;
  historyMutations?: readonly AgentHistoryMutation[];
}

export type ReducedMutation =
  | ReducedApplied
  | { outcome: 'conflict'; actualVersion: number }
  | { outcome: 'not_found' }
  | {
      outcome: 'duplicate';
      input: AgentMessage;
      inputMessageId: string;
      runId: string;
      assistantMessageId: string;
      run: AgentRun;
      assistant?: AgentMessage;
      snapshot: AgentSnapshot;
    };

export function conflict(actualVersion: number): {
  outcome: 'conflict';
  actualVersion: number;
} {
  return { outcome: 'conflict', actualVersion };
}

export function applied(
  current: AgentSnapshot,
  input: { runs?: readonly AgentRun[]; messages?: readonly AgentMessage[] },
  effects?: {
    runRecords?: readonly AgentStoredRun[];
    admissionReceipt?: AgentAdmissionReceipt;
    seedReceipt?: AgentSeedReceipt;
    historyMutations?: readonly AgentHistoryMutation[];
  },
): ReducedApplied {
  const runs = input.runs ?? current.runs;
  const messages = input.messages ?? current.messages;
  return {
    outcome: 'applied',
    snapshot: AgentSnapshotSchema.parse({
      ...current,
      version: current.version + 1,
      runs,
      messages: orderRunMessages(messages, runs),
    }),
    ...(effects?.runRecords?.length && { runRecords: effects.runRecords }),
    ...(effects?.admissionReceipt && { admissionReceipt: effects.admissionReceipt }),
    ...(effects?.seedReceipt && { seedReceipt: effects.seedReceipt }),
    ...(effects?.historyMutations?.length && { historyMutations: effects.historyMutations }),
  };
}
