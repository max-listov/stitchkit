import { z } from 'zod';
import { AgentTimestampSchema, AgentUsageSchema } from './schemas';
import {
  InvocationExpiredPayloadSchema,
  InvocationPayloadSchema,
} from './schemas-invocation-payload';

const Id = z.string().min(1).max(512);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export const ModelInvocationTraceSchema = z
  .object({
    operationId: Id,
    purpose: Id,
    project: Id,
    parent: z.object({ traceId: Id, invocationId: Id.optional() }).strict().optional(),
    experiment: Id.optional(),
    case: Id.optional(),
    profile: Id.optional(),
  })
  .strict();
export type ModelInvocationTrace = z.infer<typeof ModelInvocationTraceSchema>;

export const CompletionInvocationInputSchema = z
  .object({
    conversationId: Id,
    idempotencyKey: Id,
    trace: ModelInvocationTraceSchema,
    prompt: z.string().min(1),
    /** Ordered attempts. Repeating a key explicitly requests a retry of that model. */
    models: z.array(Id).min(1).max(8),
    settings: z
      .object({
        maxOutputTokens: z.int().positive().optional(),
        temperature: z.number().optional(),
        topP: z.number().min(0).max(1).optional(),
        seed: z.int().optional(),
      })
      .strict()
      .optional(),
    timeoutMs: z.int().positive().max(3_600_000),
  })
  .strict();
export type CompletionInvocationInput = z.infer<typeof CompletionInvocationInputSchema>;

const Identity = z
  .object({
    provider: Id.nullable(),
    modelId: Id.nullable(),
    responseId: Id.nullable(),
  })
  .strict();
export const InvocationCallerSchema = z.object({ subject: Id }).strict();
export const InvocationProcessSchema = z
  .object({
    instanceId: Id,
    pid: z.int().positive(),
    hostname: Id,
  })
  .strict();
const Base = z.object({
  conversationId: Id,
  invocationId: Id,
  operationId: Id,
  runId: Id.optional(),
});
export const InvocationStartedSchema = Base.extend({
  type: z.literal('invocation/started'),
  mode: z.enum(['completion', 'agent']),
  trace: ModelInvocationTraceSchema,
  caller: InvocationCallerSchema,
  executingProcess: InvocationProcessSchema,
  fingerprint: Hash,
  requested: z.object({ models: z.array(Id), payloadSha256: Hash }).strict(),
}).strict();
export const InvocationAttemptContextSchema = Base.extend({
  attemptId: Id,
  step: z.int().nonnegative(),
}).strict();
export type ModelInvocationAttemptContext = z.infer<typeof InvocationAttemptContextSchema>;

/** Structured reason why a request or response payload artifact was intentionally omitted. */
export const InvocationPayloadOmissionReasonSchema = z.enum(['max-payload-bytes']);
export type InvocationPayloadOmissionReason = z.infer<
  typeof InvocationPayloadOmissionReasonSchema
>;

const Attempt = Base.extend({ attemptId: Id, step: z.int().nonnegative() });
export const InvocationRequestSchema = Attempt.extend({
  type: z.literal('provider/request'),
  requested: z.object({ modelId: Id, provider: Id }).strict(),
  executingProcess: InvocationProcessSchema,
  sent: z
    .object({
      modelId: Id,
      provider: Id,
      payloadSha256: Hash,
      artifactId: Id.optional(),
      payloadOmitted: InvocationPayloadOmissionReasonSchema.optional(),
      tools: z.int().nonnegative(),
    })
    .strict()
    .superRefine((sent, ctx) => {
      const hasArtifact = sent.artifactId !== undefined;
      const hasOmitted = sent.payloadOmitted !== undefined;
      if (hasArtifact === hasOmitted) {
        ctx.addIssue({
          code: 'custom',
          message:
            'provider/request sent requires exactly one of artifactId or payloadOmitted',
        });
      }
    }),
}).strict();
export const InvocationResponseSchema = Attempt.extend({
  type: z.literal('provider/response'),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  effective: Identity,
  usage: AgentUsageSchema,
  artifactId: Id.optional(),
  payloadOmitted: InvocationPayloadOmissionReasonSchema.optional(),
  payloadSha256: Hash,
})
  .strict()
  .superRefine((response, ctx) => {
    const hasArtifact = response.artifactId !== undefined;
    const hasOmitted = response.payloadOmitted !== undefined;
    if (hasArtifact === hasOmitted) {
      ctx.addIssue({
        code: 'custom',
        message: 'provider/response requires exactly one of artifactId or payloadOmitted',
      });
    }
  });
export const InvocationFinishedSchema = Base.extend({
  type: z.literal('invocation/finished'),
  failure: z.object({ artifactId: Id, payloadSha256: Hash }).strict().optional(),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
}).strict();
export const ModelInvocationRecordSchema = z.discriminatedUnion('type', [
  InvocationStartedSchema,
  InvocationRequestSchema,
  InvocationResponseSchema,
  InvocationFinishedSchema,
]);
export type ModelInvocationRecord = z.infer<typeof ModelInvocationRecordSchema>;

export const InvocationStoredPayloadSchema = z.union([
  InvocationPayloadSchema,
  InvocationExpiredPayloadSchema,
]);

/**
 * What remains of a payload artifact outside the conversation that made the
 * call: its identity, size, hash, and optional expiry timestamp. Rejects
 * malformed partial cipher records or records carrying both ciphertext and `expiredAt`.
 */
export const InvocationPayloadReceiptSchema = Base.extend({
  artifactId: Id,
  sha256: Hash,
  bytes: z.int().nonnegative(),
  iv: z.string().optional(),
  tag: z.string().optional(),
  ciphertext: z.string().optional(),
  expiredAt: AgentTimestampSchema.optional(),
})
  .strict()
  .superRefine((value, ctx) => {
    const cipherParts = [value.iv, value.tag, value.ciphertext].filter(
      (p) => p !== undefined,
    ).length;
    if (cipherParts > 0 && cipherParts < 3) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invocation payload receipt has incomplete encryption fields',
      });
    }
    if (cipherParts > 0 && value.expiredAt !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invocation payload receipt cannot carry both ciphertext and expiredAt',
      });
    }
  });

/** Discriminated read result returned by `ModelInvocationLedger.readPayload`. */
export const ModelInvocationPayloadReadSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('available'),
      artifactId: Id,
      sha256: Hash,
      bytes: z.int().nonnegative(),
      payload: z.json(),
    })
    .strict(),
  z
    .object({
      status: z.literal('expired'),
      artifactId: Id,
      sha256: Hash,
      bytes: z.int().nonnegative(),
      expiredAt: AgentTimestampSchema,
    })
    .strict(),
]);
export type ModelInvocationPayloadRead = z.infer<typeof ModelInvocationPayloadReadSchema>;

/**
 * Whether a `provider/request` or `provider/response` payload is a record of
 * this ledger. The provider journal writes the same two kinds in its own shape,
 * without an invocation. The ledger reader and the branch tell them apart here.
 */
export function isModelInvocationRecord(payload: unknown): boolean {
  return payload !== null && typeof payload === 'object' && 'invocationId' in payload;
}
