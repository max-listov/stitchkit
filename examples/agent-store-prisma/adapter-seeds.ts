import { type AgentRuntimeStoreDriver, AgentSeedReceiptSchema } from 'stitchkit/agent-runtime';
import { decodePayload, encodePayload, storageId } from './adapter-codec';
import type { Prisma } from './generated/client';
export function createPrismaSeedDriver(): AgentRuntimeStoreDriver<Prisma.TransactionClient>['seeds'] {
  return {
    async load(transaction, input) {
      const row = await transaction.agentRuntimeSeed.findUnique({
        where: {
          conversationId_seedKey: {
            conversationId: storageId(input.conversationId),
            seedKey: storageId(input.seedKey),
          },
        },
      });
      return row ? AgentSeedReceiptSchema.parse(decodePayload(row.payload)) : undefined;
    },
    async create(transaction, rawReceipt) {
      const receipt = AgentSeedReceiptSchema.parse(rawReceipt);
      await transaction.agentRuntimeSeed.create({
        data: {
          conversationId: storageId(receipt.conversationId),
          seedKey: storageId(receipt.seedKey),
          payload: encodePayload(receipt),
        },
      });
    },
  };
}
