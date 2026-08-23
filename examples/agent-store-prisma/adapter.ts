import { PrismaPg } from '@prisma/adapter-pg';
import {
  AgentAdmissionReceiptSchema,
  AgentHistoryMutationSchema,
  AgentMessageSchema,
  AgentRecoverableDescriptorSchema,
  AgentRecoverablePageSchema,
  AgentRunSchema,
  AgentRuntimeHeadSchema,
  type AgentRuntimeStoreDriver,
  AgentStoredRunSchema,
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
    head: {
      async load(transaction, conversationId) {
        const row = await transaction.agentRuntimeState.findUnique({
          where: { conversationId: storageId(conversationId) },
        });
        return row
          ? AgentRuntimeHeadSchema.parse({
              schemaVersion: 1,
              conversationId,
              version: row.version,
            })
          : undefined;
      },
      async compareAndSwap(transaction, operation) {
        const conversationStorageId = storageId(operation.conversationId);
        const affected = await transaction.$executeRaw`
          INSERT INTO "AgentRuntimeState" ("conversationId", "version")
          VALUES (${conversationStorageId}, ${operation.next.version})
          ON CONFLICT ("conversationId") DO UPDATE
          SET "version" = EXCLUDED."version"
          WHERE "AgentRuntimeState"."version" = ${operation.expectedVersion}
        `;
        if (affected !== 1) {
          const current = await transaction.agentRuntimeState.findUnique({
            where: { conversationId: conversationStorageId },
            select: { version: true },
          });
          return { outcome: 'conflict', actualVersion: current?.version ?? 0 };
        }
        return { outcome: 'applied' };
      },
    },
    runs: {
      async load(transaction, input) {
        const row = await transaction.agentRuntimeRun.findUnique({
          where: {
            conversationId_runId: {
              conversationId: storageId(input.conversationId),
              runId: storageId(input.runId),
            },
          },
        });
        return row
          ? AgentStoredRunSchema.parse({
              schemaVersion: 1,
              run: AgentRunSchema.parse(decodePayload(row.payload)),
              ...(row.terminalAssistantPayload && {
                terminalAssistant: AgentMessageSchema.parse(
                  decodePayload(row.terminalAssistantPayload),
                ),
              }),
            })
          : undefined;
      },
      async loadByAssistantMessageId(transaction, input) {
        const row = await transaction.agentRuntimeRun.findUnique({
          where: {
            conversationId_assistantMessageId: {
              conversationId: storageId(input.conversationId),
              assistantMessageId: storageId(input.assistantMessageId),
            },
          },
        });
        return row
          ? AgentStoredRunSchema.parse({
              schemaVersion: 1,
              run: AgentRunSchema.parse(decodePayload(row.payload)),
              ...(row.terminalAssistantPayload && {
                terminalAssistant: AgentMessageSchema.parse(
                  decodePayload(row.terminalAssistantPayload),
                ),
              }),
            })
          : undefined;
      },
      async loadMany(transaction, input) {
        if (input.runIds.length === 0) return [];
        const rows = await transaction.agentRuntimeRun.findMany({
          where: {
            conversationId: storageId(input.conversationId),
            runId: { in: input.runIds.map(storageId) },
          },
        });
        return rows.map((row) =>
          AgentStoredRunSchema.parse({
            schemaVersion: 1,
            run: AgentRunSchema.parse(decodePayload(row.payload)),
            ...(row.terminalAssistantPayload && {
              terminalAssistant: AgentMessageSchema.parse(
                decodePayload(row.terminalAssistantPayload),
              ),
            }),
          }),
        );
      },
      async listActive(transaction, conversationId) {
        const rows = await transaction.agentRuntimeRun.findMany({
          where: {
            conversationId: storageId(conversationId),
            state: { in: ['queued', 'running', 'interrupt_requested'] },
          },
        });
        return rows.map((row) =>
          AgentStoredRunSchema.parse({
            schemaVersion: 1,
            run: AgentRunSchema.parse(decodePayload(row.payload)),
          }),
        );
      },
      async save(transaction, rawRecord) {
        const record = AgentStoredRunSchema.parse(rawRecord);
        const data = {
          assistantMessageId: storageId(record.run.assistantMessageId),
          state: record.run.state,
          createdAt: new Date(record.run.createdAt),
          payload: encodePayload(record.run),
          terminalAssistantPayload: record.terminalAssistant
            ? encodePayload(record.terminalAssistant)
            : null,
        };
        await transaction.agentRuntimeRun.upsert({
          where: {
            conversationId_runId: {
              conversationId: storageId(record.run.conversationId),
              runId: storageId(record.run.id),
            },
          },
          create: {
            conversationId: storageId(record.run.conversationId),
            runId: storageId(record.run.id),
            ...data,
          },
          update: data,
        });
      },
    },
    admissions: {
      async load(transaction, input) {
        const row = await transaction.agentRuntimeAdmission.findUnique({
          where: {
            conversationId_idempotencyKey: {
              conversationId: storageId(input.conversationId),
              idempotencyKey: storageId(input.idempotencyKey),
            },
          },
        });
        return row
          ? AgentAdmissionReceiptSchema.parse({
              schemaVersion: 1,
              conversationId: input.conversationId,
              idempotencyKey: input.idempotencyKey,
              input: AgentMessageSchema.parse(decodePayload(row.inputPayload)),
              runId: Buffer.from(row.runId, 'base64url').toString('utf8'),
              assistantMessageId: Buffer.from(row.assistantMessageId, 'base64url').toString(
                'utf8',
              ),
            })
          : undefined;
      },
      async loadByInputMessageId(transaction, input) {
        const row = await transaction.agentRuntimeAdmission.findUnique({
          where: {
            conversationId_inputMessageId: {
              conversationId: storageId(input.conversationId),
              inputMessageId: storageId(input.inputMessageId),
            },
          },
        });
        return row
          ? AgentAdmissionReceiptSchema.parse({
              schemaVersion: 1,
              conversationId: input.conversationId,
              idempotencyKey: Buffer.from(row.idempotencyKey, 'base64url').toString('utf8'),
              input: AgentMessageSchema.parse(decodePayload(row.inputPayload)),
              runId: Buffer.from(row.runId, 'base64url').toString('utf8'),
              assistantMessageId: Buffer.from(row.assistantMessageId, 'base64url').toString(
                'utf8',
              ),
            })
          : undefined;
      },
      async create(transaction, rawReceipt) {
        const receipt = AgentAdmissionReceiptSchema.parse(rawReceipt);
        await transaction.agentRuntimeAdmission.create({
          data: {
            conversationId: storageId(receipt.conversationId),
            idempotencyKey: storageId(receipt.idempotencyKey),
            inputMessageId: storageId(receipt.input.id),
            runId: storageId(receipt.runId),
            assistantMessageId: storageId(receipt.assistantMessageId),
            inputPayload: encodePayload(receipt.input),
          },
        });
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
      const rows = await prisma.agentRuntimeRun.findMany({
        where: cursor
          ? {
              state: { in: ['queued', 'running', 'interrupt_requested'] },
              OR: [
                { conversationId: { gt: storageId(cursor[0]) } },
                {
                  conversationId: storageId(cursor[0]),
                  runId: { gt: storageId(cursor[1]) },
                },
              ],
            }
          : { state: { in: ['queued', 'running', 'interrupt_requested'] } },
        orderBy: [{ conversationId: 'asc' }, { runId: 'asc' }],
        take: scan.limit + 1,
      });
      const hasMore = rows.length > scan.limit;
      const items = rows.slice(0, scan.limit).map((row) => {
        const run = AgentRunSchema.parse(decodePayload(row.payload));
        return AgentRecoverableDescriptorSchema.parse({
          conversationId: run.conversationId,
          run,
        });
      });
      const last = items.at(-1);
      const lastRow = rows[Math.min(scan.limit, rows.length) - 1];
      return AgentRecoverablePageSchema.parse({
        items,
        ...(hasMore && last && lastRow
          ? {
              nextCursor: recoveryCursor(last.conversationId, last.run.id),
            }
          : {}),
      });
    },
  };
  return { prisma, store: createAgentRuntimeStore(driver) };
}
