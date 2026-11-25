import { z } from 'zod';

/**
 * The blocks a message is made of — text, reasoning, files, sources, tool calls
 * and results, approvals, provider envelopes — in one vocabulary the agent
 * runtime and the agent executor both speak.
 *
 * Neither owns it: the runtime stores these blocks in its messages, the
 * executor streams them as deltas from an engine. Kept in one neutral part, a
 * block means the same thing on both sides, and no third copy appears.
 */

/** A provider's own payload, carried opaquely. */
export const AgentProviderEnvelopeSchema = z.object({
  schemaVersion: z.int().positive(),
  provider: z.string().min(1),
  data: z.record(z.string(), z.json()),
});

export type AgentProviderEnvelope = z.infer<typeof AgentProviderEnvelopeSchema>;

export const AgentTextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

export const AgentReasoningPartSchema = z.object({
  type: z.literal('reasoning'),
  text: z.string(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentFilePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().min(1),
  reference: z.string().min(1),
  filename: z.string().min(1).optional(),
});

export const AgentSourcePartSchema = z.object({
  type: z.literal('source'),
  sourceId: z.string().min(1),
  url: z.url().optional(),
  title: z.string().optional(),
});

export const AgentToolCallPartSchema = z.object({
  type: z.literal('tool-call'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.json(),
  provider: AgentProviderEnvelopeSchema.optional(),
});

export const AgentToolResultPartSchema = z.object({
  type: z.literal('tool-result'),
  callId: z.string().min(1),
  toolName: z.string().min(1),
  outcome: z.enum(['success', 'error', 'interrupted']),
  output: z.json().optional(),
});

export const AgentToolApprovalRequestPartSchema = z.object({
  type: z.literal('tool-approval-request'),
  approvalId: z.string().min(1),
  callId: z.string().min(1),
  isAutomatic: z.boolean().optional(),
  signature: z.string().min(1).optional(),
});

export const AgentToolApprovalResponsePartSchema = z.object({
  type: z.literal('tool-approval-response'),
  approvalId: z.string().min(1),
  approved: z.boolean(),
  reason: z.string().min(1).optional(),
});

export const AgentOpaquePartSchema = z.object({
  type: z.literal('provider'),
  envelope: AgentProviderEnvelopeSchema,
});

export const AgentControlPartSchema = z.object({
  type: z.literal('control'),
  reason: z.enum(['run-interrupted', 'stale-run']),
});

export const AgentMessagePartSchema = z.discriminatedUnion('type', [
  AgentTextPartSchema,
  AgentReasoningPartSchema,
  AgentFilePartSchema,
  AgentSourcePartSchema,
  AgentToolCallPartSchema,
  AgentToolResultPartSchema,
  AgentToolApprovalRequestPartSchema,
  AgentToolApprovalResponsePartSchema,
  AgentOpaquePartSchema,
  AgentControlPartSchema,
]);

export type AgentMessagePart = z.infer<typeof AgentMessagePartSchema>;
