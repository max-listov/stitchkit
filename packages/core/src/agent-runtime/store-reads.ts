import type { z } from 'zod';
import {
  type AgentStoreEventEnvelope,
  type AgentStoreEventPage,
  AgentStoreEventPageSchema,
  AppendAgentStoreEventSchema,
  ReadAgentStoreEventsSchema,
} from '../durability/events';
import { AgentConversationPurgedError } from './purge';
import type { AgentRun, AgentSnapshot } from './schemas';
import { type AgentRunView, AgentRunViewSchema } from './store';
import {
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentStoredRunSchema,
  emptyHead,
  isActiveRunState,
} from './store-driver-contract';
import { agentStoreEventDraft } from './store-events';
import { mergeRunRecords, orderRuns, referencedRunIds, snapshotOf } from './store-snapshot';

/** The snapshot as one transaction sees it — shared by reads and the export. */
export async function snapshotIn<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  conversationId: string,
): Promise<AgentSnapshot> {
  const [stored, messages, activeRecords] = await Promise.all([
    driver.head.load(transaction, conversationId),
    driver.history.load(transaction, conversationId),
    driver.runs.listActive(transaction, conversationId),
  ]);
  const head = AgentRuntimeHeadSchema.parse(stored ?? emptyHead(conversationId));
  const referencedRecords = await driver.runs.loadMany(transaction, {
    conversationId,
    runIds: referencedRunIds(messages),
  });
  return snapshotOf(head, messages, mergeRunRecords(activeRecords, referencedRecords));
}

export function loadSnapshot<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  conversationId: string,
): Promise<AgentSnapshot> {
  return driver.transaction((transaction) => snapshotIn(driver, transaction, conversationId), {
    access: 'read',
  });
}

/**
 * `loadRun` reads one run and the head. `listActiveRuns` also reads history:
 * active recovery order must use the same causal tie-break as a snapshot,
 * because same-millisecond identifiers are not queue positions. Neither
 * needs a new driver member; both compose the normalized boundaries already
 * present here.
 */
export function loadRun<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  input: {
    conversationId: string;
    runId: string;
  },
): Promise<AgentRunView | undefined> {
  return driver.transaction(
    async (transaction) => {
      const [stored, record] = await Promise.all([
        driver.head.load(transaction, input.conversationId),
        driver.runs.load(transaction, input),
      ]);
      if (!record) return undefined;
      const parsed = AgentStoredRunSchema.parse(record);
      if (
        parsed.run.conversationId !== input.conversationId ||
        parsed.run.id !== input.runId
      ) {
        throw new TypeError('Stored run does not match the identity it was loaded by');
      }
      const head = AgentRuntimeHeadSchema.parse(stored ?? emptyHead(input.conversationId));
      return AgentRunViewSchema.parse({
        snapshotVersion: head.version,
        run: parsed.run,
        ...(parsed.terminalAssistant && { assistant: parsed.terminalAssistant }),
      });
    },
    { access: 'read' },
  );
}

export function listActiveRuns<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  conversationId: string,
): Promise<readonly AgentRun[]> {
  return driver.transaction(
    async (transaction) => {
      const [records, messages] = await Promise.all([
        driver.runs.listActive(transaction, conversationId),
        driver.history.load(transaction, conversationId),
      ]);
      const runs = records.map((record) => AgentStoredRunSchema.parse(record).run);
      for (const run of runs) {
        if (run.conversationId !== conversationId) {
          throw new TypeError('Active run belongs to another conversation');
        }
        if (!isActiveRunState(run.state)) {
          throw new TypeError('Active run listing returned a terminal run');
        }
      }
      return orderRuns(messages, runs);
    },
    { access: 'read' },
  );
}

export function appendEvent<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  input: z.input<typeof AppendAgentStoreEventSchema>,
): Promise<AgentStoreEventEnvelope> {
  // Parsed before the transaction, as it always was: an invalid event throws
  // synchronously and never takes the store's write lock.
  const parsed = AppendAgentStoreEventSchema.parse(input);
  return driver.transaction((transaction) => appendEventIn(driver, transaction, parsed));
}

/**
 * Append a parsed event inside a transaction the caller already holds — the one
 * path a store and its companions share. Each caller parses where it always
 * did: the store before opening its transaction, a companion scope inside its own.
 */
export async function appendEventIn<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  transaction: TRANSACTION,
  parsed: z.output<typeof AppendAgentStoreEventSchema>,
): Promise<AgentStoreEventEnvelope> {
  if (await driver.conversations?.isPurged(transaction, parsed.conversationId)) {
    throw new AgentConversationPurgedError();
  }
  return driver.events.append(transaction, agentStoreEventDraft(parsed));
}

export function readEvents<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  input: z.input<typeof ReadAgentStoreEventsSchema>,
): Promise<AgentStoreEventPage> {
  const parsed = ReadAgentStoreEventsSchema.parse(input);
  return driver.transaction(
    async (transaction) =>
      AgentStoreEventPageSchema.parse(await driver.events.list(transaction, parsed)),
    { access: 'read' },
  );
}
