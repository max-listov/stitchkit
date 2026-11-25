import { z } from 'zod';
import { AgentTimestampSchema } from './schemas';

const Id = z.string().min(1).max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

const PayloadBase = z.object({
  conversationId: Id,
  invocationId: Id,
  operationId: Id,
  runId: Id.optional(),
});

/** Encrypted `provider/payload` event stored by the model invocation ledger. */
export const InvocationPayloadSchema = PayloadBase.extend({
  artifactId: Id,
  sha256: Hash,
  bytes: z.int().nonnegative(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
}).strict();

/** A `provider/payload` event whose encrypted body was purged after expiry. */
export const InvocationExpiredPayloadSchema = PayloadBase.extend({
  artifactId: Id,
  sha256: Hash,
  bytes: z.int().nonnegative(),
  expiredAt: AgentTimestampSchema,
}).strict();

/** Input for purging expired encrypted `provider/payload` bodies while keeping receipts intact. */
export const PurgeInvocationPayloadsInputSchema = z
  .object({
    /** Purge encrypted payloads whose event `occurredAt` is strictly earlier than this ISO timestamp. */
    before: AgentTimestampSchema,
    /** Restrict purge to one conversation; omit to purge across all conversations. */
    conversationId: Id.optional(),
    /** Maximum payload rows purged in one call (default 1 000, max 10 000). */
    limit: z.int().positive().max(10_000).optional(),
  })
  .strict();
export type PurgeInvocationPayloadsInput = z.infer<typeof PurgeInvocationPayloadsInputSchema>;

/** Structured summary returned by payload expiry purge operations. */
export const PurgeInvocationPayloadsResultSchema = z
  .object({
    purged: z.int().nonnegative(),
    freedBytes: z.int().nonnegative(),
    hasMore: z.boolean(),
  })
  .strict();
export type PurgeInvocationPayloadsResult = z.infer<
  typeof PurgeInvocationPayloadsResultSchema
>;

export type InvocationExpiredPayload = z.infer<typeof InvocationExpiredPayloadSchema>;

/** Parse an ISO expiry cutoff timestamp or throw `TypeError` when invalid. */
export function parsePayloadPurgeCutoff(before: string): number {
  const cutoffEpoch = Date.parse(before);
  if (Number.isNaN(cutoffEpoch)) {
    throw new TypeError(`Invalid payload expiry cutoff timestamp: ${JSON.stringify(before)}`);
  }
  return cutoffEpoch;
}

/**
 * Redact a live `provider/payload` record into its metadata-only expired record.
 * Returns `undefined` when the record is already redacted (`InvocationExpiredPayloadSchema`).
 */
export function redactLiveInvocationPayload(
  rawPayload: unknown,
  expiredAt: string,
): InvocationExpiredPayload | undefined {
  if (InvocationExpiredPayloadSchema.safeParse(rawPayload).success) return undefined;
  const live = InvocationPayloadSchema.parse(rawPayload);
  return InvocationExpiredPayloadSchema.parse({
    conversationId: live.conversationId,
    invocationId: live.invocationId,
    operationId: live.operationId,
    ...(live.runId !== undefined && { runId: live.runId }),
    artifactId: live.artifactId,
    sha256: live.sha256,
    bytes: live.bytes,
    expiredAt,
  });
}
