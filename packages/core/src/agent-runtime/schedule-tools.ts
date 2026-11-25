import { z } from 'zod';
import { bindAgentTool, defineAgentToolDescriptor } from './agent-tool';
import { conversationOfRun } from './context-issue';
import type { AgentRuntimeRunContext } from './runtime';
import type { AgentScheduleService } from './schedule-contract';

const ScheduledOutputSchema = z
  .object({ scheduleId: z.string(), nextAt: z.string() })
  .strict();

const SCHEDULE_AFTER_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'schedule_after',
  description: 'Schedule durable input after a relative delay.',
  identity: { serviceName: 'agent-schedules', action: 'after', method: 'POST' },
  input: z
    .object({
      input: z.json(),
      afterMs: z.int().positive(),
    })
    .strict(),
  output: ScheduledOutputSchema,
  expose: ['AGENT'],
});

const SCHEDULE_AT_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'schedule_at',
  description: 'Schedule durable input at an absolute timestamp with an explicit offset.',
  identity: { serviceName: 'agent-schedules', action: 'at', method: 'POST' },
  input: z.object({ input: z.json(), at: z.string().min(1) }).strict(),
  output: ScheduledOutputSchema,
  expose: ['AGENT'],
});

const SCHEDULE_EVERY_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'schedule_every',
  description: 'Schedule recurring durable input in an explicit conversation timezone.',
  identity: { serviceName: 'agent-schedules', action: 'every', method: 'POST' },
  input: z
    .object({
      input: z.json(),
      everyMs: z.int().positive(),
      timeZone: z.string().min(1),
    })
    .strict(),
  output: ScheduledOutputSchema,
  expose: ['AGENT'],
});

const SCHEDULE_LIST_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'schedule_list',
  description: 'List the durable schedules of this conversation.',
  identity: { serviceName: 'agent-schedules', action: 'list', method: 'GET' },
  input: z.object({}).strict(),
  output: z.object({ schedules: z.array(z.json()) }).strict(),
  expose: ['AGENT'],
});

const SCHEDULE_CANCEL_DESCRIPTOR = defineAgentToolDescriptor({
  name: 'schedule_cancel',
  description: 'Cancel one durable deferred-input schedule.',
  identity: { serviceName: 'agent-schedules', action: 'cancel', method: 'POST' },
  input: z.object({ scheduleId: z.string().min(1) }).strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
  expose: ['AGENT'],
});

/**
 * Static non-executable descriptors for the built-in schedule tools (`createAgentScheduleTools`).
 * Single source of truth for catalog generation, preset validation, and live run-bound tools.
 */
export const AGENT_SCHEDULE_TOOL_DESCRIPTORS = Object.freeze([
  SCHEDULE_AFTER_DESCRIPTOR,
  SCHEDULE_AT_DESCRIPTOR,
  SCHEDULE_EVERY_DESCRIPTOR,
  SCHEDULE_LIST_DESCRIPTOR,
  SCHEDULE_CANCEL_DESCRIPTOR,
] as const);

/** Configuration binding durable scheduling agent tools to a schedule service and run context. */
export interface AgentScheduleToolsConfig {
  /**
   * What the tools call; any schedule service has it. Its own limits — the
   * active schedules per conversation, the shortest repeat — bound what the
   * model may ask for: the tools add none of their own.
   */
  service: Pick<AgentScheduleService, 'scheduleInput' | 'cancelSchedule' | 'listSchedules'>;
  /** The run context `tools()` received: every tool acts for its conversation and no other. */
  run: AgentRuntimeRunContext<unknown>;
}

/**
 * Schedule tools bound to the conversation of one run. The address of a live
 * conversation is authority, so it comes from the run the runtime started,
 * never from the model and never from a free host argument.
 */
export function createAgentScheduleTools({ service, run }: AgentScheduleToolsConfig) {
  const conversationId = conversationOfRun(run, 'createAgentScheduleTools');
  const schedule = async (
    request: Omit<Parameters<AgentScheduleService['scheduleInput']>[0], 'conversationId'>,
  ) => {
    const result = await service.scheduleInput({ ...request, conversationId });
    return { scheduleId: result.id, nextAt: result.nextAt };
  };

  return [
    bindAgentTool(SCHEDULE_AFTER_DESCRIPTOR, ({ input }) => schedule(input)),
    bindAgentTool(SCHEDULE_AT_DESCRIPTOR, ({ input }) => schedule(input)),
    bindAgentTool(SCHEDULE_EVERY_DESCRIPTOR, ({ input }) => schedule(input)),
    bindAgentTool(SCHEDULE_LIST_DESCRIPTOR, async () => ({
      schedules: [...(await service.listSchedules(conversationId))],
    })),
    bindAgentTool(SCHEDULE_CANCEL_DESCRIPTOR, async ({ input }) => ({
      cancelled: await service.cancelSchedule(conversationId, input.scheduleId),
    })),
  ] as const;
}
