import { z } from 'zod';
import type { SqliteAgentRuntimeStore } from './sqlite';
import type { AgentStoreEventEnvelope } from './store-events';

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
  version: z.int().positive(),
  upto_seq: z.int().nonnegative(),
  payload: z.string(),
  updated_at: z.string(),
});

function projectionPayload(value: string): unknown {
  return JSON.parse(value);
}

export function createSqliteAgentProjectionStore(input: { sqlite: SqliteAgentRuntimeStore }) {
  const database = input.sqlite.database;
  const store = input.sqlite.store;
  const load = <STATE>(
    conversationId: string,
    definition: AgentProjectionDefinition<STATE>,
  ) => {
    const raw = database
      .prepare(`
        SELECT version, upto_seq, payload, updated_at
        FROM stitchkit_agent_runtime_projections
        WHERE conversation_id = ? AND name = ?
      `)
      .get(conversationId, definition.name);
    if (raw === null || raw === undefined) return undefined;
    const row = ProjectionRowSchema.parse(raw);
    if (row.version !== definition.version) return undefined;
    return {
      name: definition.name,
      version: row.version,
      uptoSeq: row.upto_seq,
      updatedAt: row.updated_at,
      value: definition.schema.parse(projectionPayload(row.payload)),
    } satisfies AgentProjectionValue<STATE>;
  };

  const advance = async <STATE>(
    conversationId: string,
    definition: AgentProjectionDefinition<STATE>,
  ): Promise<AgentProjectionValue<STATE>> => {
    const current = load(conversationId, definition);
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
    await input.sqlite.transaction(async (scope) => {
      scope.database
        .prepare(`
          INSERT INTO stitchkit_agent_runtime_projections
            (conversation_id, name, version, upto_seq, payload, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (conversation_id, name) DO UPDATE SET
            version = excluded.version,
            upto_seq = excluded.upto_seq,
            payload = excluded.payload,
            updated_at = excluded.updated_at
        `)
        .run(
          conversationId,
          definition.name,
          definition.version,
          uptoSeq,
          JSON.stringify(value),
          updatedAt,
        );
    });
    return { name: definition.name, version: definition.version, uptoSeq, updatedAt, value };
  };

  const list = <STATE>(
    definition: AgentProjectionDefinition<STATE>,
  ): readonly {
    conversationId: string;
    projection: AgentProjectionValue<STATE>;
  }[] =>
    database
      .prepare(`
        SELECT conversation_id, version, upto_seq, payload, updated_at
        FROM stitchkit_agent_runtime_projections
        WHERE name = ? AND version = ? ORDER BY updated_at DESC, conversation_id
      `)
      .all(definition.name, definition.version)
      .map((raw) => {
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
      .object({ name: z.string().min(1), value: z.json() })
      .passthrough()
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
  version: 1,
  schema: RuntimeSummarySchema,
  initial: (): z.infer<typeof RuntimeSummarySchema> => ({ eventCount: 0, lastSeq: 0 }),
  fold: (state, event) => {
    const request =
      event.kind === 'provider/request'
        ? z.object({ modelId: z.string().optional() }).passthrough().safeParse(event.payload)
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

const RuntimeUsageSchema = z
  .object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
    cost: z.number().nonnegative(),
    sources: z.array(z.string()),
  })
  .strict();

/** Usage totals keep their source names so an unavailable price never becomes zero-cost. */
export const agentUsageProjection = defineAgentProjection({
  name: 'usage',
  version: 1,
  schema: RuntimeUsageSchema,
  initial: () => ({ inputTokens: 0, outputTokens: 0, cost: 0, sources: [] }),
  fold: (state, event) => {
    const parsed = z
      .object({
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        cost: z.number().nonnegative().optional(),
        source: z.string().min(1).optional(),
      })
      .passthrough()
      .safeParse(event.payload);
    if (!parsed.success) return state;
    const source = parsed.data.source;
    return {
      inputTokens: state.inputTokens + (parsed.data.inputTokens ?? 0),
      outputTokens: state.outputTokens + (parsed.data.outputTokens ?? 0),
      cost: state.cost + (parsed.data.cost ?? 0),
      sources:
        source && !state.sources.includes(source) ? [...state.sources, source] : state.sources,
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
    const payload = z
      .object({ runId: z.string().optional() })
      .passthrough()
      .parse(event.payload);
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
