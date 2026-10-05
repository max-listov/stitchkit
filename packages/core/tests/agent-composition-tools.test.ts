import { expect, test } from 'bun:test';
import { z } from 'zod';
import { AppError } from '../src/contract/errors';
import { AgentRunSchema, type AgentRuntimeRunContext } from '../src/entrypoints/agent-runtime';
import { composeToolLifecycle, defineRuntimeTool, mountAgent } from '../src/entrypoints/tools';

test('the one-line harness composition retains mapped identity, mount options, hooks, authorization and exactly one fence', async () => {
  const seen: string[] = [];
  let denied = false;
  let stale = false;
  const definition = defineRuntimeTool({
    name: 'read_item',
    description: 'Read an item',
    identity: { serviceName: 'items', action: 'read', method: 'GET' },
    input: z.object({ id: z.string() }),
    output: z.object({ owner: z.string() }),
    handler: (context) => {
      seen.push(`handler:${context.userId}:${context.messageId}`);
      return { owner: String(context.userId), extra: true };
    },
  });
  const run = AgentRunSchema.parse({
    schemaVersion: 1,
    id: 'run',
    conversationId: 'conversation',
    inputMessageIds: ['input'],
    assistantMessageId: 'answer',
    state: 'running',
    revision: 1,
    createdAt: '2026-09-30T00:00:00Z',
    updatedAt: '2026-09-30T00:00:00Z',
  });
  const factory = async (input: AgentRuntimeRunContext<{ userId: string }>) =>
    mountAgent([], {
      runtimeTools: [definition],
      context: { ...input.context, messageId: input.run.assistantMessageId },
      lifecycle: composeToolLifecycle(
        {
          beforeHandle: () => {
            seen.push('auth');
            if (denied) throw new AppError('DENIED', { message: 'denied', status: 403 });
          },
        },
        input.toolFenceLifecycle,
      ),
      hooks: {
        beforeToolCall: () => {
          seen.push('hook');
        },
      },
      onOutputStrip: () => {
        seen.push('strip');
      },
      flattenUnionInput: true,
      coerceJsonArgs: false,
    });
  const tools = await factory({
    context: { userId: 'alice' },
    run,
    signal: new AbortController().signal,
    toolFenceLifecycle: {
      beforeHandle: () => {
        seen.push('fence');
        if (stale) throw new AppError('STALE', { message: 'stale', status: 409 });
      },
    },
  });
  const execute = tools.read_item?.execute;
  if (!execute) throw new Error('Missing mounted tool');
  const invoke = () =>
    execute({ id: 'item' }, { toolCallId: 'call', messages: [], context: undefined });
  expect(await invoke()).toEqual({ owner: 'alice' });
  expect(seen.filter((entry) => entry === 'fence')).toHaveLength(1);
  expect(seen).toContain('handler:alice:answer');
  expect(seen).toContain('hook');
  expect(seen).toContain('strip');
  seen.length = 0;
  denied = true;
  await expect(invoke()).rejects.toThrow('denied');
  expect(seen).not.toContain('fence');
  expect(seen.some((entry) => entry.startsWith('handler'))).toBe(false);
  denied = false;
  stale = true;
  seen.length = 0;
  await expect(invoke()).rejects.toThrow('stale');
  expect(seen).toContain('fence');
  expect(seen.some((entry) => entry.startsWith('handler'))).toBe(false);
});
