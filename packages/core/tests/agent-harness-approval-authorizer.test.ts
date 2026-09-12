import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { createMemoryAgentRuntimeStore, defineAgentProtocol } from '../src/agent-runtime';
import { createAgentCodingTools } from '../src/agent-runtime-coding-tools';
import {
  AgentHarnessApprovalRejectedError,
  createHeadlessAgentHarness,
} from '../src/agent-runtime-harness';
import { mountAgent } from '../src/tools';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

function toolStream(
  id: string,
  name: string,
  input: unknown,
): Awaited<ReturnType<MockLanguageModelV4['doStream']>> {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'tool-call', toolCallId: id, toolName: name, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage },
      ],
    }),
  };
}

function textStream(text: string): Awaited<ReturnType<MockLanguageModelV4['doStream']>> {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: 'text-start', id: 'answer' },
        { type: 'text-delta', id: 'answer', delta: text },
        { type: 'text-end', id: 'answer' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
      ],
    }),
  };
}

describe('approval response-time authorizer', () => {
  test('a rejected responder is recorded and the request stays answerable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-approval-authorizer-'));
    try {
      const model = new MockLanguageModelV4({
        doStream: [
          toolStream('call-1', 'write_file', { path: 'made.txt', content: 'made' }),
          textStream('done'),
        ],
      });
      const store = createMemoryAgentRuntimeStore();
      const presented: unknown[] = [];
      const harness = createHeadlessAgentHarness({
        blockingPresentation: 'parent',
        publish: (event) => {
          presented.push(event);
        },
        protocol: defineAgentProtocol({
          context: z.object({ principalId: z.string() }),
          inputMetadata: z.object({}),
          terminalAcceptance: 'require-output',
        }),
        store,
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'fixture',
              modelId: 'approval-authorizer',
              contextWindow: 16_000,
              capabilities: ['tools'],
            },
            model,
          }),
        },
        resources: { load: () => ({ resources: [], diagnostics: [] }) },
        promptBudget: ({ contextWindow }) => ({
          contextWindow,
          reservedOutput: 1_000,
          toolSchemas: { value: 100, provenance: 'measured' },
          attachments: { value: 0, provenance: 'measured' },
          providerOverhead: { provenance: 'unavailable' },
        }),
        tools: () =>
          mountAgent([], {
            runtimeTools: createAgentCodingTools({ root, authorize: () => true }),
          }),
        loop: {
          idleTimeoutMs: 20,
          toolApproval: { write_file: 'user-approval' },
          toolApprovalSecret: 'authorizer-test-secret',
        },
        // The policy judges the responder, not the request: only the initiating
        // principal may decide.
        authorizeApprovalResponse: ({ responder }) =>
          (responder as { principalId?: string }).principalId === 'owner'
            ? { status: 'allowed' }
            : { status: 'rejected', reason: 'approver is not the initiating principal' },
      });

      await harness.submit({
        conversationId: 'conversation',
        idempotencyKey: 'initial',
        context: { principalId: 'owner' },
        parts: [{ type: 'text', text: 'write a file' }],
        metadata: {},
      }).result;

      const [pending] = await harness.pendingApprovals('conversation');
      if (!pending) throw new Error('approval request missing');
      await Bun.sleep(80);
      expect(JSON.stringify(presented)).not.toContain('tool-approval-request');
      expect(JSON.stringify(await harness.snapshot('conversation'))).not.toContain(
        'tool-approval-request',
      );
      expect(JSON.stringify(await store.loadSnapshot('conversation'))).toContain(
        'tool-approval-request',
      );

      await expect(
        harness.respondToApproval({
          conversationId: 'conversation',
          approvalId: pending.approvalId,
          approved: true,
          context: { principalId: 'intruder' },
        }),
      ).rejects.toBeInstanceOf(AgentHarnessApprovalRejectedError);

      // The refusal judged the responder: the request is still pending and the
      // refusal is on the record with its reason.
      expect(await harness.pendingApprovals('conversation')).toEqual([pending]);
      const rejection = (
        await store.readEvents({ conversationId: 'conversation', limit: 1_000 })
      ).items.find((event) => event.kind === 'approval/response-rejected');
      expect(rejection?.payload).toMatchObject({
        approvalId: pending.approvalId,
        reason: 'approver is not the initiating principal',
      });

      const continuation = await harness.respondToApproval({
        conversationId: 'conversation',
        approvalId: pending.approvalId,
        approved: true,
        context: { principalId: 'owner' },
      });
      expect((await continuation.result).reason).toBe('success');
      expect(await harness.pendingApprovals('conversation')).toEqual([]);
      await harness.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
