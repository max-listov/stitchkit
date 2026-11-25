import { z } from 'zod';
import type { AgentStoreEventEnvelope } from '../durability/events';
import type { AgentCompanionHost } from './companion-host';
import { InvocationResponseSchema, isModelInvocationRecord } from './invocation-schema';
import { addUsage, statedUsage, unknownUsage } from './runtime-internals';
import {
  AgentTerminalReasonSchema,
  type AgentUsage,
  AgentUsageSchema,
  runStateForTerminalReason,
} from './schemas';
import { SqlIntegerSchema } from './sql-rows';
import type { AgentRuntimeStore } from './store';

export interface AgentProjectionDefinition<STATE> {
  name: string;
  version: number;
  initial(): STATE;
  fold(state: STATE, event: AgentStoreEventEnvelope): STATE;
  schema: z.ZodType<STATE>;
}

export interface AgentProjectionValue<STATE> {
  name: string;
  version: number;
  uptoSeq: number;
  updatedAt: string;
  value: STATE;
}

export function defineAgentProjection<STATE>(
  definition: AgentProjectionDefinition<STATE>,
): AgentProjectionDefinition<STATE> {
  if (definition.name.length === 0) throw new TypeError('Projection name must not be empty');
  if (!Number.isInteger(definition.version) || definition.version < 1) {
    throw new TypeError('Projection version must be a positive integer');
  }
  definition.schema.parse(definition.initial());
  return definition;
}

export function createAgentProjectionRegistry(
  definitions: readonly AgentProjectionDefinition<unknown>[],
): ReadonlyMap<string, AgentProjectionDefinition<unknown>> {
  const registry = new Map<string, AgentProjectionDefinition<unknown>>();
  for (const definition of definitions) {
    const previous = registry.get(definition.name);
    if (previous) throw new TypeError(`Duplicate agent projection: ${definition.name}`);
    registry.set(definition.name, definition);
  }
  return registry;
}

const ProjectionRowSchema = z.object({
  conversation_id: z.string().optional(),
  version: SqlIntegerSchema.pipe(z.int().positive()),
  upto_seq: SqlIntegerSchema.pipe(z.int().nonnegative()),
  payload: z.string(),
  updated_at: z.string(),
});

function projectionPayload(value: string): unknown {
  return JSON.parse(value);
}

/**
 * Folded views of a conversation's events, kept in a SQL store's companion
 * host — SQLite or Postgres — and advanced from where they stopped.
 */
export function createAgentProjectionStore(input: {
  store: AgentRuntimeStore;
  /** The store's companion host: `host` of the SQLite or Postgres store. */
  host: AgentCompanionHost;
}) {
  const { host, store } = input;
  const projections = host.tables.projections;
  const load = async <STATE>(
    conversationId: string,
    definition: AgentProjectionDefinition<STATE>,
  ): Promise<AgentProjectionValue<STATE> | undefined> => {
    const raw = await host.read((session) =>
      session.get(
        `SELECT version, upto_seq, payload, updated_at FROM ${projections}
         WHERE conversation_id = ? AND name = ?`,
        [conversationId, definition.name],
      ),
    );
    if (raw === undefined) return undefined;
    const row = ProjectionRowSchema.parse(raw);
    if (row.version !== definition.version) return undefined;
    return {
      name: definition.name,
      version: row.version,
      uptoSeq: row.upto_seq,
      updatedAt: row.updated_at,
      value: definition.schema.parse(projectionPayload(row.payload)),
    };
  };

  const advance = async <STATE>(
    conversationId: string,
    definition: AgentProjectionDefinition<STATE>,
  ): Promise<AgentProjectionValue<STATE>> => {
    const current = await load(conversationId, definition);
    let value = current?.value ?? definition.initial();
    let uptoSeq = current?.uptoSeq ?? 0;
    let cursor = uptoSeq + 1;
    let updatedAt = current?.updatedAt ?? new Date(0).toISOString();
    for (;;) {
      const page = await store.readEvents({
        conversationId,
        fromSeq: cursor,
        limit: 1_000,
      });
      for (const event of page.items) {
        value = definition.schema.parse(definition.fold(value, event));
        uptoSeq = event.seq;
        updatedAt = event.occurredAt;
      }
      if (page.nextSeq === undefined) break;
      cursor = page.nextSeq;
    }
    // Two advances of one projection can run at once, each folding from what
    // it read. The one that folded less must not overwrite the one that folded
    // more: the row moves only forward, or to a new projection version.
    await host.transaction(conversationId, async (scope) => {
      await scope.run(
        `INSERT INTO ${projections}
           (conversation_id, name, version, upto_seq, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (conversation_id, name) DO UPDATE SET
           version = excluded.version,
           upto_seq = excluded.upto_seq,
           payload = excluded.payload,
           updated_at = excluded.updated_at
         WHERE ${projections}.version <> excluded.version
           OR excluded.upto_seq >= ${projections}.upto_seq`,
        [
          conversationId,
          definition.name,
          definition.version,
          uptoSeq,
          JSON.stringify(value),
          updatedAt,
        ],
      );
    });
    return { name: definition.name, version: definition.version, uptoSeq, updatedAt, value };
  };

  const list = async <STATE>(
    definition: AgentProjectionDefinition<STATE>,
  ): Promise<
    readonly {
      conversationId: string;
      projection: AgentProjectionValue<STATE>;
    }[]
  > =>
    (
      await host.read((session) =>
        session.all(
          `SELECT conversation_id, version, upto_seq, payload, updated_at FROM ${projections}
           WHERE name = ? AND version = ? ORDER BY updated_at DESC, conversation_id`,
          [definition.name, definition.version],
        ),
      )
    ).map((raw) => {
      const row = ProjectionRowSchema.parse(raw);
      if (!row.conversation_id)
        throw new TypeError('Projection list row has no conversation id');
      return {
        conversationId: row.conversation_id,
        projection: {
          name: definition.name,
          version: row.version,
          uptoSeq: row.upto_seq,
          updatedAt: row.updated_at,
          value: definition.schema.parse(projectionPayload(row.payload)),
        },
      };
    });

  return { load, advance, list };
}

const ConversationCardSchema = z.object({
  eventCount: z.int().nonnegative(),
  lastKind: z.string().optional(),
  lastOccurredAt: z.string().optional(),
});

export const agentConversationCardProjection = defineAgentProjection({
  name: 'conversation-card',
  version: 1,
  schema: ConversationCardSchema,
  initial: () => ({ eventCount: 0 }),
  fold: (state, event) => ({
    eventCount: state.eventCount + 1,
    lastKind: event.kind,
    lastOccurredAt: event.occurredAt,
  }),
});

const StateSlotsProjectionSchema = z.record(z.string(), z.json());

export const agentStateSlotsProjection = defineAgentProjection({
  name: 'state-slots',
  version: 1,
  schema: StateSlotsProjectionSchema,
  initial: () => ({}),
  fold: (state, event) => {
    if (event.kind !== 'state/set') return state;
    const payload = z
      .looseObject({ name: z.string().min(1), value: z.json() })
      .parse(event.payload);
    return { ...state, [payload.name]: payload.value };
  },
});

const ScheduleSummarySchema = z.object({
  scheduled: z.int().nonnegative(),
  fired: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
  late: z.int().nonnegative(),
});

export const agentScheduleSummaryProjection = defineAgentProjection({
  name: 'schedule-summary',
  version: 1,
  schema: ScheduleSummarySchema,
  initial: () => ({ scheduled: 0, fired: 0, cancelled: 0, late: 0 }),
  fold: (state, event) => {
    if (event.kind === 'schedule/set') return { ...state, scheduled: state.scheduled + 1 };
    if (event.kind === 'schedule/fired') return { ...state, fired: state.fired + 1 };
    if (event.kind === 'schedule/cancelled')
      return { ...state, cancelled: state.cancelled + 1 };
    if (event.kind === 'schedule/late') return { ...state, late: state.late + 1 };
    return state;
  },
});

const RuntimeSummarySchema = z
  .object({
    eventCount: z.int().nonnegative(),
    lastSeq: z.int().nonnegative(),
    lastKind: z.string().optional(),
    lastOccurredAt: z.string().optional(),
    lastModelId: z.string().optional(),
  })
  .strict();

/** Small list-card state derived only from the canonical ledger. */
export const agentSummaryProjection = defineAgentProjection({
  name: 'summary',
  version: 2,
  schema: RuntimeSummarySchema,
  initial: (): z.infer<typeof RuntimeSummarySchema> => ({ eventCount: 0, lastSeq: 0 }),
  fold: (state, event) => {
    // An audited request records what was sent under `sent`; an unaudited one
    // carries `modelId` at the top.
    const request =
      event.kind === 'provider/request'
        ? z
            .looseObject({
              modelId: z.string().optional(),
              sent: z.looseObject({ modelId: z.string() }).optional(),
            })
            .transform((payload) => ({ modelId: payload.modelId ?? payload.sent?.modelId }))
            .safeParse(event.payload)
        : undefined;
    return {
      eventCount: state.eventCount + 1,
      lastSeq: event.seq,
      lastKind: event.kind,
      lastOccurredAt: event.occurredAt,
      ...(request?.success && request.data.modelId
        ? { lastModelId: request.data.modelId }
        : state.lastModelId
          ? { lastModelId: state.lastModelId }
          : {}),
    };
  },
});

function hasMeasuredUsage(usage: AgentUsage | undefined): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens.value !== undefined ||
    usage.outputTokens.value !== undefined ||
    usage.reasoningTokens?.value !== undefined ||
    usage.cacheReadTokens?.value !== undefined ||
    usage.cacheWriteTokens?.value !== undefined ||
    usage.cost?.value !== undefined
  );
}

const TerminalUsageTransitionSchema = z.looseObject({
  type: z.literal('terminal'),
  input: z.looseObject({
    reason: AgentTerminalReasonSchema.optional(),
    usage: AgentUsageSchema.optional(),
    assistant: z.looseObject({ parts: z.array(z.unknown()) }).optional(),
  }),
});

const RecoverUsageTransitionSchema = z.looseObject({
  type: z.literal('recover'),
  input: z.looseObject({ action: z.literal('abandon') }),
  usage: AgentUsageSchema.optional(),
});

function eventUsage(event: AgentStoreEventEnvelope): AgentUsage | undefined {
  if (event.kind === 'runtime/transition') {
    const terminal = TerminalUsageTransitionSchema.safeParse(event.payload);
    if (terminal.success) {
      const { assistant, reason, usage } = terminal.data.input;
      // A run that did not complete, measured nothing and holds no provider output spent
      // nothing: a refused connection, an oversized context, a cancel before the request.
      // Counting it as unknown would hide every paid run of the conversation. One part of
      // an answer is enough to mean a provider spoke, and then the unknown is real.
      const answered =
        reason === undefined ||
        runStateForTerminalReason(reason) === 'completed' ||
        assistant === undefined ||
        assistant.parts.length > 0;
      if (!answered && !hasMeasuredUsage(usage)) return undefined;
      return statedUsage(usage);
    }
    const abandoned = RecoverUsageTransitionSchema.safeParse(event.payload);
    if (abandoned.success && hasMeasuredUsage(abandoned.data.usage)) {
      return statedUsage(abandoned.data.usage);
    }
    return undefined;
  }
  if (event.kind === 'provider/response' && isModelInvocationRecord(event.payload)) {
    const parsed = InvocationResponseSchema.safeParse(event.payload);
    // An audited agent run carries `runId` on every step response and commits
    // one run total on `runtime/transition` (`type: 'terminal'`); folding both
    // would double-count the run.
    if (!parsed.success || parsed.data.runId !== undefined) return undefined;
    if (parsed.data.status !== 'succeeded' && !hasMeasuredUsage(parsed.data.usage)) {
      return undefined;
    }
    return parsed.data.usage;
  }
  return undefined;
}

const RuntimeUsageSchema = z.strictObject({
  records: z.int().nonnegative(),
  usage: AgentUsageSchema,
});

/**
 * Conversation spend folded from canonical ledger records with per-field provenance.
 *
 * Folds terminal `runtime/transition` (`type: 'terminal'`), abandoned runs
 * (`type: 'recover'`, `action: 'abandon'`) that carry measured checkpointed usage,
 * and standalone `provider/response` invocation receipts (`runId === undefined`).
 * A run that did not complete, carries no measured value and holds no part of a provider
 * answer is skipped, as is a non-succeeded standalone attempt with no measured values:
 * neither heard from a provider, so neither turns conversation cost into `unavailable`.
 *
 * Only ledger events after any `runtime/baseline` migration are folded; pre-baseline
 * spend is not reconstructed. If a `history.compact` callback runs standalone
 * `createModelInvocationLedger().complete()` on the same `conversationId`, do not
 * also return that completion's `usage` from `compact()`, or both the standalone
 * `provider/response` and the run's terminal transition will be counted.
 */
export const agentUsageProjection = defineAgentProjection({
  name: 'usage',
  version: 2,
  schema: RuntimeUsageSchema,
  initial: (): z.infer<typeof RuntimeUsageSchema> => ({
    records: 0,
    usage: unknownUsage(),
  }),
  fold: (state, event) => {
    const usage = eventUsage(event);
    if (!usage) return state;
    return {
      records: state.records + 1,
      usage: statedUsage(addUsage(state.records === 0 ? undefined : state.usage, usage)),
    };
  },
});

const RuntimeOutlineSchema = z
  .object({
    requests: z.array(
      z
        .object({
          seq: z.int().positive(),
          occurredAt: z.string(),
          runId: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/** Address-only outline; opening details remains a bounded event read. */
export const agentOutlineProjection = defineAgentProjection({
  name: 'outline',
  version: 1,
  schema: RuntimeOutlineSchema,
  initial: () => ({ requests: [] }),
  fold: (state, event) => {
    if (event.kind !== 'provider/request') return state;
    const payload = z.looseObject({ runId: z.string().optional() }).parse(event.payload);
    return {
      requests: [
        ...state.requests,
        {
          seq: event.seq,
          occurredAt: event.occurredAt,
          ...(payload.runId && { runId: payload.runId }),
        },
      ],
    };
  },
});
