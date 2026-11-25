import { z } from 'zod';
import { ExecutorIdSchema, TurnOrdinalSchema } from './executor-contract';

/**
 * How much one hello may carry: far above what an executor reports, never unbounded, so a
 * handshake is refused by its own schema before any body limit has to.
 */
const HELLO_LIMITS = {
  profiles: 256,
  resumableTurns: 4096,
  credentialNames: 64,
  models: 1024,
  windows: 32,
  name: 256,
  text: 4096,
} as const;
const Name = z.string().min(1).max(HELLO_LIMITS.name);
const Text = z.string().min(1).max(HELLO_LIMITS.text);

/** Engines a driver of this module speaks. */
export const ExecutorEngineSchema = z.enum(['claude-cli', 'claude-sdk', 'codex', 'acp']);

/**
 * How the executor learns whether a turn it sent reached the engine:
 * `client-id` — the engine stores an id the executor chose and can be asked
 * for it; `none` — it cannot, so a send whose outcome is unknown stays unknown.
 */
export const ExecutorReconcileSchema = z.enum(['client-id', 'none']);

/** One rate-limit window reported by an engine for a subscription profile. */
export const PlanWindowSchema = z.strictObject({
  /** The window as the engine names it: `five_hour`, `weekly`, `primary`. */
  name: Name,
  usedPercent: z.number().min(0).max(100),
  resetsAt: z.iso.datetime({ offset: true }).optional(),
});

/**
 * A subscription's limits, as its source answers: `known` with windows,
 * `no-plan-limit` — the account has none, `unpublished` — the engine does not
 * say. `error` is the last read's failure, kept beside the last answer that
 * succeeded rather than replacing it; `observedAt` dates that answer.
 */
export const PlanLimitsSchema = z.strictObject({
  answer: z.enum(['known', 'no-plan-limit', 'unpublished']),
  windows: z.array(PlanWindowSchema).max(HELLO_LIMITS.windows),
  observedAt: z.iso.datetime({ offset: true }),
  error: Text.optional(),
});

/**
 * One account profile on the executor's machine. Private by construction: an
 * opaque id and the label its owner chose — no path, no environment, no token.
 */
export const ExecutorProfileSchema = z.strictObject({
  profileId: z.string().min(1).max(128),
  engine: ExecutorEngineSchema,
  accountLabel: z.string().min(1).max(200).optional(),
  login: z.strictObject({ state: z.enum(['signed-in', 'signed-out', 'expired', 'unknown']) }),
  /** What the engine would bill: the subscription, an API key, or nothing it can use. */
  effectiveCredential: z.enum(['subscription', 'api-key', 'none', 'unknown']),
  /** Names of credential variables found in the executor's own environment — never their values. */
  ownCredentials: z.array(Name).max(HELLO_LIMITS.credentialNames),
  planLimits: PlanLimitsSchema.optional(),
});

/** Capabilities and version reported for one engine installed on the executor. */
export const ExecutorEngineInfoSchema = z.strictObject({
  engine: ExecutorEngineSchema,
  version: Name,
  reconcile: ExecutorReconcileSchema,
  /**
   * The models the engine offers, as the driver found out: `listed` with their ids (an
   * empty list — the engine offers none), `not-asked` — this driver does not ask its
   * engine, or `failed` — asking failed, with why. Three facts, three answers.
   */
  models: z.discriminatedUnion('answer', [
    z.strictObject({
      answer: z.literal('listed'),
      ids: z.array(Name).max(HELLO_LIMITS.models),
    }),
    z.strictObject({ answer: z.literal('not-asked') }),
    z.strictObject({ answer: z.literal('failed'), error: Text }),
  ]),
});

/** A turn the executor was running before it restarted, with how far it reported. */
export const ExecutorResumableTurnSchema = z.strictObject({
  turnId: ExecutorIdSchema,
  threadId: ExecutorIdSchema,
  turnOrdinal: TurnOrdinalSchema,
  fence: z.int().positive(),
  executorSeq: z.int().nonnegative(),
});

/** Initial handshake message sent by an executor when connecting to the server. */
export const ExecutorHelloSchema = z.strictObject({
  protocol: z.literal(1),
  /** This executor process: a new value on every start, so a restart is never mistaken for the same process. */
  instance: z.string().min(1).max(128),
  executorId: z.string().min(1).max(128),
  /** One entry per engine at most. */
  engines: z.array(ExecutorEngineInfoSchema).max(ExecutorEngineSchema.options.length),
  profiles: z.array(ExecutorProfileSchema).max(HELLO_LIMITS.profiles),
  resumable: z.array(ExecutorResumableTurnSchema).max(HELLO_LIMITS.resumableTurns),
});

/**
 * What the server holds of one resumable turn: `acked` up to `ackedSeq` (0 — nothing yet), and the
 * executor resends what follows; `not-retained` — the server let the turn's receipt go and cannot
 * say what it holds, so nothing is resent.
 */
export const ExecutorResumeAckSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('acked'),
    turnId: ExecutorIdSchema,
    ackedSeq: z.int().nonnegative(),
  }),
  z.strictObject({ outcome: z.literal('not-retained'), turnId: ExecutorIdSchema }),
]);

/** Server acknowledgement of {@link ExecutorHelloSchema} with what it holds of each resumable turn. */
export const ExecutorHelloAckSchema = z.strictObject({
  protocol: z.literal(1),
  resumable: z.array(ExecutorResumeAckSchema).max(HELLO_LIMITS.resumableTurns),
});

/** Engine identifier supported by `agent-executor`. */
export type ExecutorEngine = z.infer<typeof ExecutorEngineSchema>;
/** Reported version, reconcile mode, and discovered models for one engine. */
export type ExecutorEngineInfo = z.infer<typeof ExecutorEngineInfoSchema>;
/** Executor-to-server handshake payload. */
export type ExecutorHello = z.infer<typeof ExecutorHelloSchema>;
/** Server-to-executor handshake acknowledgement payload. */
export type ExecutorHelloAck = z.infer<typeof ExecutorHelloAckSchema>;
/** A turn an executor resumes, inferred from {@link ExecutorResumableTurnSchema}. */
export type ExecutorResumableTurn = z.input<typeof ExecutorResumableTurnSchema>;
/** What the server holds of one resumable turn, inferred from {@link ExecutorResumeAckSchema}. */
export type ExecutorResumeAck = z.infer<typeof ExecutorResumeAckSchema>;
/** Public summary of one account profile carried in {@link ExecutorHello}. */
export type ExecutorProfile = z.infer<typeof ExecutorProfileSchema>;
/** Subscription plan limit answer and observed windows for a profile. */
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;
/** Single named utilization window inside {@link PlanLimits}. */
export type PlanWindow = z.infer<typeof PlanWindowSchema>;
