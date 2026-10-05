import { expect, test } from 'bun:test';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createSocketIOClient } from '../src/browser/socket-io';
import { createAgentController } from '../src/entrypoints/agent-runtime/browser';
import { bindAgentHarnessRealtime } from '../src/entrypoints/agent-runtime/realtime';
import { inspectAgentRun } from '../src/entrypoints/agent-runtime/testing';
import { composeToolLifecycle, defineRuntimeTool, mountAgent } from '../src/entrypoints/tools';
import { createServer } from '../src/server/bun';
import { createSocketIOServer } from '../src/server/socket-io';
import { compositionHarness, eventually } from './support/agent-composition';

test('browser approval executes one authorized tool and interrupt cancels a live run without closing the session', async () => {
  let effects = 0;
  let calls = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doStream: async ({ abortSignal }) => {
      calls += 1;
      if (calls === 1)
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'effect',
                toolName: 'change_item',
                input: '{}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        };
      if (calls === 2)
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'Done' },
              { type: 'text-end', id: 'answer' },
              { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
            ],
          }),
        };
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'text-start', id: 'waiting' });
            abortSignal?.addEventListener(
              'abort',
              () => controller.error(abortSignal.reason),
              { once: true },
            );
          },
        }),
      };
    },
  });
  const harness = compositionHarness({
    models: {
      resolve: () => ({
        descriptor: {
          provider: 'fixture',
          modelId: 'approval',
          contextWindow: 8_000,
          capabilities: ['tools'],
        },
        model,
      }),
    },
    tools: (run) =>
      mountAgent([], {
        context: run.context,
        lifecycle: composeToolLifecycle(undefined, run.toolFenceLifecycle),
        runtimeTools: [
          defineRuntimeTool({
            name: 'change_item',
            description: 'Change an item',
            identity: { serviceName: 'items', action: 'change', method: 'POST' },
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            handler: (ctx) => {
              expect(ctx.owner).toBe('alice');
              effects += 1;
              return { ok: true };
            },
          }),
        ],
      }),
    loop: {
      toolApproval: { change_item: 'user-approval' },
      toolApprovalSecret: 'composition-fixture-secret',
    },
    authorizeApprovalResponse: ({ responder }) =>
      z.object({ owner: z.literal('alice') }).safeParse(responder).success
        ? { status: 'allowed' }
        : { status: 'rejected', reason: 'wrong principal' },
  });
  const socket = await createSocketIOServer({});
  const binding = bindAgentHarnessRealtime(harness, socket, {
    authorize: () => ({ context: { owner: 'alice' } }),
  });
  const server = createServer({ port: 0, socket });
  const transport = createSocketIOClient({
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
  });
  const controller = createAgentController({
    transport,
    conversationId: 'approval',
    access: 'control',
  });
  try {
    transport.connect();
    await eventually(() => controller.getSnapshot().status === 'ready');
    await controller.request({
      operation: 'submit',
      idempotencyKey: 'approval',
      parts: [{ type: 'text', text: 'Change it' }],
    });
    await eventually(
      () =>
        controller
          .getSnapshot()
          .view.conversations.approval?.snapshot?.messages.some((message) =>
            message.parts.some((part) => part.type === 'tool-approval-request'),
          ) ?? false,
    );
    const [pending] = await harness.pendingApprovals('approval');
    if (!pending) throw new Error('Missing approval');
    expect(effects).toBe(0);
    const response = await controller.request({
      operation: 'respond-approval',
      approvalId: pending.approvalId,
      approved: true,
    });
    if (response.outcome !== 'ok' || !response.runId)
      throw new Error('Approval was not admitted');
    const runId = response.runId;
    await eventually(
      () =>
        controller
          .getSnapshot()
          .view.conversations.approval?.snapshot?.runs.some(
            (run) => run.id === runId && run.terminalReason === 'success',
          ) ?? false,
    );
    inspectAgentRun(await harness.snapshot('approval'), runId).completed();
    const proof = await harness.snapshot('approval');
    inspectAgentRun(proof, runId).toolSucceeded('change_item');
    inspectAgentRun(proof, runId).calledTool('change_item');
    const first = proof.messages[0];
    if (!first) throw new Error('Missing input message');
    const prior = {
      ...first,
      id: 'previous-assistant',
      runId: 'previous-run',
      role: 'assistant',
      parts: [
        { type: 'tool-call', callId: 'effect', toolName: 'change_item', input: {} },
        { type: 'tool-result', callId: 'effect', toolName: 'change_item', outcome: 'success' },
      ],
    } satisfies typeof first;
    inspectAgentRun({ ...proof, messages: [prior, ...proof.messages] }, runId).toolSucceeded(
      'change_item',
    );
    const unrelated = {
      ...proof,
      runs: proof.runs.map((run) =>
        run.id === runId ? { ...run, inputMessageIds: ['unrelated'] } : run,
      ),
    };
    expect(() => inspectAgentRun(unrelated, runId).toolSucceeded('change_item')).toThrow(
      'expected successful result',
    );
    const denied = {
      ...proof,
      messages: proof.messages.map((message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.type === 'tool-approval-response' ? { ...part, approved: false } : part,
        ),
      })),
    };
    expect(() => inspectAgentRun(denied, runId).toolSucceeded('change_item')).toThrow(
      'expected successful result',
    );
    expect(effects).toBe(1);
    expect(await harness.pendingApprovals('approval')).toEqual([]);
    const active = await controller.request({
      operation: 'submit',
      idempotencyKey: 'interrupt',
      parts: [{ type: 'text', text: 'Wait' }],
    });
    if (active.outcome !== 'ok' || !active.runId) throw new Error('Run was not admitted');
    await eventually(() => calls === 3);
    expect(
      (await controller.request({ operation: 'interrupt', runId: active.runId })).outcome,
    ).toBe('ok');
    await eventually(
      () =>
        controller
          .getSnapshot()
          .view.conversations.approval?.snapshot?.runs.some(
            (run) => run.id === active.runId && run.state === 'interrupted',
          ) ?? false,
    );
    expect(transport.connected).toBe(true);
  } finally {
    transport.disconnect();
    await controller.close();
    binding.close();
    await harness.close();
    await server.shutdown({ gracePeriodMs: 0 });
  }
}, 15_000);
