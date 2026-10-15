import { z } from 'zod';
import { AgentCodingToolAuthorizationSchema } from './coding-tool-contract';
import { AgentRecordIdSchema, AgentTimestampSchema } from './schemas';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const BranchAgentConversationInputSchema = z
  .object({
    requestKey: AgentRecordIdSchema,
    destinationConversationId: AgentRecordIdSchema,
    source: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('conversation'),
          conversationId: AgentRecordIdSchema,
          /** Omit to select the settled tip, including compaction after its last run. */
          throughRunId: AgentRecordIdSchema.optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('archive'),
          bytes: z.custom<Uint8Array>((value) => value instanceof Uint8Array),
        })
        .strict(),
    ]),
    /** Fresh destination policy, required when the selected history contains spills. */
    artifactAuthorization: AgentCodingToolAuthorizationSchema.optional(),
  })
  .strict();

export type BranchAgentConversationInput = z.infer<typeof BranchAgentConversationInputSchema>;

export const AgentConversationBranchReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestKey: AgentRecordIdSchema,
    fingerprint: Hash,
    conversationId: AgentRecordIdSchema,
    sourceConversationId: AgentRecordIdSchema,
    sourceKind: z.enum(['conversation', 'archive']),
    throughRunId: AgentRecordIdSchema.optional(),
    sourceSeq: z.int().nonnegative(),
    sourceVersion: z.int().nonnegative(),
    sourceDigest: Hash,
    createdAt: AgentTimestampSchema,
  })
  .strict();

export type AgentConversationBranchReceipt = z.infer<
  typeof AgentConversationBranchReceiptSchema
>;

export const AgentConversationBranchResultSchema = z
  .object({
    outcome: z.enum(['created', 'duplicate']),
    receipt: AgentConversationBranchReceiptSchema,
  })
  .strict();

export type AgentConversationBranchResult = z.infer<
  typeof AgentConversationBranchResultSchema
>;
