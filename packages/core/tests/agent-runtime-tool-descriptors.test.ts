/**
 * Static non-executable descriptors for all run-bound built-in agent-runtime tool factories:
 * - single source of truth with live factory outputs (names, descriptions, identity, schemas)
 * - deeply frozen (mutation refused) and free of executable `handler` / `execute`
 * - directly consumable by `listToolNames`, `buildToolManifest`, and `describeToolCatalog`
 * - negative control: run-bound factories still refuse forged run contexts.
 */
import { describe, expect, test } from 'bun:test';
import {
  AGENT_CHILD_TOOL_DESCRIPTORS,
  AGENT_EVENT_SEARCH_TOOL_DESCRIPTORS,
  AGENT_SCHEDULE_TOOL_DESCRIPTORS,
  AGENT_STATE_TOOL_DESCRIPTORS,
  type AgentRuntimeRunContext,
  agentGoalStateSlot,
  agentTodoStateSlot,
  createAgentChildTools,
  createAgentEventSearchTools,
  createAgentScheduleTools,
  createAgentStateSlotStore,
  createAgentStateTools,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import {
  buildToolManifest,
  describeToolCatalog,
  listToolNames,
} from '../src/entrypoints/tools';
import { issuedRunContext } from './support/issued-run-context';

describe('static agent-runtime tool descriptors', () => {
  test('all 4 run-bound descriptor sets are frozen, non-executable, and share exact schema/metadata identity with factory outputs', () => {
    const store = createMemoryAgentRuntimeStore();
    const state = createAgentStateSlotStore({
      store,
      definitions: [agentGoalStateSlot, agentTodoStateSlot],
    });
    const run = issuedRunContext('conv-desc');

    const pairs = [
      [AGENT_STATE_TOOL_DESCRIPTORS, createAgentStateTools({ state, run })],
      [
        AGENT_SCHEDULE_TOOL_DESCRIPTORS,
        createAgentScheduleTools({
          run,
          service: {
            scheduleInput: async () => {
              throw new Error('unused');
            },
            cancelSchedule: async () => false,
            listSchedules: async () => [],
          },
        }),
      ],
      [
        AGENT_CHILD_TOOL_DESCRIPTORS,
        createAgentChildTools({
          run,
          manager: {
            spawnChild: async () => {
              throw new Error('unused');
            },
            waitChild: async () => {
              throw new Error('unused');
            },
            listChildren: async () => [],
            sendMessage: async () => undefined,
            interruptChild: async () => undefined,
          },
        }),
      ],
      [
        AGENT_EVENT_SEARCH_TOOL_DESCRIPTORS,
        createAgentEventSearchTools({
          run,
          store,
          search: async () => [],
        }),
      ],
    ] as const;

    for (const [descriptors, liveTools] of pairs) {
      expect(Object.isFrozen(descriptors)).toBe(true);
      expect(descriptors.length).toBe(liveTools.length);
      for (let i = 0; i < descriptors.length; i += 1) {
        const desc = descriptors[i];
        const live = liveTools[i];
        if (!desc || !live) throw new Error('missing descriptor or live tool');
        expect(Object.isFrozen(desc)).toBe(true);
        expect(Object.isFrozen(desc.identity)).toBe(true);
        expect(Object.isFrozen(desc.expose)).toBe(true);
        expect('handler' in desc).toBe(false);
        expect('execute' in desc).toBe(false);

        expect(live.name).toBe(desc.name);
        expect(live.description).toBe(desc.description);
        expect(live.identity).toEqual(desc.identity);
        expect(live.input).toBe(desc.input);
        expect(live.output).toBe(desc.output);
        expect(live.expose).toEqual(desc.expose);
      }
    }

    expect(AGENT_STATE_TOOL_DESCRIPTORS.map((d) => d.name)).toEqual([
      'create_goal',
      'update_goal',
      'get_goal',
      'todo_write',
    ]);
  });

  test('descriptors work directly in listToolNames, buildToolManifest, and describeToolCatalog without an active run', () => {
    const allDescriptors = [
      ...AGENT_STATE_TOOL_DESCRIPTORS,
      ...AGENT_SCHEDULE_TOOL_DESCRIPTORS,
      ...AGENT_CHILD_TOOL_DESCRIPTORS,
      ...AGENT_EVENT_SEARCH_TOOL_DESCRIPTORS,
    ];
    const names = listToolNames({ runtimeTools: allDescriptors });
    expect(names.map((e) => e.name).sort()).toEqual(allDescriptors.map((d) => d.name).sort());
    expect(names.every((e) => e.kind === 'runtime' && e.expose.join(',') === 'AGENT')).toBe(
      true,
    );

    const manifest = buildToolManifest({
      transport: 'AGENT',
      runtimeTools: allDescriptors,
      inputRecursionDepth: 2,
    });
    expect(manifest).toHaveLength(allDescriptors.length);
    expect(manifest.find((m) => m.name === 'create_goal')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { objective: { type: 'string' } },
    });

    const catalog = describeToolCatalog({
      transport: 'AGENT',
      runtimeTools: AGENT_STATE_TOOL_DESCRIPTORS,
    });
    expect(catalog.map((c) => c.name)).toEqual([
      'create_goal',
      'update_goal',
      'get_goal',
      'todo_write',
    ]);
  });

  test('negative control: forged run context is still refused by createAgentStateTools', () => {
    const store = createMemoryAgentRuntimeStore();
    const state = createAgentStateSlotStore({
      store,
      definitions: [agentGoalStateSlot, agentTodoStateSlot],
    });
    const forged = {
      id: 'forged-run',
      conversationId: 'conv-other',
      signal: new AbortController().signal,
    } as unknown as AgentRuntimeRunContext<unknown>;
    expect(() => createAgentStateTools({ state, run: forged })).toThrow();
  });
});
