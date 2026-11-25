/**
 * A built-in tool's input never carries a runtime identity the model could
 * aim with.
 *
 * The child and schedule tools once took the conversation to act for from the
 * model's input: any address the model saw was authority. They now read it
 * from the run that called them, and this test keeps every built-in tool that
 * way. A field named for a runtime identity in an input schema is refused
 * unless it is listed here with the reason the model may name it.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ZodType, z } from 'zod';
import { DeferredAgentToolSearchInputSchema } from '../src/agent-runtime/deferred-tool-types';
import {
  agentGoalStateSlot,
  createAgentChildTools,
  createAgentEventSearchTools,
  createAgentScheduleTools,
  createAgentStateSlotStore,
  createAgentStateTools,
  createMemoryAgentRuntimeStore,
} from '../src/entrypoints/agent-runtime';
import { createAgentCodingTools } from '../src/entrypoints/agent-runtime/coding-tools';
import { issuedRunContext } from './support/issued-run-context';

/** Names of runtime identities: whoever holds one of these can act on it. */
const RUNTIME_FIELDS = new Set([
  'conversationId',
  'parentConversationId',
  'runId',
  'messageId',
  'callId',
  'toolCallId',
  'approvalId',
  'operationId',
  'idempotencyKey',
  'ownerId',
]);

/** Where the model may name one, and why that names no authority. */
const ALLOWED: Record<string, string> = {
  // The host's `authorizeConversation` approves every target against the
  // conversation calling the tool; without it only the own conversation reads.
  'session_search.conversationId': 'a search target the host authorizes',
  'session_event.conversationId': 'an event address the host authorizes',
};

/** Every property name an input schema declares, at any depth, with its path. */
function fieldsOf(schema: ZodType): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, path);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object')
        for (const [name, child] of Object.entries(value)) {
          found.push(path ? `${path}.${name}` : name);
          walk(child, path ? `${path}.${name}` : name);
        }
      else walk(value, path);
    }
  };
  walk(z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), '');
  return found;
}

/** `tool.field` for every runtime identity an input names without a listed reason. */
function runtimeFieldsIn(tools: readonly { name: string; input: ZodType }[]): string[] {
  return tools.flatMap((tool) =>
    fieldsOf(tool.input)
      .filter((path) => RUNTIME_FIELDS.has(path.split('.').at(-1) ?? ''))
      .map((path) => `${tool.name}.${path}`)
      .filter((address) => !(address in ALLOWED)),
  );
}

function builtInTools() {
  const store = createMemoryAgentRuntimeStore();
  const run = issuedRunContext('mine');
  const root = mkdtempSync(join(tmpdir(), 'stitchkit-builtin-inputs-'));
  const tools = [
    ...createAgentChildTools({
      manager: {
        spawnChild: async () => {
          throw new Error('unused');
        },
        waitChild: async () => undefined,
        listChildren: async () => [],
        sendMessage: async () => undefined,
        interruptChild: async () => undefined,
      },
      run,
    }),
    ...createAgentScheduleTools({
      service: {
        scheduleInput: async () => {
          throw new Error('unused');
        },
        cancelSchedule: async () => false,
        listSchedules: async () => [],
      },
      run,
    }),
    ...createAgentStateTools({
      state: createAgentStateSlotStore({ store, definitions: [agentGoalStateSlot] }),
      run,
    }),
    ...createAgentEventSearchTools({ run, search: async () => [], store }),
    ...createAgentCodingTools({ root, authorize: () => true }),
    { name: 'tool_search', input: DeferredAgentToolSearchInputSchema },
  ];
  return { tools, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('no built-in tool input names a runtime identity outside the listed reasons', () => {
  const { tools, cleanup } = builtInTools();
  try {
    // The walker sees every tool: an empty answer from no tools proves nothing.
    expect(tools.length).toBeGreaterThan(20);
    expect(
      fieldsOf(tools.find((tool) => tool.name === 'send_message')?.input ?? z.never()),
    ).toEqual(['childConversationId', 'input']);
    expect(runtimeFieldsIn(tools)).toEqual([]);
    // Every listed reason still names a field that exists.
    const present = new Set(
      tools.flatMap((tool) => fieldsOf(tool.input).map((path) => `${tool.name}.${path}`)),
    );
    expect(Object.keys(ALLOWED).filter((address) => !present.has(address))).toEqual([]);
  } finally {
    cleanup();
  }
});

test('a runtime identity in a tool input is found, at any depth (negative control)', () => {
  expect(
    runtimeFieldsIn([
      { name: 'aimed', input: z.object({ runId: z.string() }) },
      {
        name: 'nested',
        input: z.object({ target: z.object({ parentConversationId: z.string() }) }),
      },
    ]),
  ).toEqual(['aimed.runId', 'nested.target.parentConversationId']);
});
