import {
  type AgentConversationBranchReceipt,
  AgentConversationBranchReceiptSchema,
  type AgentConversationBranchResult,
  AgentConversationBranchResultSchema,
  type BranchAgentConversationInput,
  BranchAgentConversationInputSchema,
  createMemoryAgentRuntimeStore,
} from 'stitchkit/agent-runtime';
import { createNodeSqliteAgentRuntimeStore } from 'stitchkit/agent-runtime/sqlite/node';

async function branchDeclarations(bytes: Uint8Array) {
  const input: BranchAgentConversationInput = {
    requestKey: 'restore',
    destinationConversationId: 'copy',
    source: { kind: 'archive', bytes },
  };
  const store = createMemoryAgentRuntimeStore();
  const result: AgentConversationBranchResult = await store.branchConversation(
    BranchAgentConversationInputSchema.parse(input),
  );
  const receipt: AgentConversationBranchReceipt = result.receipt;
  AgentConversationBranchResultSchema.parse(result);
  AgentConversationBranchReceiptSchema.parse(receipt);
  const sqlite = createNodeSqliteAgentRuntimeStore({ filename: ':memory:' });
  try {
    await sqlite.store.branchConversation({
      requestKey: 'prefix',
      destinationConversationId: 'copy',
      source: { kind: 'conversation', conversationId: 'source', throughRunId: 'settled-run' },
    });
  } finally {
    await sqlite.close();
  }
}
void branchDeclarations;
