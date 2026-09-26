import { z } from 'zod';

export const AgentScheduleSchema = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    kind: z.enum(['at', 'after', 'every']),
    nextAt: z.iso.datetime({ offset: true }),
    intervalMs: z.int().positive().optional(),
    timeZone: z.string().min(1).optional(),
    input: z.json(),
    state: z.enum(['scheduled', 'cancelled', 'completed', 'failed']),
    occurrence: z.int().nonnegative(),
    attempts: z.int().nonnegative().optional(),
    retryAt: z.iso.datetime({ offset: true }).optional(),
    lastError: z.string().optional(),
    createdAt: z.iso.datetime({ offset: true }),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type AgentSchedule = z.infer<typeof AgentScheduleSchema>;

export interface AgentScheduleService {
  scheduleInput(request: {
    conversationId: string;
    input: z.infer<typeof z.json>;
    at?: string;
    afterMs?: number;
    everyMs?: number;
    timeZone?: string;
  }): Promise<AgentSchedule>;
  cancelSchedule(conversationId: string, id: string): Promise<boolean>;
  listSchedules(conversationId: string): readonly AgentSchedule[];
  tick(): Promise<void>;
  start(): void;
  close(): void;
}

const ScheduleRowSchema = z.object({
  id: z.string(),
  conversation_id: z.string(),
  kind: z.enum(['at', 'after', 'every']),
  next_at: z.string(),
  interval_ms: z.number().int().positive().nullable(),
  time_zone: z.string().nullable(),
  input_payload: z.string(),
  state: z.enum(['scheduled', 'cancelled', 'completed', 'failed']),
  occurrence: z.int().nonnegative(),
  attempts: z.int().nonnegative(),
  retry_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export function parseSchedule(raw: unknown): AgentSchedule {
  const row = ScheduleRowSchema.parse(raw);
  return AgentScheduleSchema.parse({
    id: row.id,
    conversationId: row.conversation_id,
    kind: row.kind,
    nextAt: row.next_at,
    ...(row.interval_ms !== null && { intervalMs: row.interval_ms }),
    ...(row.time_zone !== null && { timeZone: row.time_zone }),
    input: JSON.parse(row.input_payload),
    state: row.state,
    occurrence: row.occurrence,
    attempts: row.attempts,
    ...(row.retry_at !== null && { retryAt: row.retry_at }),
    ...(row.last_error !== null && { lastError: row.last_error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

export const AgentScheduleDeliveryOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('retry'), reason: z.string().min(1) }).strict(),
  z.object({ status: z.literal('terminal'), reason: z.string().min(1) }).strict(),
]);
export type AgentScheduleDeliveryOutcome = z.infer<typeof AgentScheduleDeliveryOutcomeSchema>;
