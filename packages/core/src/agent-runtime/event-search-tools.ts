import { z } from 'zod';
import { defineAgentTool } from './agent-tool';
import { AgentEventSearchResultSchema } from './event-search';
import type { AgentRuntimeStore } from './store';

export function createAgentEventSearchTools(input: {
  conversationId: string;
  search(request: {
    requestingConversationId: string;
    query: string;
    conversationId?: string;
    since?: string;
    limit?: number;
  }): Promise<readonly z.infer<typeof AgentEventSearchResultSchema>[]>;
  store: AgentRuntimeStore;
  authorizeConversation?(request: {
    requestingConversationId: string;
    targetConversationId: string;
  }): boolean | Promise<boolean>;
}) {
  const EventAddressSchema = z
    .object({ conversationId: z.string(), seq: z.int().positive() })
    .strict();
  const EventOutputSchema = z
    .object({
      conversationId: z.string(),
      seq: z.int().positive(),
      kind: z.string(),
      occurredAt: z.string(),
      payload: z.json(),
    })
    .strict();

  const readExact = async (address: z.infer<typeof EventAddressSchema>) => {
    if (address.conversationId !== input.conversationId) {
      const allowed = await input.authorizeConversation?.({
        requestingConversationId: input.conversationId,
        targetConversationId: address.conversationId,
      });
      if (!allowed)
        throw new TypeError('Event address is outside the authorized conversation');
    }
    const page = await input.store.readEvents({
      conversationId: address.conversationId,
      fromSeq: address.seq,
      toSeq: address.seq,
      limit: 1,
    });
    const event = page.items[0];
    if (!event || event.seq !== address.seq) throw new TypeError('Unknown event address');
    return {
      conversationId: event.conversationId,
      seq: event.seq,
      kind: event.kind,
      occurredAt: event.occurredAt,
      payload: event.payload,
    };
  };

  return [
    defineAgentTool({
      name: 'session_search',
      description: 'Search authorized durable conversation events and return exact addresses.',
      identity: { serviceName: 'agent-events', action: 'search', method: 'POST' },
      input: z
        .object({
          query: z.string().min(1),
          conversationId: z.string().min(1).optional(),
          since: z.iso.datetime({ offset: true }).optional(),
          limit: z.int().positive().max(200).optional(),
        })
        .strict(),
      output: z.object({ results: z.array(AgentEventSearchResultSchema) }).strict(),
      transports: ['AGENT'],
      handler: async ({ input: request }) => ({
        results: [
          ...(await input.search({
            requestingConversationId: input.conversationId,
            ...request,
          })),
        ],
      }),
    }),
    defineAgentTool({
      name: 'session_trace',
      description: 'Read a bounded contiguous slice of this conversation event trace.',
      identity: { serviceName: 'agent-events', action: 'trace', method: 'GET' },
      input: z
        .object({
          fromSeq: z.int().positive().optional(),
          toSeq: z.int().positive().optional(),
          limit: z.int().positive().max(1_000).default(100),
        })
        .strict(),
      output: z.object({ events: z.array(EventOutputSchema), nextSeq: z.number().optional() }),
      transports: ['AGENT'],
      handler: async ({ input: request }) => {
        const page = await input.store.readEvents({
          conversationId: input.conversationId,
          ...request,
        });
        return {
          events: page.items.map((event) => ({
            conversationId: event.conversationId,
            seq: event.seq,
            kind: event.kind,
            occurredAt: event.occurredAt,
            payload: event.payload,
          })),
          ...(page.nextSeq !== undefined && { nextSeq: page.nextSeq }),
        };
      },
    }),
    defineAgentTool({
      name: 'session_event',
      description: 'Read one durable event by exact conversation and sequence address.',
      identity: { serviceName: 'agent-events', action: 'read', method: 'GET' },
      input: EventAddressSchema,
      output: EventOutputSchema,
      transports: ['AGENT'],
      handler: ({ input: request }) => readExact(request),
    }),
  ] as const;
}
