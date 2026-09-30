import { z } from 'zod';
import { defineRealtimeContract } from '../realtime/contract';
import {
  AgentControlDeliverySchema,
  AgentControlRequestSchema,
  AgentControlResponseSchema,
} from './control-schema';
import { AgentFilePartSchema, AgentTextPartSchema } from './schemas';

/** Untrusted user input cannot manufacture tool evidence or supply runtime identity. */
export const AgentBrowserRequestSchema = z.discriminatedUnion('operation', [
  AgentControlRequestSchema.options[0],
  AgentControlRequestSchema.options[1],
  AgentControlRequestSchema.options[2],
  AgentControlRequestSchema.options[3].omit({ context: true }).extend({
    parts: z
      .array(z.union([AgentTextPartSchema.strict(), AgentFilePartSchema.strict()]))
      .min(1),
  }),
  AgentControlRequestSchema.options[4],
  AgentControlRequestSchema.options[5].omit({ context: true }),
]);
export type AgentBrowserRequest = z.infer<typeof AgentBrowserRequestSchema>;

export const agentControlRealtimeContract = defineRealtimeContract({
  serverToClient: {
    'agent:delivery': { args: z.tuple([AgentControlDeliverySchema]) },
  },
  clientToServer: {
    'agent:control': {
      args: z.tuple([AgentBrowserRequestSchema]),
      ack: AgentControlResponseSchema,
    },
  },
});
