import { z } from 'zod';
import { AgentCodingToolAuthorizationSchema } from './coding-tool-contract';
import { AgentRecordIdSchema, AgentTimestampSchema } from './schemas';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * A file part reference the application stored itself, and the reference the
 * same file has in the destination conversation.
 *
 * The runtime never owns these bytes: a file part's `reference` is whatever the
 * application's `persistGeneratedFile` returned or its input carried, read back
 * through `resolveFile`. Before branching, the host grants the destination
 * conversation access in its own store under `destinationReference`; the branch
 * then carries that address and never the source's.
 */
const BranchApplicationFileSchema = z
  .object({
    reference: z.string().min(1),
    destinationReference: z.string().min(1),
  })
  .strict();

const BranchApplicationFilesSchema = z
  .array(BranchApplicationFileSchema)
  .superRefine((files, ctx) => {
    for (const field of ['reference', 'destinationReference'] as const) {
      const values = files.map((file) => file[field]);
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: 'custom',
          message: `Branch application files repeat a ${field}`,
        });
    }
  });

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
    /**
     * Every file part reference in the supplied history that the application
     * stores, unselected tail included. A file part whose reference is neither a
     * spill of the archive nor declared here refuses the branch.
     */
    applicationFiles: BranchApplicationFilesSchema.optional(),
    /**
     * Key names the application uses for its own data inside message metadata,
     * tool input and output, and provider options, where the same name would
     * otherwise be read as a runtime reference: `messageId`, `reference`,
     * `runId` and the like. A declared key still refuses when its value names
     * an identity of the source conversation.
     */
    applicationKeys: z.array(z.string().min(1)).optional(),
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
