import { z } from 'zod';
import { defineRealtimeContract } from '../realtime/contract';
import {
  AgentControlDeliverySchema,
  AgentControlRequestSchema,
  AgentControlResponseSchema,
} from './control-schema';
import { AgentFilePartSchema, AgentTextPartSchema } from './schemas';

/**
 * Untrusted user input cannot manufacture tool evidence or supply runtime identity.
 */
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
/**
 * A request a browser may send to the agent controller (attach, send message, interrupt and so
 * on); the server supplies context and identity, the browser cannot.
 */
export type AgentBrowserRequest = z.infer<typeof AgentBrowserRequestSchema>;

/**
 * Realtime contract carrying `agent:control` requests up and `agent:delivery` events down;
 * bind it with `bindAgentHarnessRealtime` on the server and `createAgentController` in the
 * browser.
 */
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
