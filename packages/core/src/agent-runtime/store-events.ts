import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AcceptInputAndAssignRunSchema,
  AcquireAgentRunSchema,
  CheckpointRunAssistantSchema,
  CommitRunTerminalSchema,
  RecordRunOperationSchema,
  RecoverAgentRunSchema,
  ReplaceCompactedRangeSchema,
  RequestRunInterruptSchema,
} from './store';

export const AgentStoreEventKindSchema = z.enum([
  'runtime/baseline',
  'runtime/transition',
  'provider/request',
  'provider/message',
  'state/set',
  'spill/created',
  'spill/deleted',
  'schedule/set',
  'schedule/fired',
  'schedule/cancelled',
  'schedule/late',
  'schedule/failed',
  'child/spawned',
  'child/state',
  'retry/scheduled',
  'retry/started',
  'sandbox/probed',
]);

export type AgentStoreEventKind = z.infer<typeof AgentStoreEventKindSchema>;

export const AgentStoreTransitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('accept'), input: AcceptInputAndAssignRunSchema }).strict(),
  z.object({ type: z.literal('acquire'), input: AcquireAgentRunSchema }).strict(),
  z.object({ type: z.literal('checkpoint'), input: CheckpointRunAssistantSchema }).strict(),
  z.object({ type: z.literal('operation'), input: RecordRunOperationSchema }).strict(),
  z.object({ type: z.literal('interrupt'), input: RequestRunInterruptSchema }).strict(),
  z.object({ type: z.literal('recover'), input: RecoverAgentRunSchema }).strict(),
  z.object({ type: z.literal('terminal'), input: CommitRunTerminalSchema }).strict(),
  z.object({ type: z.literal('compact'), input: ReplaceCompactedRangeSchema }).strict(),
]);

export type AgentStoreTransition = z.infer<typeof AgentStoreTransitionSchema>;

export const AgentStoreEventEnvelopeSchema = z
  .object({
    schemaVersion: z.int().positive(),
    eventId: z.string().min(1),
    conversationId: z.string().min(1),
    seq: z.int().positive(),
    kind: z.string().min(1),
    occurredAt: z.iso.datetime({ offset: true }),
    payload: z.json(),
    ignorable: z.literal(true).optional(),
  })
  .strict();

export type AgentStoreEventEnvelope = z.infer<typeof AgentStoreEventEnvelopeSchema>;

export const AppendAgentStoreEventSchema = z
  .object({
    conversationId: z.string().min(1),
    kind: AgentStoreEventKindSchema,
    occurredAt: z.iso.datetime({ offset: true }).optional(),
    payload: z.json(),
    ignorable: z.literal(true).optional(),
  })
  .strict();

export type AppendAgentStoreEvent = z.infer<typeof AppendAgentStoreEventSchema>;

export const ReadAgentStoreEventsSchema = z
  .object({
    conversationId: z.string().min(1),
    fromSeq: z.int().positive().optional(),
    toSeq: z.int().positive().optional(),
    limit: z.int().positive().max(10_000).default(1_000),
  })
  .strict()
  .refine(
    (input) =>
      input.fromSeq === undefined || input.toSeq === undefined || input.fromSeq <= input.toSeq,
    { message: 'fromSeq must not exceed toSeq' },
  );

export type ReadAgentStoreEvents = z.infer<typeof ReadAgentStoreEventsSchema>;

export const AgentStoreEventPageSchema = z
  .object({
    items: z.array(AgentStoreEventEnvelopeSchema),
    nextSeq: z.int().positive().optional(),
  })
  .strict();

export type AgentStoreEventPage = z.infer<typeof AgentStoreEventPageSchema>;

export type AgentStoreEventDraft = Omit<AgentStoreEventEnvelope, 'seq'>;

export interface AgentStoreEventDecodeAccepted {
  outcome: 'accepted';
  event: AgentStoreEventEnvelope;
}

export interface AgentStoreEventDecodeIgnored {
  outcome: 'ignored';
  eventId: string;
  conversationId: string;
  seq: number;
  schemaVersion: number;
  kind: string;
}

export type AgentStoreEventDecodeResult =
  | AgentStoreEventDecodeAccepted
  | AgentStoreEventDecodeIgnored;

const CURRENT_EVENT_SCHEMA_VERSION = 1;

/**
 * Validate one event without silently widening the vocabulary.
 *
 * `ignorable` applies to an unknown kind or envelope version as a whole. It
 * never turns an extra field in a known envelope into accepted data.
 */
export function decodeAgentStoreEvent(value: unknown): AgentStoreEventDecodeResult {
  const envelope = AgentStoreEventEnvelopeSchema.parse(value);
  const knownVersion = envelope.schemaVersion === CURRENT_EVENT_SCHEMA_VERSION;
  const knownKind = AgentStoreEventKindSchema.safeParse(envelope.kind).success;
  if (knownVersion && knownKind) return { outcome: 'accepted', event: envelope };
  if (!envelope.ignorable) {
    throw new TypeError(
      `Unsupported agent store event at ${envelope.conversationId}:${envelope.seq} ` +
        `(${envelope.eventId}): schema ${envelope.schemaVersion}, kind ${envelope.kind}`,
    );
  }
  return {
    outcome: 'ignored',
    eventId: envelope.eventId,
    conversationId: envelope.conversationId,
    seq: envelope.seq,
    schemaVersion: envelope.schemaVersion,
    kind: envelope.kind,
  };
}

export function agentStoreEventDraft(input: AppendAgentStoreEvent): AgentStoreEventDraft {
  const parsed = AppendAgentStoreEventSchema.parse(input);
  return {
    schemaVersion: CURRENT_EVENT_SCHEMA_VERSION,
    eventId: randomUUID(),
    conversationId: parsed.conversationId,
    kind: parsed.kind,
    occurredAt: parsed.occurredAt ?? new Date().toISOString(),
    payload: parsed.payload,
    ...(parsed.ignorable && { ignorable: true }),
  };
}

function canonicalJsonValue(value: z.infer<typeof z.json>): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  const record = z.record(z.string(), z.json()).parse(value);
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`)
    .join(',')}}`;
}

/** Stable UTF-8 JSON used by archives, digests and byte-for-byte round trips. */
export function canonicalAgentJson(value: unknown): string {
  return canonicalJsonValue(z.json().parse(value));
}

export const AgentConversationArchiveSchema = z
  .object({
    format: z.literal('stitchkit.agent-conversation'),
    formatVersion: z.literal(1),
    conversationId: z.string().min(1),
    events: z.array(AgentStoreEventEnvelopeSchema),
    projections: z.array(z.json()).default([]),
    spills: z.array(z.json()).default([]),
  })
  .strict();

export type AgentConversationArchive = z.infer<typeof AgentConversationArchiveSchema>;

export function encodeAgentConversationArchive(archive: AgentConversationArchive): Uint8Array {
  const parsed = AgentConversationArchiveSchema.parse(archive);
  return new TextEncoder().encode(canonicalAgentJson(parsed));
}

export function decodeAgentConversationArchive(bytes: Uint8Array): AgentConversationArchive {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const archive = AgentConversationArchiveSchema.parse(value);
  let previous = 0;
  const ids = new Set<string>();
  for (const event of archive.events) {
    if (event.conversationId !== archive.conversationId) {
      throw new TypeError('Conversation archive contains an event for another conversation');
    }
    if (event.seq <= previous)
      throw new TypeError('Conversation archive event sequence is not increasing');
    if (ids.has(event.eventId))
      throw new TypeError('Conversation archive contains a duplicate event id');
    decodeAgentStoreEvent(event);
    previous = event.seq;
    ids.add(event.eventId);
  }
  return archive;
}
