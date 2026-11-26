import { z } from 'zod';
import { assertPositiveSafeInteger } from '../../internal/positive-integer';
import { PlanWindowSchema } from '../hello';
import {
  ExecutorErrorKindSchema,
  ExecutorStartupPhaseSchema,
  ExecutorThreadDispositionSchema,
} from '../vocabulary';

export const DEFAULT_REPLAY_MAX_BYTES = 4 * 1024 * 1024;
export const DEFAULT_REPLAY_MAX_STEPS = 4_096;

const NonEmpty = z.string().min(1).max(256);
const LabelSchema = z.string().trim().min(1).max(128);
const NonNegativeInt = z.int().nonnegative();

const EmitTextStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.enum(['text', 'reasoning']),
  text: z.string(),
  itemId: NonEmpty.optional(),
});

const EmitToolCallStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.literal('tool-call'),
  callId: NonEmpty,
  toolName: NonEmpty,
  input: z.json(),
  itemId: NonEmpty.optional(),
});

const EmitToolResultStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.literal('tool-result'),
  callId: NonEmpty,
  toolName: NonEmpty,
  outcome: z.enum(['success', 'error', 'interrupted']),
  output: z.json().optional(),
  itemId: NonEmpty.optional(),
});

const EmitStatusStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.literal('status'),
  phase: ExecutorStartupPhaseSchema,
  itemId: NonEmpty.optional(),
});

const EmitWindowStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.literal('window'),
  reset: z.enum(['initial', 'gap', 'generation', 'context']),
  itemId: NonEmpty.optional(),
});

const EmitErrorStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.literal('error'),
  errorKind: ExecutorErrorKindSchema,
  message: z.string().min(1).max(4096),
  itemId: NonEmpty.optional(),
});

const EmitTurnEndStepSchema = z.strictObject({
  kind: z.literal('emit'),
  block: z.literal('turn-end'),
  outcome: z.enum(['completed', 'interrupted', 'failed']),
  threadDisposition: ExecutorThreadDispositionSchema.optional(),
  itemId: NonEmpty.optional(),
});

const RequestStepSchema = z.strictObject({
  kind: z.literal('request'),
  interactionId: NonEmpty,
  requestKind: z.enum(['approval', 'input']),
  callId: NonEmpty.optional(),
  toolName: NonEmpty.optional(),
  input: z.json().optional(),
  prompt: z.string().optional(),
  itemId: NonEmpty.optional(),
});

const ExpectReplyStepSchema = z.strictObject({
  kind: z.literal('expectReply'),
  interactionId: NonEmpty,
  replyKind: z.enum(['approve', 'deny', 'input']).optional(),
  scope: z.enum(['once', 'session']).optional(),
  required: z.boolean().optional(),
});

const GateStepSchema = z.strictObject({
  kind: z.literal('gate'),
  label: LabelSchema,
});

const WaitInterruptStepSchema = z.strictObject({
  kind: z.literal('waitInterrupt'),
});

const UsageStepSchema = z.strictObject({
  kind: z.literal('usage'),
  inputTokens: NonNegativeInt.optional(),
  outputTokens: NonNegativeInt.optional(),
  cachedInputTokens: NonNegativeInt.optional(),
  cacheCreationInputTokens: NonNegativeInt.optional(),
  thinkingTokens: NonNegativeInt.optional(),
  totalTokens: NonNegativeInt.optional(),
  costUsd: z.number().nonnegative().optional(),
  itemId: NonEmpty.optional(),
});

const ContextUsageStepSchema = z.strictObject({
  kind: z.literal('contextUsage'),
  usedTokens: NonNegativeInt,
  windowTokens: NonNegativeInt,
  itemId: NonEmpty.optional(),
});

const RateLimitStepSchema = z.strictObject({
  kind: z.literal('rateLimit'),
  windows: z.array(PlanWindowSchema).max(32),
});

const UnknownRecordStepSchema = z.strictObject({
  kind: z.literal('unknownRecord'),
  recordType: NonEmpty.optional(),
  message: z.string().min(1).max(4096).optional(),
});

const InvalidLineStepSchema = z.strictObject({
  kind: z.literal('invalidLine'),
  rawLine: z.string().optional(),
});

const EofWithoutResultStepSchema = z.strictObject({
  kind: z.literal('eofWithoutResult'),
});

const CrashStepSchema = z.strictObject({
  kind: z.literal('crash'),
  message: z.string().min(1).max(4096).optional(),
});

/** Single scripted step inside an in-process executor replay transcript. */
export const ExecutorReplayStepSchema = z.union([
  EmitTextStepSchema,
  EmitToolCallStepSchema,
  EmitToolResultStepSchema,
  EmitStatusStepSchema,
  EmitWindowStepSchema,
  EmitErrorStepSchema,
  EmitTurnEndStepSchema,
  RequestStepSchema,
  ExpectReplyStepSchema,
  GateStepSchema,
  WaitInterruptStepSchema,
  UsageStepSchema,
  ContextUsageStepSchema,
  RateLimitStepSchema,
  UnknownRecordStepSchema,
  InvalidLineStepSchema,
  EofWithoutResultStepSchema,
  CrashStepSchema,
]);

/** Validated sequence of deterministic replay steps for a single turn. */
export const ExecutorReplayTranscriptSchema = z.strictObject({
  steps: z.array(ExecutorReplayStepSchema).max(DEFAULT_REPLAY_MAX_STEPS),
});

/** Single scripted replay step inferred from {@link ExecutorReplayStepSchema}. */
export type ExecutorReplayStep = z.infer<typeof ExecutorReplayStepSchema>;
/** Validated single-turn replay transcript inferred from {@link ExecutorReplayTranscriptSchema}. */
export type ExecutorReplayTranscript = z.infer<typeof ExecutorReplayTranscriptSchema>;

/** Options for {@link parseReplayTranscript}. */
export interface ParseReplayTranscriptOptions {
  /** Substitute literal `<workspace>` tokens inside parsed string values with this path. */
  readonly workspace?: string;
  /** Maximum UTF-8 byte length accepted for the NDJSON source. Default 4 MiB. */
  readonly maxBytes?: number;
  /** Maximum number of replay steps accepted. Default 4096. */
  readonly maxSteps?: number;
}

const UTF8_ENCODER = new TextEncoder();

function substituteWorkspace(value: unknown, workspace: string): unknown {
  if (typeof value === 'string') {
    return value.includes('<workspace>') ? value.replaceAll('<workspace>', workspace) : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteWorkspace(item, workspace));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = substituteWorkspace(entry, workspace);
    }
    return out;
  }
  return value;
}

/**
 * Parse and strictly validate an NDJSON replay transcript within finite byte and step limits.
 * Blank lines are skipped; `<workspace>` placeholders are substituted inside JSON string values.
 */
export function parseReplayTranscript(
  ndjson: string,
  options: ParseReplayTranscriptOptions = {},
): ExecutorReplayTranscript {
  const maxBytes = options.maxBytes ?? DEFAULT_REPLAY_MAX_BYTES;
  const maxSteps = options.maxSteps ?? DEFAULT_REPLAY_MAX_STEPS;
  assertPositiveSafeInteger('maxBytes', maxBytes);
  assertPositiveSafeInteger('maxSteps', maxSteps);
  if (maxBytes > DEFAULT_REPLAY_MAX_BYTES) {
    throw new RangeError(
      `Replay transcript maxBytes (${maxBytes}) exceeds hard ceiling (${DEFAULT_REPLAY_MAX_BYTES})`,
    );
  }
  if (maxSteps > DEFAULT_REPLAY_MAX_STEPS) {
    throw new RangeError(
      `Replay transcript maxSteps (${maxSteps}) exceeds hard ceiling (${DEFAULT_REPLAY_MAX_STEPS})`,
    );
  }
  const actualBytes = UTF8_ENCODER.encode(ndjson).byteLength;
  if (actualBytes > maxBytes) {
    throw new RangeError(
      `Replay transcript size (${actualBytes} bytes) exceeds limit (${maxBytes} bytes)`,
    );
  }
  const steps: ExecutorReplayStep[] = [];
  const lines = ndjson.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (line.length === 0) continue;
    if (steps.length >= maxSteps) {
      throw new RangeError(`Replay transcript exceeds step limit (${maxSteps})`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(
        `Invalid JSON in replay transcript on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const hydrated =
      options.workspace !== undefined
        ? substituteWorkspace(decoded, options.workspace)
        : decoded;
    steps.push(ExecutorReplayStepSchema.parse(hydrated));
  }
  return { steps };
}

/** Serialize an array of replay steps into canonical NDJSON text. */
export function formatReplayTranscript(steps: readonly ExecutorReplayStep[]): string {
  return steps.map((step) => JSON.stringify(ExecutorReplayStepSchema.parse(step))).join('\n');
}
