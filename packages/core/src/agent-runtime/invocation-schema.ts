import { z } from 'zod';
import { AgentUsageSchema } from './schemas';

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
        temperature: z.number().finite().optional(),
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
      artifactId: Id,
      tools: z.int().nonnegative(),
    })
    .strict(),
}).strict();
export const InvocationResponseSchema = Attempt.extend({
  type: z.literal('provider/response'),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  effective: Identity,
  usage: AgentUsageSchema,
  artifactId: Id,
  payloadSha256: Hash,
}).strict();
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
export const InvocationPayloadSchema = Base.extend({
  artifactId: Id,
  sha256: Hash,
  bytes: z.int().nonnegative(),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
}).strict();
