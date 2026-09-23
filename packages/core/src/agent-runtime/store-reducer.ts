import { createHash } from 'node:crypto';
import type { AgentSnapshot } from './schemas';
import { canonicalAgentJson } from './store-events';
import { reduceAccept, reduceCompact, reduceSeed } from './store-reduce-history';
import {
  reduceAcquire,
  reduceCheckpoint,
  reduceInterrupt,
  reduceOperation,
  reduceRecover,
} from './store-reduce-run';
import type { ReducedMutation, StoreOperation } from './store-reduce-shared';
import { reduceTerminal } from './store-reduce-terminal';

/**
 * What a transition writes to the ledger.
 *
 * A checkpoint carries the whole assistant draft, and a run checkpoints on
 * every structural boundary and every `checkpointEveryEvents` deltas: written
 * verbatim, the ledger held the growing draft dozens of times per run and the
 * search index matched one phrase at dozens of `seq`. The checkpoint record
 * names the draft by hash and size; the terminal commit still carries the
 * final message in full, and the normalized tables hold the draft itself.
 */
export function transitionRecord(operation: StoreOperation): unknown {
  if (operation.type !== 'checkpoint') return operation;
  const { assistant, ...rest } = operation.input;
  const body = canonicalAgentJson(assistant);
  return {
    type: operation.type,
    input: {
      ...rest,
      assistant: {
        id: assistant.id,
        status: assistant.status,
        sha256: createHash('sha256').update(body).digest('hex'),
        parts: assistant.parts.length,
        bytes: Buffer.byteLength(body),
      },
    },
  };
}

/**
 * The pure transition of one conversation snapshot by one operation.
 *
 * Each operation kind has its own reducer; this only routes to it. The three
 * kinds that address the conversation as a whole come first, and every other
 * kind addresses one run of it — a run this snapshot does not hold is
 * `not_found` before any reducer sees it.
 */
export function reduceStore(
  current: AgentSnapshot,
  operation: StoreOperation,
): ReducedMutation {
  if (operation.type === 'accept') return reduceAccept(current, operation.input);
  if (operation.type === 'seed') return reduceSeed(current, operation.input);
  if (operation.type === 'compact') return reduceCompact(current, operation.input);
  const run = current.runs.find((candidate) => candidate.id === operation.input.runId);
  if (!run) return { outcome: 'not_found' };
  switch (operation.type) {
    case 'acquire':
      return reduceAcquire(current, run, operation.input);
    case 'checkpoint':
      return reduceCheckpoint(current, run, operation.input);
    case 'operation':
      return reduceOperation(current, run, operation.input);
    case 'interrupt':
      return reduceInterrupt(current, run, operation.input);
    case 'recover':
      return reduceRecover(current, run, operation.input);
    case 'terminal':
      return reduceTerminal(current, run, operation.input);
  }
}

export function operationConversationId(operation: StoreOperation): string {
  return operation.type === 'accept'
    ? operation.input.input.conversationId
    : operation.input.conversationId;
}
