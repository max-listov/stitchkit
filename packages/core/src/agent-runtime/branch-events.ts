import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import { AgentConversationBranchReceiptSchema } from './branch-contract';
import type { BranchIdentities } from './branch-identities';
import { branchMessage, branchRun } from './branch-messages';
import { BranchObservationSchema, branchObservation } from './branch-observations';
import { BranchProvider } from './branch-provider';
import { BranchBaselineSchema, branchTransition } from './branch-replay';
import { branchJson, rekeyBranchTransition } from './branch-transitions';
import type { AgentMessage } from './schemas';
import { canonicalAgentJson } from './store-events';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);

export function rekeyBranchEvents(
  ids: BranchIdentities,
  source: string,
  events: readonly AgentStoreEventEnvelope[],
  retainedMessages: ReadonlyMap<string, AgentMessage> = new Map(),
) {
  const hydrated = events.map((event) => {
    const assistant = retainedMessages.get(event.eventId);
    if (!assistant) return event;
    ids.collectMessage(assistant);
    const operation =
      event.kind === 'runtime/transition' ? branchTransition(event) : undefined;
    if (
      operation?.type === 'recover' &&
      operation.input.action === 'abandon' &&
      !operation.assistant
    )
      return { ...event, payload: branchJson({ ...operation, assistant }) };
    return event;
  });
  for (const event of hydrated) collectBranchEvent(ids, event);
  for (const assistant of hydrated.flatMap((event) =>
    retainedMessages.has(event.eventId) ? [retainedMessages.get(event.eventId)] : [],
  )) {
    if (assistant) branchMessage(ids, source, assistant);
  }
  const provider = new BranchProvider(ids);
  return hydrated.map((event) => rekeyBranchEvent(ids, source, event, provider));
}

export function collectBranchEvent(ids: BranchIdentities, event: AgentStoreEventEnvelope) {
  ids.define('event', event.eventId);
  if (event.schemaVersion !== 1)
    throw new TypeError('Branch requires a supported event version');
  if (event.kind === 'runtime/transition') ids.collectOperation(branchTransition(event));
  if (event.kind === 'runtime/baseline') {
    const baseline = BranchBaselineSchema.parse(event.payload);
    if (canonicalAgentJson(baseline) !== canonicalAgentJson(event.payload))
      throw new TypeError('Branch baseline contains an unknown opaque field');
    for (const record of baseline.runs) ids.collectRun(record.run);
    for (const message of baseline.messages) ids.collectMessage(message);
  }
}

export function rekeyBranchEvent(
  ids: BranchIdentities,
  source: string,
  event: AgentStoreEventEnvelope,
  provider: BranchProvider,
): AgentStoreEventEnvelope {
  const envelope = {
    ...event,
    eventId: ids.reference('event', event.eventId),
    conversationId: ids.conversationId,
  };
  const message = (value: Parameters<typeof branchMessage>[2]) =>
    branchMessage(ids, source, value);
  if (event.kind === 'runtime/transition') {
    const operation = branchTransition(event);
    const rekeyed = rekeyBranchTransition(ids, source, operation);
    // Full terminal messages settle the hash-only checkpoints; preserve their
    // source digest instead of claiming it hashes a nonexistent rekeyed draft.
    const raw = z
      .object({
        type: z.string(),
        input: z
          .object({
            assistant: z
              .object({
                sha256: Hash.optional(),
                sourceSha256: Hash.optional(),
                bytes: z.int(),
                parts: z.int(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough()
      .safeParse(event.payload);
    if (operation.type === 'checkpoint' && raw.success && rekeyed.type === 'checkpoint') {
      const draft = raw.data.input.assistant;
      return {
        ...envelope,
        payload: branchJson({
          type: 'checkpoint',
          input: {
            ...rekeyed.input,
            assistant: {
              id: rekeyed.input.assistant.id,
              status: 'streaming',
              sourceSha256: draft.sha256 ?? draft.sourceSha256,
              parts: draft.parts,
              bytes: draft.bytes,
            },
          },
        }),
      };
    }
    // Parsing must not silently erase an unknown payload field.
    if (canonicalAgentJson(operation) !== canonicalAgentJson(event.payload))
      throw new TypeError('Branch transition contains an unknown opaque field');
    return { ...envelope, payload: branchJson(rekeyed) };
  }
  if (event.kind === 'runtime/baseline') {
    const baseline = BranchBaselineSchema.parse(event.payload);
    return {
      ...envelope,
      payload: branchJson({
        ...baseline,
        head: { ...baseline.head, conversationId: ids.conversationId },
        messages: baseline.messages.map(message),
        ...(baseline.compacted && {
          compacted: baseline.compacted.map((id) => ids.reference('message', id)),
        }),
        runs: baseline.runs.map((record) => ({
          ...record,
          run: branchRun(ids, source, record.run, false),
          ...(record.terminalAssistant && {
            terminalAssistant: message(record.terminalAssistant),
          }),
        })),
        admissions: baseline.admissions.map((receipt) => ({
          ...receipt,
          conversationId: ids.conversationId,
          idempotencyKey: ids.define('key', receipt.idempotencyKey),
          input: message(receipt.input),
          runId: ids.reference('run', receipt.runId),
          assistantMessageId: ids.reference('message', receipt.assistantMessageId),
        })),
      }),
    };
  }
  if (event.kind === 'runtime/branched') {
    const receipt = AgentConversationBranchReceiptSchema.parse(event.payload);
    return {
      ...envelope,
      payload: branchJson({
        ...receipt,
        conversationId: ids.conversationId,
        requestKey: ids.define('key', receipt.requestKey),
      }),
    };
  }
  if (
    event.kind === 'provider/message' ||
    event.kind === 'provider/request' ||
    event.kind === 'provider/response'
  )
    return { ...envelope, payload: branchJson(provider.rekey(event.kind, event.payload)) };
  const observation =
    event.kind === 'runtime/branch-observation'
      ? BranchObservationSchema.parse(event.payload)
      : { sourceKind: event.kind, payload: event.payload };
  return {
    ...envelope,
    kind: 'runtime/branch-observation',
    payload: branchJson({
      sourceKind: observation.sourceKind,
      payload: branchObservation(ids, observation.sourceKind, observation.payload),
    }),
  };
}
