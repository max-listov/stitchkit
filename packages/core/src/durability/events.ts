import { z } from 'zod';

/**
 * The canonical event log's vocabulary: the envelope every ledger record has,
 * what an append carries and how a page is read.
 *
 * It lives beside the durability engine rather than inside `agent-runtime`
 * because it is what the engine's two-method ledger speaks: an application that
 * backs `createLocalStepDurability` with its own database implements these
 * shapes and never imports the agent runtime. The agent store is one ledger
 * that speaks them — the kinds below are its vocabulary, and the durability
 * kinds are three of them. → ADR 0187, ADR 0197.
 */
export const AgentStoreEventKindSchema = z.enum([
  'runtime/baseline',
  'runtime/transition',
  'provider/request',
  'provider/response',
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
  'approval/response-rejected',
  'durability/step',
  'durability/park',
  'durability/event',
]);

export type AgentStoreEventKind = z.infer<typeof AgentStoreEventKindSchema>;

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
