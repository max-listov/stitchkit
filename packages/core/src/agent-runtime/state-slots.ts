import { z } from 'zod';
import type { AgentRuntimeStore } from './store';

export interface AgentStateSlotDefinition<VALUE> {
  name: string;
  version: number;
  schema: z.ZodType<VALUE>;
  description?: string;
}

export interface AgentStateSlotValue {
  name: string;
  version: number;
  value: unknown;
  updatedAt: string;
  seq: number;
}

export type AnyAgentStateSlot = AgentStateSlotDefinition<unknown>;

export interface AgentStateSlotStore {
  set(request: {
    conversationId: string;
    name: string;
    value: unknown;
    actor: 'agent' | 'human' | 'system';
  }): Promise<AgentStateSlotValue>;
  get(conversationId: string, name: string): Promise<AgentStateSlotValue | undefined>;
  list(conversationId: string): Promise<readonly AgentStateSlotValue[]>;
}

export function defineStateSlot<VALUE>(input: {
  name: string;
  schema: z.ZodType<VALUE>;
  version?: number;
  description?: string;
}): AgentStateSlotDefinition<VALUE> {
  if (input.name.length === 0) throw new TypeError('State slot name must not be empty');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) {
    throw new TypeError('State slot version must be a positive integer');
  }
  return {
    name: input.name,
    version,
    schema: input.schema,
    ...(input.description && { description: input.description }),
  };
}

const StateSetPayloadSchema = z
  .object({
    name: z.string().min(1),
    version: z.int().positive(),
    value: z.json(),
    actor: z.enum(['agent', 'human', 'system']),
  })
  .strict();

function slotRegistry(definitions: readonly AnyAgentStateSlot[]) {
  const result = new Map<string, AnyAgentStateSlot>();
  for (const definition of definitions) {
    if (result.has(definition.name))
      throw new TypeError(`Duplicate state slot: ${definition.name}`);
    result.set(definition.name, definition);
  }
  return result;
}

export function createAgentStateSlotStore(input: {
  store: AgentRuntimeStore;
  definitions: readonly AnyAgentStateSlot[];
}): AgentStateSlotStore {
  const definitions = slotRegistry(input.definitions);

  const set = async (request: {
    conversationId: string;
    name: string;
    value: unknown;
    actor: 'agent' | 'human' | 'system';
  }): Promise<AgentStateSlotValue> => {
    const definition = definitions.get(request.name);
    if (!definition) throw new TypeError(`Unknown state slot: ${request.name}`);
    const value = definition.schema.parse(request.value);
    const payload = StateSetPayloadSchema.parse({
      name: definition.name,
      version: definition.version,
      value,
      actor: request.actor,
    });
    const event = await input.store.appendEvent({
      conversationId: request.conversationId,
      kind: 'state/set',
      payload,
    });
    return {
      name: definition.name,
      version: definition.version,
      value,
      updatedAt: event.occurredAt,
      seq: event.seq,
    };
  };

  const list = async (conversationId: string): Promise<readonly AgentStateSlotValue[]> => {
    const values = new Map<string, AgentStateSlotValue>();
    let cursor = 1;
    for (;;) {
      const page = await input.store.readEvents({
        conversationId,
        fromSeq: cursor,
        limit: 1_000,
      });
      for (const event of page.items) {
        if (event.kind !== 'state/set') continue;
        const payload = StateSetPayloadSchema.parse(event.payload);
        const definition = definitions.get(payload.name);
        if (!definition || definition.version !== payload.version) continue;
        values.set(payload.name, {
          name: payload.name,
          version: payload.version,
          value: definition.schema.parse(payload.value),
          updatedAt: event.occurredAt,
          seq: event.seq,
        });
      }
      if (page.nextSeq === undefined) break;
      cursor = page.nextSeq;
    }
    return [...values.values()].sort((left, right) => left.name.localeCompare(right.name));
  };

  const get = async (conversationId: string, name: string) =>
    (await list(conversationId)).find((value) => value.name === name);

  return { set, get, list };
}

export function renderAgentStateSlots(
  values: readonly AgentStateSlotValue[],
): string | undefined {
  if (values.length === 0) return undefined;
  return [
    'Durable conversation state (authoritative; newer than compacted history):',
    ...values.map((slot) => `${slot.name}: ${JSON.stringify(slot.value)}`),
  ].join('\n');
}

export const agentGoalStateSlot = defineStateSlot({
  name: 'goal',
  description: 'The durable objective and lifecycle of this conversation.',
  schema: z
    .object({
      objective: z.string().min(1),
      status: z.enum(['active', 'complete', 'blocked']),
    })
    .strict(),
});

export const agentTodoStateSlot = defineStateSlot({
  name: 'todo',
  description: 'The durable ordered work plan for this conversation.',
  schema: z
    .object({
      items: z.array(
        z
          .object({
            step: z.string().min(1),
            status: z.enum(['pending', 'in_progress', 'completed']),
          })
          .strict(),
      ),
    })
    .strict(),
});
