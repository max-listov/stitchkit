import { z } from 'zod';
import type { createInvocationPayloads } from './invocation-payload';
import { InvocationPayloadSchema, ModelInvocationRecordSchema } from './invocation-schema';
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
      // Non-receipt provider events predate the typed invocation contract.
      if (
        !event.payload ||
        typeof event.payload !== 'object' ||
        !('invocationId' in event.payload)
      )
        return [];
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

export async function readInvocationPayload(
  store: AgentRuntimeStore,
  payloads: ReturnType<typeof createInvocationPayloads>,
  input: { conversationId: string; artifactId: string },
) {
  let fromSeq: number | undefined;
  do {
    const page = await store.readEvents({
      conversationId: input.conversationId,
      fromSeq,
      limit: 1_000,
    });
    for (const event of page.items) {
      if (event.kind !== 'provider/payload') continue;
      const payload = InvocationPayloadSchema.parse(event.payload);
      if (payload.artifactId === input.artifactId)
        return payloads.decrypt(input.conversationId, payload);
    }
    fromSeq = page.nextSeq;
  } while (fromSeq !== undefined);
  throw new Error('Invocation artifact not found');
}
