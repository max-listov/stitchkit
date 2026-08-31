import {
  type AgentConversationPurgeInput,
  AgentConversationPurgeInputSchema,
  type AgentConversationPurgeResult,
} from './purge';
import type { AgentRuntimeStoreDriver } from './store-driver';

/**
 * Optional driver capability. Its transactions must serialize with every mutation of this
 * conversation, including first admission: optimistic head CAS alone is not sufficient.
 */
export interface AgentConversationPurgeDriver<TRANSACTION> {
  isPurged(transaction: TRANSACTION, conversationId: string): Promise<boolean>;
  /** Remove all owned records and retain only a permanent ID tombstone in this transaction. */
  remove(transaction: TRANSACTION, conversationId: string): Promise<void>;
}

export function createStoreConversationPurge<TRANSACTION>(
  driver: AgentRuntimeStoreDriver<TRANSACTION>,
  conversations: AgentConversationPurgeDriver<TRANSACTION>,
): (input: AgentConversationPurgeInput) => Promise<AgentConversationPurgeResult> {
  return async (input) => {
    const { conversationId, expectedVersion } = AgentConversationPurgeInputSchema.parse(input);
    return driver.transaction(async (transaction) => {
      if (await conversations.isPurged(transaction, conversationId)) {
        return { outcome: 'already_purged' };
      }
      const head = await driver.head.load(transaction, conversationId);
      const actualVersion = head?.version ?? 0;
      if (expectedVersion !== undefined && expectedVersion !== actualVersion) {
        return { outcome: 'conflict', actualVersion };
      }
      const active = await driver.runs.listActive(transaction, conversationId);
      if (active.length > 0) {
        return { outcome: 'active', runIds: active.map((record) => record.run.id) };
      }
      await conversations.remove(transaction, conversationId);
      return { outcome: 'purged' };
    });
  };
}
