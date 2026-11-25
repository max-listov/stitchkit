import { z } from 'zod';
import {
  DeliveredEventPayloadSchema,
  EffectEventPayloadSchema,
  ParkEventPayloadSchema,
  StepEventPayloadSchema,
} from '../durability/contract';
import type { AgentStoreEventKind } from '../durability/events';
import type { BranchIdentities } from './branch-identities';
import { branchOpaqueJson } from './branch-messages';
import {
  ChildSpawnedEventPayloadSchema,
  ChildStateEventPayloadSchema,
} from './children-contract';
import {
  InvocationFinishedSchema,
  InvocationPayloadReceiptSchema,
  InvocationRequestSchema,
  InvocationResponseSchema,
  InvocationStartedSchema,
} from './invocation-schema';
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
/** Shared payload schema for `spill/created` and `spill/deleted` events. */
export const SpillEventPayloadSchema = z
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
const Rejection = z
  .object({ approvalId: Id, callId: Id, toolName: Id, reason: z.string() })
  .strict();

type Json = z.infer<ReturnType<typeof z.json>>;

/** Every kind the branch handles as an event of its own, before any observation. */
type TransferredKind =
  | 'runtime/baseline'
  | 'runtime/branched'
  | 'runtime/branch-observation'
  | 'runtime/transition'
  | 'provider/message';
type ObservedKind = Exclude<AgentStoreEventKind, TransferredKind>;
type ObservationRule = (
  ids: BranchIdentities,
  raw: Json,
  kind: ObservedKind,
  inherited: boolean,
) => Json;

function durability(ids: BranchIdentities, raw: Json, kind: ObservedKind) {
  const value =
    kind === 'durability/step'
      ? StepEventPayloadSchema.parse(raw)
      : kind === 'durability/park'
        ? ParkEventPayloadSchema.parse(raw)
        : kind === 'durability/event'
          ? DeliveredEventPayloadSchema.parse(raw)
          : EffectEventPayloadSchema.parse(raw);
  if (canonicalAgentJson(value) !== canonicalAgentJson(raw))
    throw new TypeError('Branch cannot rekey opaque durability payload');
  const encoded =
    'encoded' in value
      ? JSON.stringify(branchOpaqueJson(ids, z.json().parse(JSON.parse(value.encoded))))
      : undefined;
  return {
    ...value,
    ...(encoded !== undefined && { encoded }),
    runId: ids.reference('run', value.runId),
    ...('id' in value && { id: ids.define('key', value.id) }),
  };
}

function spill(ids: BranchIdentities, raw: Json) {
  const value = SpillEventPayloadSchema.parse(raw);
  return { ...value, reference: ids.reference('spill', value.reference) };
}

function schedule(ids: BranchIdentities, raw: Json) {
  const value = Schedule.parse(raw);
  return { ...value, id: ids.define('schedule', value.id) };
}

function rekeyChildConversation(ids: BranchIdentities, conversationId: string): string {
  return conversationId === ids.sourceConversationId
    ? ids.conversationId
    : ids.define('child', conversationId);
}

function childSpawned(ids: BranchIdentities, raw: Json): Json {
  const value = ChildSpawnedEventPayloadSchema.parse(raw);
  return {
    ...value,
    childConversationId: rekeyChildConversation(ids, value.childConversationId),
  };
}

function childState(ids: BranchIdentities, raw: Json): Json {
  const value = ChildStateEventPayloadSchema.parse(raw);
  if ('action' in value) {
    if (value.action === 'blocking-presented') {
      return {
        ...value,
        input: branchOpaqueJson(ids, value.input),
        childConversationId: rekeyChildConversation(ids, value.childConversationId),
        approvalId: ids.define('approval', value.approvalId),
        childApprovalId: ids.define('approval', value.childApprovalId),
        callId: ids.define('call', value.callId),
        batchId: ids.define('key', value.batchId),
      };
    }
    if (value.action === 'blocking-resolved') {
      return {
        ...value,
        childConversationId: rekeyChildConversation(ids, value.childConversationId),
        approvalId: ids.define('approval', value.approvalId),
        batchId: ids.define('key', value.batchId),
      };
    }
    return {
      ...value,
      childConversationId: rekeyChildConversation(ids, value.childConversationId),
    };
  }
  return {
    ...value,
    ...(value.childConversationId && {
      childConversationId: rekeyChildConversation(ids, value.childConversationId),
    }),
    ...(value.parentConversationId && {
      parentConversationId: rekeyChildConversation(ids, value.parentConversationId),
    }),
    ...(value.resultReference && {
      resultReference: ids.reference('spill', value.resultReference),
    }),
  };
}

/**
 * A model invocation record is a receipt of a call a conversation made, and
 * crosses as that record: it keeps naming the conversation and run that made
 * the call, which is also what its encrypted body is bound to. A record taken
 * from the source's own ledger must belong to the source and name one of its
 * runs; one already carried by an earlier branch names that earlier source and
 * crosses as it is.
 */
function invocation<T extends { conversationId: string; runId?: string | undefined }>(
  ids: BranchIdentities,
  value: T,
  inherited: boolean,
) {
  if (inherited) return value;
  if (value.conversationId !== ids.sourceConversationId)
    throw new TypeError('Branch invocation record belongs to another conversation');
  if (value.runId !== undefined) ids.reference('run', value.runId);
  return value;
}

/** The payload's identity, size and hash cross; its encrypted body stays with the source. */
function invocationPayload(ids: BranchIdentities, raw: Json, inherited: boolean) {
  const {
    iv: _iv,
    tag: _tag,
    ciphertext: _body,
    ...receipt
  } = InvocationPayloadReceiptSchema.parse(raw);
  return invocation(ids, receipt, inherited);
}

const retry: ObservationRule = (_ids, raw) => Retry.parse(raw);

/**
 * One rule per event kind a conversation can hold. A kind added to the
 * vocabulary without a rule here does not compile, so a conversation that used
 * a new capability of the runtime cannot become unbranchable by omission.
 */
const OBSERVATION_RULES = {
  'durability/step': durability,
  'durability/park': durability,
  'durability/event': durability,
  'durability/effect': durability,
  'sandbox/probed': (_ids, raw) =>
    z
      .object({
        result: AgentSandboxGradeSchema,
        required: z.array(AgentSandboxRestrictionSchema),
        missing: z.array(AgentSandboxRestrictionSchema),
      })
      .strict()
      .parse(raw),
  'state/set': (ids, raw) => {
    const value = State.parse(raw);
    return { ...value, value: branchOpaqueJson(ids, value.value) };
  },
  'retry/scheduled': retry,
  'retry/started': retry,
  'spill/created': spill,
  'spill/deleted': spill,
  'schedule/set': schedule,
  'schedule/fired': schedule,
  'schedule/cancelled': schedule,
  'schedule/late': schedule,
  'schedule/failed': schedule,
  'child/spawned': childSpawned,
  'child/state': childState,
  'approval/response-rejected': (ids, raw) => {
    const value = Rejection.parse(raw);
    return {
      ...value,
      approvalId: ids.reference('approval', value.approvalId),
      callId: ids.reference('call', value.callId),
    };
  },
  'invocation/started': (ids, raw, _kind, inherited) =>
    invocation(ids, InvocationStartedSchema.parse(raw), inherited),
  'invocation/finished': (ids, raw, _kind, inherited) =>
    invocation(ids, InvocationFinishedSchema.parse(raw), inherited),
  // The provider journal's records of these two kinds are rekeyed as the
  // journal they are; only the invocation ledger's reach this table.
  'provider/request': (ids, raw, _kind, inherited) =>
    invocation(ids, InvocationRequestSchema.parse(raw), inherited),
  'provider/response': (ids, raw, _kind, inherited) =>
    invocation(ids, InvocationResponseSchema.parse(raw), inherited),
  'provider/payload': (ids, raw, _kind, inherited) => invocationPayload(ids, raw, inherited),
} satisfies Record<ObservedKind, ObservationRule>;

function isObservedKind(kind: string): kind is ObservedKind {
  return Object.hasOwn(OBSERVATION_RULES, kind);
}

/** Control observations are retained under an inert kind: no state/schedule/durability reader can replay them. */
export function branchObservation(
  ids: BranchIdentities,
  kind: string,
  raw: Json,
  inherited = false,
) {
  if (!isObservedKind(kind)) {
    ids.refuse({
      code: 'event-kind-unknown',
      message: `Branch cannot rekey opaque event kind ${kind}`,
    });
    return raw;
  }
  return OBSERVATION_RULES[kind](ids, raw, kind, inherited);
}

const Defines = z
  .object({
    id: Id.optional(),
    childConversationId: Id.optional(),
    parentConversationId: Id.optional(),
    approvalId: Id.optional(),
    childApprovalId: Id.optional(),
    callId: Id.optional(),
    batchId: Id.optional(),
  })
  .passthrough();

/**
 * The identities an observation defines — keys, schedules, children and the
 * approvals they present — named before any value is judged, as the rules
 * above define them. A malformed payload defines nothing here; its rule
 * refuses it when the event is read.
 */
export function collectObservationDefinitions(ids: BranchIdentities, kind: string, raw: Json) {
  const value = Defines.safeParse(raw);
  if (!value.success) return;
  const {
    id,
    childConversationId,
    parentConversationId,
    approvalId,
    childApprovalId,
    callId,
    batchId,
  } = value.data;
  if (kind.startsWith('durability/') && id) ids.define('key', id);
  if (kind.startsWith('schedule/') && id) ids.define('schedule', id);
  if (!kind.startsWith('child/')) return;
  for (const child of [childConversationId, parentConversationId])
    if (child && child !== ids.sourceConversationId) ids.define('child', child);
  if (approvalId) ids.define('approval', approvalId);
  if (childApprovalId) ids.define('approval', childApprovalId);
  if (callId) ids.define('call', callId);
  if (batchId) ids.define('key', batchId);
}

export const BranchObservationSchema = z
  .object({ sourceKind: Id, payload: z.json() })
  .strict();
