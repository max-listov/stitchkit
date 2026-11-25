import { describe, expect, test } from 'bun:test';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime/sqlite-bun';
import {
  type AgentSchedule,
  type AgentScheduleService,
  type AgentScheduleToolsConfig,
  createAgentScheduleService,
  createAgentScheduleTools,
} from '../src/entrypoints/agent-runtime';
import { issuedRunContext } from './support/issued-run-context';

const TIMESTAMP = '2026-11-23T10:00:00.000Z';

function sampleSchedule(conversationId: string, id: string): AgentSchedule {
  return {
    id,
    conversationId,
    kind: 'after',
    nextAt: TIMESTAMP,
    input: { remind: id },
    state: 'scheduled',
    occurrence: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

// Compile-time contract proofs: checked by `tsc --noEmit`.
export function scheduleServiceTypeChecks(): void {
  const syncService: AgentScheduleService = {
    scheduleInput: async () => sampleSchedule('c', 's1'),
    cancelSchedule: async () => true,
    // @ts-expect-error listSchedules must return Promise<readonly AgentSchedule[]>
    listSchedules: () => [],
    tick: async () => undefined,
    start: async () => undefined,
    close: () => undefined,
  };
  const syncToolsService: AgentScheduleToolsConfig['service'] = {
    scheduleInput: async () => sampleSchedule('c', 's1'),
    cancelSchedule: async () => true,
    // @ts-expect-error listSchedules must return Promise<readonly AgentSchedule[]>
    listSchedules: () => [],
  };
  void [syncService, syncToolsService];
}

describe('asynchronous AgentScheduleService.listSchedules', () => {
  test('schedule_list awaits an async schedule service with real delay', async () => {
    const delayed = sampleSchedule('mine', 'delayed-1');
    let observedConversationId: string | undefined;
    const service: AgentScheduleToolsConfig['service'] = {
      scheduleInput: async () => delayed,
      cancelSchedule: async () => true,
      listSchedules: async (conversationId) => {
        observedConversationId = conversationId;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return [delayed];
      },
    };
    const tools = createAgentScheduleTools({ service, run: issuedRunContext('mine') });
    const listTool = tools.find((candidate) => candidate.name === 'schedule_list');
    if (!listTool) throw new Error('schedule_list tool is missing');

    const result = await listTool.handler({ input: {} });
    expect(observedConversationId).toBe('mine');
    expect(result).toEqual({ schedules: [delayed] });
  });

  test('a rejecting listSchedules produces a clean tool failure', async () => {
    const service: AgentScheduleToolsConfig['service'] = {
      scheduleInput: async () => sampleSchedule('mine', 'unused'),
      cancelSchedule: async () => false,
      listSchedules: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('schedule backend unavailable');
      },
    };
    const tools = createAgentScheduleTools({ service, run: issuedRunContext('mine') });
    const listTool = tools.find((candidate) => candidate.name === 'schedule_list');
    if (!listTool) throw new Error('schedule_list tool is missing');

    await expect(listTool.handler({ input: {} })).rejects.toThrow(
      'schedule backend unavailable',
    );
  });

  test('SQLite schedule service returns a Promise from listSchedules', async () => {
    const sqlite = createBunSqliteAgentRuntimeStore({ filename: ':memory:' });
    const service = createAgentScheduleService({
      host: sqlite.host,
      dispatch: () => undefined,
      maxActivePerConversation: 4,
      minIntervalMs: 1_000,
    });
    try {
      const created = await service.scheduleInput({
        conversationId: 'sqlite-async',
        input: { check: true },
        afterMs: 5_000,
      });
      const listedPromise = service.listSchedules('sqlite-async');
      expect(listedPromise).toBeInstanceOf(Promise);
      const listed = await listedPromise;
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(created.id);
    } finally {
      service.close();
      await sqlite.close();
    }
  });
});
