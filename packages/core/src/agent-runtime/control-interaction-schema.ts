import { z } from 'zod';
import { AgentTimestampSchema } from './schemas-records';

/** Runtime permission mode advertised or selected for an interactive agent session. */
export const AgentPermissionModeSchema = z.enum(['default', 'plan', 'accept-edits', 'auto']);
/** Runtime permission mode inferred from `AgentPermissionModeSchema`. */
export type AgentPermissionMode = z.infer<typeof AgentPermissionModeSchema>;

/** Reachability state of the executor host running a conversation. */
export const AgentHostStatusSchema = z.enum(['online', 'offline', 'asleep', 'unknown']);
/** Executor host reachability inferred from `AgentHostStatusSchema`. */
export type AgentHostStatus = z.infer<typeof AgentHostStatusSchema>;

/** Observed host reachability with optional conservative lease expiry and diagnostic reason. */
export const AgentHostAvailabilitySchema = z.strictObject({
  status: AgentHostStatusSchema,
  validUntil: AgentTimestampSchema.optional(),
  reason: z.string().min(1).optional(),
  observedAt: AgentTimestampSchema.optional(),
});
/** Observed host reachability inferred from `AgentHostAvailabilitySchema`. */
export type AgentHostAvailability = z.infer<typeof AgentHostAvailabilitySchema>;

/** Pending tool approval descriptor presented to the browser for an explicit decision. */
export const AgentPendingApprovalSchema = z.strictObject({
  approvalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  callId: z.string().min(1).optional(),
  toolName: z.string().min(1),
  input: z.json().optional(),
  summary: z.string().min(1).optional(),
  requestedAt: AgentTimestampSchema.optional(),
  signature: z.string().min(1).optional(),
});
/** Pending tool approval descriptor inferred from `AgentPendingApprovalSchema`. */
export type AgentPendingApproval = z.infer<typeof AgentPendingApprovalSchema>;

/** One selectable option inside a structured user-input question. */
export const AgentInputOptionSchema = z.strictObject({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
});
/** Selectable input option inferred from `AgentInputOptionSchema`. */
export type AgentInputOption = z.infer<typeof AgentInputOptionSchema>;

/** One structured question inside a `waiting-input` prompt. */
export const AgentInputQuestionSchema = z.strictObject({
  id: z.string().min(1),
  prompt: z.string().min(1),
  header: z.string().min(1).optional(),
  multiSelect: z.boolean().optional(),
  allowFreeText: z.boolean().optional(),
  secret: z.boolean().optional(),
  options: z.array(AgentInputOptionSchema).optional(),
});
/** Structured input question inferred from `AgentInputQuestionSchema`. */
export type AgentInputQuestion = z.infer<typeof AgentInputQuestionSchema>;

/** Pending interactive input request awaiting a user answer. */
export const AgentPendingInputSchema = z.strictObject({
  inputId: z.string().min(1),
  runId: z.string().min(1).optional(),
  prompt: z.string().min(1),
  questions: z.array(AgentInputQuestionSchema).optional(),
  requestedAt: AgentTimestampSchema.optional(),
});
/** Pending interactive input request inferred from `AgentPendingInputSchema`. */
export type AgentPendingInput = z.infer<typeof AgentPendingInputSchema>;

/** Strict answer payload submitted for a pending interactive input request. */
export const AgentInputAnswerSchema = z.strictObject({
  text: z.string().optional(),
  answers: z.record(z.string().min(1), z.union([z.string(), z.array(z.string())])).optional(),
  cancelled: z.boolean().optional(),
});
/** Structured user-input answer inferred from `AgentInputAnswerSchema`. */
export type AgentInputAnswer = z.infer<typeof AgentInputAnswerSchema>;

/** Mutating browser control operations whose wire delivery may settle as `unknown` on drop. */
export const AgentWriteOperationSchema = z.enum([
  'submit',
  'respond-approval',
  'respond-input',
  'set-permission-mode',
]);
/** Mutating browser control operation inferred from `AgentWriteOperationSchema`. */
export type AgentWriteOperation = z.infer<typeof AgentWriteOperationSchema>;

/** Delivery reconciliation outcome for a mutating request (`unknown` blocks blind retries). */
export const AgentControlDeliveryOutcomeSchema = z.enum(['confirmed', 'rejected', 'unknown']);
/** Delivery reconciliation outcome inferred from `AgentControlDeliveryOutcomeSchema`. */
export type AgentControlDeliveryOutcome = z.infer<typeof AgentControlDeliveryOutcomeSchema>;

/** Pending write delivery record retained until reconciled after a mid-flight disconnect. */
export const AgentPendingDeliverySchema = z.strictObject({
  delivery: AgentControlDeliveryOutcomeSchema,
  requestId: z.string().min(1),
  operation: AgentWriteOperationSchema,
  idempotencyKey: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
  recordedAt: AgentTimestampSchema.optional(),
});
/** Pending write delivery record inferred from `AgentPendingDeliverySchema`. */
export type AgentPendingDelivery = z.infer<typeof AgentPendingDeliverySchema>;

/** Underlying conversation activity independent of remote host reachability. */
export const AgentConversationActivitySchema = z.enum([
  'idle',
  'working',
  'waiting-approval',
  'waiting-input',
]);
/** Underlying conversation activity inferred from `AgentConversationActivitySchema`. */
export type AgentConversationActivity = z.infer<typeof AgentConversationActivitySchema>;

/** Effective UI-facing conversation state including `host-offline` reachability overlay. */
export const AgentConversationStateSchema = z.enum([
  'idle',
  'working',
  'waiting-approval',
  'waiting-input',
  'host-offline',
]);
/** Effective UI-facing conversation state inferred from `AgentConversationStateSchema`. */
export type AgentConversationState = z.infer<typeof AgentConversationStateSchema>;
