import { z } from 'zod';
import { AgentRecordIdSchema } from '../durability/events';
import { AgentBranchRefusalSchema } from './branch-refusal';
import { AgentCodingToolAuthorizationSchema } from './coding-tool-contract';
import { AgentTimestampSchema } from './schemas';

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

/** The runtime reference names a branch reads in application JSON. */
export const BRANCH_RUNTIME_REFERENCE_KEYS = [
  'reference',
  'conversationId',
  'runId',
  'messageId',
  'callId',
  'toolCallId',
  'approvalId',
  'operationId',
  'artifactId',
] as const;

const BranchApplicationKeySchema = z
  .object({
    key: z.enum(BRANCH_RUNTIME_REFERENCE_KEYS),
    sourceIdentity: z.enum(['refuse', 'retain', 'rekey-spill']).default('refuse'),
  })
  .strict();

const BranchApplicationKeysSchema = z
  .array(BranchApplicationKeySchema)
  .superRefine((keys, ctx) => {
    const names = keys.map((entry) => entry.key);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: 'custom', message: 'Branch application keys repeat a key' });
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
     * Keys the application uses for its own data inside message metadata, tool
     * input and output, and provider options, where the same name is otherwise
     * read as a runtime reference and refuses the branch. Each key is declared
     * once; `sourceIdentity` says what happens when its value names something of
     * the source conversation:
     *
     * - `'refuse'` (default): the value is data that never names the source; one
     *   that does refuses the branch.
     * - `'retain'`: the value may be a record of the past — the run that took an
     *   input, the IDs a read of the application's data returned. It crosses
     *   byte for byte and never becomes a reference of the destination. Only the
     *   source conversation, its runs and its messages may be named so; a value
     *   that names a spill, an application file or any other runtime identity
     *   still refuses, because what it grants crosses by its own contract.
     * - `'rekey-spill'`: the string value names a spill (live or expired) owned
     *   by the source conversation and is rekeyed to the destination spill
     *   identity; live referenced spills are copied into the destination under
     *   `artifactAuthorization`. `null` and non-string values pass through; any
     *   string that does not name exclusively a source spill refuses.
     */
    applicationKeys: BranchApplicationKeysSchema.optional(),
  })
  .strict();

/** What a caller passes; `sourceIdentity` may be omitted. */
export type BranchAgentConversationInput = z.input<typeof BranchAgentConversationInputSchema>;
/** The parsed request the branch works from. */
export type ParsedBranchAgentConversationInput = z.infer<
  typeof BranchAgentConversationInputSchema
>;

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

/**
 * What a branch of one request would refuse, read without writing. `ready`
 * when nothing; otherwise the same refusals the branch throws, in its order.
 * `applicationFiles` lists every attachment reference of the source that is
 * not a spill — each needs a declaration, and access the host grants before
 * the branch. The plan is bound to the source it read by `sourceArchiveDigest`
 * and to the request by `fingerprint`, the receipt's own.
 */
export const AgentConversationBranchPlanSchema = z
  .object({
    ready: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    sourceArchiveDigest: z.string().regex(/^[a-f0-9]{64}$/),
    refusals: z.array(AgentBranchRefusalSchema),
    omittedRefusals: z.int().nonnegative(),
    applicationFiles: z.array(z.string().min(1)),
    undeclaredKeys: z.array(z.string().min(1)),
  })
  .strict();

/** Dry-run branch plan inferred from `AgentConversationBranchPlanSchema`. */
export type AgentConversationBranchPlan = z.infer<typeof AgentConversationBranchPlanSchema>;
