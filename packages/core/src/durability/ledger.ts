import type { z } from 'zod';
import {
  DeliveredEventPayloadSchema,
  DURABILITY_EFFECT_EVENT_KIND,
  DURABILITY_EVENT_EVENT_KIND,
  DURABILITY_PARK_EVENT_KIND,
  DURABILITY_STEP_EVENT_KIND,
  type EffectEventPayload,
  EffectEventPayloadSchema,
  type ParkEventPayload,
  ParkEventPayloadSchema,
  ParkRecordDecodeError,
  type StepDurabilityLedger,
  type StepEventPayload,
  StepEventPayloadSchema,
  StepResultDecodeError,
  StepResultNotSerializableError,
} from './contract';
import type { AgentStoreEventEnvelope } from './events';
import { DurableJsonSchema } from './json';
export function stepKey(conversationId: string, runId: string, stepName: string): string {
  return JSON.stringify([conversationId, runId, stepName]);
}

export function effectKey(conversationId: string, runId: string, effectName: string): string {
  return JSON.stringify([conversationId, runId, 'effect', effectName]);
}

export function sleepParkKey(conversationId: string, runId: string, name: string): string {
  return JSON.stringify([conversationId, runId, 'sleep', name]);
}

export function waitParkKey(
  conversationId: string,
  runId: string,
  event: string,
  id: string,
): string {
  return JSON.stringify([conversationId, runId, 'wait', event, id]);
}

export function parkEventKey(conversationId: string, payload: ParkEventPayload): string {
  return payload.kind === 'sleep'
    ? sleepParkKey(conversationId, payload.runId, payload.name)
    : waitParkKey(conversationId, payload.runId, payload.event, payload.id);
}

export function encodeStepResult(stepName: string, value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(DurableJsonSchema.parse(value));
  } catch (cause) {
    throw new StepResultNotSerializableError(stepName, cause);
  }
  if (encoded === undefined) {
    throw new StepResultNotSerializableError(stepName, value);
  }
  return encoded;
}

export function encodeDeliveredPayload(event: string, id: string, payload: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(DurableJsonSchema.parse(payload === undefined ? null : payload));
  } catch (cause) {
    throw new TypeError(`Delivered event "${event}#${id}" payload is not JSON-serializable`, {
      cause,
    });
  }
  if (encoded === undefined) {
    throw new TypeError(`Delivered event "${event}#${id}" payload is not JSON-serializable`);
  }
  return encoded;
}

function decodeStepPayload(event: AgentStoreEventEnvelope): StepEventPayload {
  const parsed = StepEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new StepResultDecodeError(
      `Recorded step event ${event.eventId} in conversation ${event.conversationId} is malformed`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function decodeRecordedResult(
  payload: StepEventPayload,
  event: AgentStoreEventEnvelope,
): unknown {
  try {
    return DurableJsonSchema.parse(JSON.parse(payload.encoded));
  } catch (cause) {
    throw new StepResultDecodeError(
      `Recorded result for step "${payload.stepName}" (run ${payload.runId}, ` +
        `event ${event.eventId}) is not decodable JSON`,
      { cause },
    );
  }
}

function decodeParkPayload(event: AgentStoreEventEnvelope): ParkEventPayload {
  const parsed = ParkEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new ParkRecordDecodeError(
      `Recorded park event ${event.eventId} in conversation ${event.conversationId} is malformed`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function decodeDeliveredPayload(
  event: AgentStoreEventEnvelope,
): z.infer<typeof DeliveredEventPayloadSchema> {
  const parsed = DeliveredEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new ParkRecordDecodeError(
      `Delivered event ${event.eventId} in conversation ${event.conversationId} is malformed`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}

function decodeDeliveredResult(
  payload: z.infer<typeof DeliveredEventPayloadSchema>,
  event: AgentStoreEventEnvelope,
): unknown {
  try {
    return JSON.parse(payload.encoded);
  } catch (cause) {
    throw new ParkRecordDecodeError(
      `Delivered payload for "${payload.event}#${payload.id}" (run ${payload.runId}, ` +
        `event ${event.eventId}) is not decodable JSON`,
      { cause },
    );
  }
}

/** What the ledger says about one effect: an intent, and at most one outcome. */
export type EffectRecord =
  | { readonly outcome: undefined }
  | { readonly outcome: 'accepted'; readonly proof: unknown }
  | { readonly outcome: 'uncertain' };

function decodeEffect(event: AgentStoreEventEnvelope): {
  payload: EffectEventPayload;
  record: EffectRecord;
} {
  const parsed = EffectEventPayloadSchema.safeParse(event.payload);
  if (!parsed.success) {
    throw new StepResultDecodeError(
      `Recorded effect event ${event.eventId} in conversation ${event.conversationId} is malformed`,
      { cause: parsed.error },
    );
  }
  const payload = parsed.data;
  if (payload.phase === 'intent') return { payload, record: { outcome: undefined } };
  if (payload.phase === 'uncertain') return { payload, record: { outcome: 'uncertain' } };
  try {
    const proof = DurableJsonSchema.parse(JSON.parse(payload.encoded));
    return { payload, record: { outcome: 'accepted', proof } };
  } catch (cause) {
    throw new StepResultDecodeError(
      `Recorded proof for effect "${payload.effectName}" (run ${payload.runId}, ` +
        `event ${event.eventId}) is not decodable JSON`,
      { cause },
    );
  }
}

export interface DurabilityLedgerView {
  readonly steps: Map<string, unknown>;
  readonly effects: Map<string, EffectRecord>;
  readonly parks: Map<string, ParkEventPayload>;
  readonly deliveries: Map<string, unknown>;
  nextSeq: number;
}

/** Read every `durability/*` record in the conversation, keyed by durable key. */
export async function readDurabilityLedger(
  store: StepDurabilityLedger,
  conversationId: string,
  view: DurabilityLedgerView,
): Promise<DurabilityLedgerView> {
  const { steps, effects, parks, deliveries } = view;
  let fromSeq = view.nextSeq;
  for (;;) {
    const page = await store.readEvents({
      conversationId,
      ...(fromSeq !== undefined && { fromSeq }),
      limit: 10_000,
    });
    for (const event of page.items) {
      if (event.kind === DURABILITY_STEP_EVENT_KIND) {
        const payload = decodeStepPayload(event);
        steps.set(
          stepKey(event.conversationId, payload.runId, payload.stepName),
          decodeRecordedResult(payload, event),
        );
      } else if (event.kind === DURABILITY_PARK_EVENT_KIND) {
        const payload = decodeParkPayload(event);
        parks.set(parkEventKey(event.conversationId, payload), payload);
      } else if (event.kind === DURABILITY_EFFECT_EVENT_KIND) {
        const { payload, record } = decodeEffect(event);
        const key = effectKey(event.conversationId, payload.runId, payload.effectName);
        // First outcome wins, and an intent never overwrites one: an effect
        // that ended is a stable fact, like a completed wait.
        if (effects.get(key)?.outcome === undefined) effects.set(key, record);
      } else if (event.kind === DURABILITY_EVENT_EVENT_KIND) {
        const payload = decodeDeliveredPayload(event);
        const key = waitParkKey(
          event.conversationId,
          payload.runId,
          payload.event,
          payload.id,
        );
        // First delivery wins: a completed wait is a stable fact, and a later
        // delivery for the same key must not rewrite what a replay returns.
        if (!deliveries.has(key)) deliveries.set(key, decodeDeliveredResult(payload, event));
      }
    }
    const last = page.items.at(-1);
    if (last) view.nextSeq = last.seq + 1;
    if (page.nextSeq === undefined) break;
    fromSeq = page.nextSeq;
  }
  return view;
}
