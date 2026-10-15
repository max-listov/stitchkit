import { z } from 'zod';
import {
  DeliveredEventPayloadSchema,
  EffectEventPayloadSchema,
  ParkEventPayloadSchema,
  StepEventPayloadSchema,
} from '../durability/contract';
import type { BranchIdentities } from './branch-identities';
import { branchOpaqueJson } from './branch-messages';
import { AgentSandboxGradeSchema, AgentSandboxRestrictionSchema } from './sandbox';
import { canonicalAgentJson } from './store-events';

const Id = z.string().min(1);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const State = z
  .object({
    name: Id,
    version: z.int().positive(),
    value: z.json(),
    actor: z.enum(['agent', 'human', 'system']),
  })
  .strict();
const Retry = z
  .object({
    attempt: z.int().positive(),
    delayMs: z.number().nonnegative().optional(),
    reason: z.string().optional(),
  })
  .strict();
const Spill = z
  .object({ reference: Id, bytes: z.int().nonnegative(), sha256: Hash.optional() })
  .strict();
const Schedule = z
  .object({
    id: Id,
    kind: z.enum(['at', 'after', 'every']).optional(),
    nextAt: z.string().nullable().optional(),
    occurrence: z.int().nonnegative().optional(),
    lateByMs: z.number().nonnegative().optional(),
    state: z.string().optional(),
    message: z.string().optional(),
    attempts: z.int().nonnegative().optional(),
    retryAt: z.string().nullable().optional(),
    terminal: z.boolean().optional(),
    skipped: z.boolean().optional(),
  })
  .strict();
const Child = z
  .object({
    childConversationId: Id.optional(),
    parentConversationId: Id.optional(),
    seedUptoSeq: z.int().nonnegative().optional(),
    budget: z.json().optional(),
    state: z.string().optional(),
    resultReference: Id.optional(),
    reason: z.string().optional(),
    action: z.enum(['message-sent', 'blocking-presented', 'blocking-resolved']).optional(),
    approvalId: Id.optional(),
    childApprovalId: Id.optional(),
    callId: Id.optional(),
    toolName: Id.optional(),
    input: z.json().optional(),
    batchId: Id.optional(),
    kind: z.string().optional(),
    presentedAt: z.string().optional(),
    approved: z.boolean().optional(),
  })
  .strict();
const Rejection = z
  .object({ approvalId: Id, callId: Id, toolName: Id, reason: z.string() })
  .strict();

/** Control observations are retained under an inert kind: no state/schedule/durability reader can replay them. */
export function branchObservation(
  ids: BranchIdentities,
  kind: string,
  raw: z.infer<ReturnType<typeof z.json>>,
) {
  if (kind.startsWith('durability/')) {
    const value =
      kind === 'durability/step'
        ? StepEventPayloadSchema.parse(raw)
        : kind === 'durability/park'
          ? ParkEventPayloadSchema.parse(raw)
          : kind === 'durability/event'
            ? DeliveredEventPayloadSchema.parse(raw)
            : kind === 'durability/effect'
              ? EffectEventPayloadSchema.parse(raw)
              : undefined;
    if (!value || canonicalAgentJson(value) !== canonicalAgentJson(raw))
      throw new TypeError('Branch cannot rekey opaque durability payload');
    if ('encoded' in value) branchOpaqueJson(z.json().parse(JSON.parse(value.encoded)));
    return {
      ...value,
      runId: ids.reference('run', value.runId),
      ...('id' in value && { id: ids.define('key', value.id) }),
    };
  }
  if (kind === 'sandbox/probed')
    return z
      .object({
        result: AgentSandboxGradeSchema,
        required: z.array(AgentSandboxRestrictionSchema),
        missing: z.array(AgentSandboxRestrictionSchema),
      })
      .strict()
      .parse(raw);
  if (kind === 'state/set') {
    const value = State.parse(raw);
    branchOpaqueJson(value.value);
    return value;
  }
  if (kind === 'retry/scheduled' || kind === 'retry/started') return Retry.parse(raw);
  if (kind === 'spill/created' || kind === 'spill/deleted') {
    const value = Spill.parse(raw);
    return { ...value, reference: ids.reference('spill', value.reference) };
  }
  if (kind.startsWith('schedule/')) {
    const value = Schedule.parse(raw);
    return { ...value, id: ids.define('schedule', value.id) };
  }
  if (kind.startsWith('child/')) {
    const value = Child.parse(raw);
    if (value.budget) branchOpaqueJson(value.budget);
    if (value.input) branchOpaqueJson(value.input);
    return {
      ...value,
      ...(value.childConversationId && {
        childConversationId:
          value.childConversationId === ids.sourceConversationId
            ? ids.conversationId
            : ids.define('child', value.childConversationId),
      }),
      ...(value.parentConversationId && {
        parentConversationId:
          value.parentConversationId === ids.sourceConversationId
            ? ids.conversationId
            : ids.define('child', value.parentConversationId),
      }),
      ...(value.resultReference && {
        resultReference: ids.reference('spill', value.resultReference),
      }),
      ...(value.approvalId && { approvalId: ids.define('approval', value.approvalId) }),
      ...(value.childApprovalId && {
        childApprovalId: ids.define('approval', value.childApprovalId),
      }),
      ...(value.callId && { callId: ids.reference('call', value.callId) }),
      ...(value.batchId && { batchId: ids.define('key', value.batchId) }),
    };
  }
  if (kind === 'approval/response-rejected') {
    const value = Rejection.parse(raw);
    return {
      ...value,
      approvalId: ids.reference('approval', value.approvalId),
      callId: ids.reference('call', value.callId),
    };
  }
  throw new TypeError(`Branch cannot rekey opaque event kind ${kind}`);
}

export const BranchObservationSchema = z
  .object({ sourceKind: Id, payload: z.json() })
  .strict();
