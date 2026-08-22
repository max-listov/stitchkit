import { PrismaPg } from '@prisma/adapter-pg';
import {
  AgentHistoryMutationSchema,
  AgentMessageSchema,
  AgentRecoverableDescriptorSchema,
  AgentRecoverablePageSchema,
  type AgentRuntimeStoreDriver,
  AgentStoredStateSchema,
  createAgentRuntimeStore,
} from 'stitchkit/agent-runtime';
import { Prisma, PrismaClient } from './generated/client';

export interface PrismaAgentStoreFixture {
  prisma: PrismaClient;
  store: ReturnType<typeof createAgentRuntimeStore<Prisma.TransactionClient>>;
}

function encodePayload(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodePayload(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function storageId(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function recoveryCursor(conversationId: string, runId: string): string {
  return JSON.stringify([conversationId, runId]);
}

function parseRecoveryCursor(cursor: string): readonly [string, string] {
  const value: unknown = JSON.parse(cursor);
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== 'string' ||
    typeof value[1] !== 'string' ||
    value[0].length === 0 ||
    value[1].length === 0
  ) {
    throw new TypeError('Invalid recovery cursor');
  }
  return [value[0], value[1]];
}

export function createPrismaAgentStoreFixture(input: {
  connectionString: string;
  failAfterHistoryApply?: boolean;
}): PrismaAgentStoreFixture {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: input.connectionString }),
  });
  const runTransaction = async <RESULT>(
    work: (transaction: Prisma.TransactionClient) => Promise<RESULT>,
  ): Promise<RESULT> => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await prisma.$transaction((transaction) => work(transaction), {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        const retryable =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2034' ||
            (error.code === 'P2010' && error.message.includes('40001')));
        if (!retryable || attempt === 3) throw error;
      }
    }
    throw new Error('Serializable transaction retry budget exhausted');
  };
  const driver: AgentRuntimeStoreDriver<Prisma.TransactionClient> = {
    transaction: runTransaction,
    state: {
      async load(transaction, conversationId) {
        const row = await transaction.agentRuntimeState.findUnique({
          where: { conversationId: storageId(conversationId) },
        });
        return row ? AgentStoredStateSchema.parse(decodePayload(row.payload)) : undefined;
      },
      async compareAndSwap(transaction, operation) {
        const payload = encodePayload(operation.next);
        const conversationStorageId = storageId(operation.conversationId);
        const affected = await transaction.$executeRaw`
          INSERT INTO "AgentRuntimeState" ("conversationId", "version", "payload")
          VALUES (${conversationStorageId}, ${operation.next.version}, ${payload})
          ON CONFLICT ("conversationId") DO UPDATE
          SET "version" = EXCLUDED."version", "payload" = EXCLUDED."payload"
          WHERE "AgentRuntimeState"."version" = ${operation.expectedVersion}
        `;
        if (affected !== 1) {
          const current = await transaction.agentRuntimeState.findUnique({
            where: { conversationId: conversationStorageId },
            select: { version: true },
          });
          return { outcome: 'conflict', actualVersion: current?.version ?? 0 };
        }
        await transaction.agentRuntimeRecoverableRun.deleteMany({
          where: { conversationId: conversationStorageId },
        });
        if (operation.recoverable.length > 0) {
          await transaction.agentRuntimeRecoverableRun.createMany({
            data: operation.recoverable.map((descriptor) => ({
              conversationId: storageId(descriptor.conversationId),
              runId: storageId(descriptor.run.id),
              payload: encodePayload(descriptor),
            })),
          });
        }
        return { outcome: 'applied' };
      },
    },
    history: {
      async load(transaction, conversationId) {
        const rows = await transaction.agentRuntimeMessage.findMany({
          where: { conversationId: storageId(conversationId), active: true },
          orderBy: { position: 'asc' },
        });
        return rows.map((row) => AgentMessageSchema.parse(decodePayload(row.payload)));
      },
      async loadById(transaction, input) {
        const row = await transaction.agentRuntimeMessage.findUnique({
          where: {
            conversationId_id: {
              conversationId: storageId(input.conversationId),
              id: storageId(input.messageId),
            },
          },
        });
        return row ? AgentMessageSchema.parse(decodePayload(row.payload)) : undefined;
      },
      async apply(transaction, rawMutation) {
        const mutation = AgentHistoryMutationSchema.parse(rawMutation);
        const message =
          mutation.type === 'admit'
            ? mutation.input
            : mutation.type === 'upsert-assistant'
              ? mutation.message
              : mutation.summary;
        const conversationStorageId = storageId(message.conversationId);
        if (mutation.type === 'replace-compacted-range') {
          const rows = await transaction.agentRuntimeMessage.findMany({
            where: {
              conversationId: conversationStorageId,
              id: { in: mutation.replacedMessageIds.map(storageId) },
              active: true,
            },
            orderBy: { position: 'asc' },
          });
          const first = rows[0];
          if (!first || rows.length !== mutation.replacedMessageIds.length) {
            throw new Error('Compaction range changed inside the transaction');
          }
          await transaction.agentRuntimeMessage.updateMany({
            where: {
              conversationId: conversationStorageId,
              id: { in: mutation.replacedMessageIds.map(storageId) },
            },
            data: { active: false },
          });
          await transaction.agentRuntimeMessage.create({
            data: {
              conversationId: conversationStorageId,
              id: storageId(message.id),
              position: first.position,
              payload: encodePayload(message),
            },
          });
        } else {
          const existing = await transaction.agentRuntimeMessage.findUnique({
            where: {
              conversationId_id: {
                conversationId: conversationStorageId,
                id: storageId(message.id),
              },
            },
          });
          if (existing) {
            await transaction.agentRuntimeMessage.update({
              where: {
                conversationId_id: {
                  conversationId: conversationStorageId,
                  id: storageId(message.id),
                },
              },
              data: { payload: encodePayload(message) },
            });
          } else {
            const last = await transaction.agentRuntimeMessage.findFirst({
              where: { conversationId: conversationStorageId },
              orderBy: { position: 'desc' },
            });
            await transaction.agentRuntimeMessage.create({
              data: {
                conversationId: conversationStorageId,
                id: storageId(message.id),
                position: (last?.position ?? -1) + 1,
                payload: encodePayload(message),
              },
            });
          }
        }
        if (input.failAfterHistoryApply) {
          throw new Error('Injected failure after history mutation');
        }
      },
    },
    async scanRecoverable(scan) {
      const cursor = scan.cursor ? parseRecoveryCursor(scan.cursor) : undefined;
      const rows = await prisma.agentRuntimeRecoverableRun.findMany({
        where: cursor
          ? {
              OR: [
                { conversationId: { gt: cursor[0] } },
                { conversationId: cursor[0], runId: { gt: cursor[1] } },
              ],
            }
          : undefined,
        orderBy: [{ conversationId: 'asc' }, { runId: 'asc' }],
        take: scan.limit + 1,
      });
      const hasMore = rows.length > scan.limit;
      const items = rows
        .slice(0, scan.limit)
        .map((row) => AgentRecoverableDescriptorSchema.parse(decodePayload(row.payload)));
      const last = items.at(-1);
      const lastRow = rows[Math.min(scan.limit, rows.length) - 1];
      return AgentRecoverablePageSchema.parse({
        items,
        ...(hasMore && last && lastRow
          ? {
              nextCursor: recoveryCursor(lastRow.conversationId, lastRow.runId),
            }
          : {}),
      });
    },
  };
  return { prisma, store: createAgentRuntimeStore(driver) };
}
