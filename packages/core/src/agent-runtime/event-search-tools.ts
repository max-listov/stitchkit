import { z } from 'zod';
import { defineAgentTool } from './agent-tool';
import { conversationOfRun } from './context-issue';
import { AgentEventSearchResultSchema } from './event-search';
import type { AgentRuntimeRunContext } from './runtime';
import type { AgentRuntimeStore } from './store';

const AGENT_EVENT_SEARCH_TOOL_NAMES = {
  search: 'session_search',
  trace: 'session_trace',
  event: 'session_event',
} as const;

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
const SearchInputSchema = z
  .object({
    query: z.string().min(1),
    conversationId: z.string().min(1).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    limit: z.int().positive().max(200).optional(),
  })
  .strict();
const SearchOutputSchema = z
  .object({ results: z.array(AgentEventSearchResultSchema) })
  .strict();
const TraceInputSchema = z
  .object({
    fromSeq: z.int().positive().optional(),
    toSeq: z.int().positive().optional(),
    limit: z.int().positive().max(1_000).default(100),
  })
  .strict();
const TraceOutputSchema = z
  .object({ events: z.array(EventOutputSchema), nextSeq: z.number().optional() })
  .strict();

/**
 * What each event search tool takes and answers, by tool name. A branch reads
 * these to recognise the tools' records in a conversation's history.
 */
export const AGENT_EVENT_SEARCH_TOOL_SCHEMAS = {
  [AGENT_EVENT_SEARCH_TOOL_NAMES.search]: {
    input: SearchInputSchema,
    output: SearchOutputSchema,
  },
  [AGENT_EVENT_SEARCH_TOOL_NAMES.trace]: {
    input: TraceInputSchema,
    output: TraceOutputSchema,
  },
  [AGENT_EVENT_SEARCH_TOOL_NAMES.event]: {
    input: EventAddressSchema,
    output: EventOutputSchema,
  },
} as const;

/** Configuration binding conversation event-search agent tools to a run and search backend. */
export interface AgentEventSearchToolsConfig {
  /** The run context `tools()` received: the tools read for its conversation. */
  run: AgentRuntimeRunContext<unknown>;
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
}

/**
 * Event search bound to the conversation of one run. Another conversation is
 * read only when `authorizeConversation` approves it for this one.
 */
export function createAgentEventSearchTools(config: AgentEventSearchToolsConfig) {
  const input = {
    ...config,
    conversationId: conversationOfRun(config.run, 'createAgentEventSearchTools'),
  };
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
      name: AGENT_EVENT_SEARCH_TOOL_NAMES.search,
      description: 'Search authorized durable conversation events and return exact addresses.',
      identity: { serviceName: 'agent-events', action: 'search', method: 'POST' },
      input: SearchInputSchema,
      output: SearchOutputSchema,
      expose: ['AGENT'],
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
      name: AGENT_EVENT_SEARCH_TOOL_NAMES.trace,
      description: 'Read a bounded contiguous slice of this conversation event trace.',
      identity: { serviceName: 'agent-events', action: 'trace', method: 'GET' },
      input: TraceInputSchema,
      output: TraceOutputSchema,
      expose: ['AGENT'],
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
      name: AGENT_EVENT_SEARCH_TOOL_NAMES.event,
      description: 'Read one durable event by exact conversation and sequence address.',
      identity: { serviceName: 'agent-events', action: 'read', method: 'GET' },
      input: EventAddressSchema,
      output: EventOutputSchema,
      expose: ['AGENT'],
      handler: ({ input: request }) => readExact(request),
    }),
  ] as const;
}
