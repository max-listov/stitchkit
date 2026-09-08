import { z } from 'zod';
import { defineAgentTool } from './agent-tool';
import type { AgentScheduleService } from './schedules';

const ScheduledOutputSchema = z
  .object({ scheduleId: z.string(), nextAt: z.string() })
  .strict();
const ConversationInputSchema = z.object({ conversationId: z.string().min(1) }).strict();

export function createAgentScheduleTools(service: AgentScheduleService) {
  const schedule = async (request: Parameters<AgentScheduleService['scheduleInput']>[0]) => {
    const result = await service.scheduleInput(request);
    return { scheduleId: result.id, nextAt: result.nextAt };
  };

  return [
    defineAgentTool({
      name: 'schedule_after',
      description: 'Schedule durable input after a relative delay.',
      identity: { serviceName: 'agent-schedules', action: 'after', method: 'POST' },
      input: z
        .object({
          conversationId: z.string().min(1),
          input: z.json(),
          afterMs: z.int().positive(),
        })
        .strict(),
      output: ScheduledOutputSchema,
      transports: ['AGENT'],
      handler: ({ input }) => schedule(input),
    }),
    defineAgentTool({
      name: 'schedule_at',
      description: 'Schedule durable input at an absolute timestamp with an explicit offset.',
      identity: { serviceName: 'agent-schedules', action: 'at', method: 'POST' },
      input: z
        .object({ conversationId: z.string().min(1), input: z.json(), at: z.string().min(1) })
        .strict(),
      output: ScheduledOutputSchema,
      transports: ['AGENT'],
      handler: ({ input }) => schedule(input),
    }),
    defineAgentTool({
      name: 'schedule_every',
      description: 'Schedule recurring durable input in an explicit conversation timezone.',
      identity: { serviceName: 'agent-schedules', action: 'every', method: 'POST' },
      input: z
        .object({
          conversationId: z.string().min(1),
          input: z.json(),
          everyMs: z.int().positive(),
          timeZone: z.string().min(1),
        })
        .strict(),
      output: ScheduledOutputSchema,
      transports: ['AGENT'],
      handler: ({ input }) => schedule(input),
    }),
    defineAgentTool({
      name: 'schedule_list',
      description: 'List durable schedules for one conversation.',
      identity: { serviceName: 'agent-schedules', action: 'list', method: 'GET' },
      input: ConversationInputSchema,
      output: z.object({ schedules: z.array(z.json()) }).strict(),
      transports: ['AGENT'],
      handler: ({ input }) => ({
        schedules: [...service.listSchedules(input.conversationId)],
      }),
    }),
    defineAgentTool({
      name: 'schedule_cancel',
      description: 'Cancel one durable deferred-input schedule.',
      identity: { serviceName: 'agent-schedules', action: 'cancel', method: 'POST' },
      input: z
        .object({ conversationId: z.string().min(1), scheduleId: z.string().min(1) })
        .strict(),
      output: z.object({ cancelled: z.boolean() }).strict(),
      transports: ['AGENT'],
      handler: async ({ input }) => ({
        cancelled: await service.cancelSchedule(input.conversationId, input.scheduleId),
      }),
    }),
  ] as const;
}
