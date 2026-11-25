import { z } from 'zod';
import type { createInvocationPayloads } from './invocation-payload';
import {
  InvocationStoredPayloadSchema,
  isModelInvocationRecord,
  type ModelInvocationPayloadRead,
  ModelInvocationPayloadReadSchema,
  ModelInvocationRecordSchema,
} from './invocation-schema';
import {
  InvocationExpiredPayloadSchema,
  InvocationPayloadSchema,
} from './schemas-invocation-payload';
import type { AgentRuntimeStore } from './store';

export const InvocationReadInputSchema = z
  .object({
    conversationId: z.string().min(1),
    fromSeq: z.int().positive().optional(),
    limit: z.int().positive().max(10_000),
  })
  .strict();

export async function readInvocationRecords(
  store: AgentRuntimeStore,
  input: z.infer<typeof InvocationReadInputSchema>,
) {
  const page = await store.readEvents(InvocationReadInputSchema.parse(input));
  return {
    items: page.items.flatMap((event) => {
      if (
        ![
          'invocation/started',
          'invocation/finished',
          'provider/request',
          'provider/response',
        ].includes(event.kind)
      )
        return [];
      // The provider journal writes the same kinds without an invocation.
      if (!isModelInvocationRecord(event.payload)) return [];
      return [
        {
          seq: event.seq,
          occurredAt: event.occurredAt,
          record: ModelInvocationRecordSchema.parse(event.payload),
        },
      ];
    }),
    ...(page.nextSeq !== undefined && { nextSeq: page.nextSeq }),
  };
}

function decodeStoredPayload(
  payloads: ReturnType<typeof createInvocationPayloads>,
  conversationId: string,
  raw: unknown,
): ModelInvocationPayloadRead {
  const expired = InvocationExpiredPayloadSchema.safeParse(raw);
  if (expired.success) {
    return ModelInvocationPayloadReadSchema.parse({
      status: 'expired',
      artifactId: expired.data.artifactId,
      sha256: expired.data.sha256,
      bytes: expired.data.bytes,
      expiredAt: expired.data.expiredAt,
    });
  }
  const live = InvocationPayloadSchema.parse(raw);
  const payload = payloads.decrypt(conversationId, live);
  return ModelInvocationPayloadReadSchema.parse({
    status: 'available',
    artifactId: live.artifactId,
    sha256: live.sha256,
    bytes: live.bytes,
    payload,
  });
}

export async function readInvocationPayload(
  store: AgentRuntimeStore,
  payloads: ReturnType<typeof createInvocationPayloads>,
  input: { conversationId: string; artifactId: string },
): Promise<ModelInvocationPayloadRead> {
  const keyed = await store.findEventOnce?.({
    conversationId: input.conversationId,
    kind: 'provider/payload',
    key: input.artifactId,
  });
  if (keyed) return decodeStoredPayload(payloads, input.conversationId, keyed.payload);
  // An artifact written by 0.100.0 carries a random event id: only a scan finds it.
  let fromSeq: number | undefined;
  do {
    const page = await store.readEvents({
      conversationId: input.conversationId,
      fromSeq,
      limit: 1_000,
    });
    for (const event of page.items) {
      if (event.kind !== 'provider/payload') continue;
      const stored = InvocationStoredPayloadSchema.parse(event.payload);
      if (stored.artifactId === input.artifactId) {
        return decodeStoredPayload(payloads, input.conversationId, stored);
      }
    }
    fromSeq = page.nextSeq;
  } while (fromSeq !== undefined);
  throw new Error('Invocation artifact not found');
}
