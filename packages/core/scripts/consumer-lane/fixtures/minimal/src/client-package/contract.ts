import { defineContract } from 'stitchkit/contract';
import { z } from 'zod';

export const SessionSchema = z.object({ id: z.string(), state: z.enum(['idle', 'busy']) });
export type Session = z.infer<typeof SessionSchema>;

export class SessionError extends Error {}

export const sessions = defineContract(
  { prefix: 'sessions' },
  {
    list: { method: 'GET', path: '/', desc: 'List sessions', output: z.array(SessionSchema) },
  },
);
