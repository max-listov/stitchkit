import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentRunEvent,
  createAgentObservability,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  projectAgentHistory,
  projectAgentHistoryDetailed,
} from '../src/agent-runtime';
import { createAgentCodingTools } from '../src/agent-runtime-coding-tools';
import { createHeadlessAgentHarness } from '../src/agent-runtime-harness';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';
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

describe('durable approval continuations', () => {
  for (const mode of ['user', 'automatic', 'not-applicable', 'denied']) {
    test(`${mode}: two coding operations survive SQLite reopen and a later message`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-approval-chronology-'));
      const filename = path.join(root, 'history.sqlite');
      const effects: string[] = [];
      const events: AgentRunEvent[] = [];
      const observability = createAgentObservability({
        includeInternalCause: true,
        write: (event) => {
          events.push(event);
        },
      });
      let sqlite = createBunSqliteAgentRuntimeStore({ filename });
      const firstIsRead = mode === 'automatic' || mode === 'not-applicable';
      const model = new MockLanguageModelV4({
        doStream: [
          toolStream(
            'first',
            firstIsRead ? 'read_file' : 'write_file',
            firstIsRead
              ? { path: 'seed.txt' }
              : { path: 'first.txt', content: 'first effect' },
          ),
          toolStream('second', 'write_file', { path: 'second.txt', content: 'second effect' }),
          textStream('finished'),
          textStream('later answer'),
        ],
      });
      const open = () =>
        createHeadlessAgentHarness({
          protocol: defineAgentProtocol({
            context: z.object({}),
            inputMetadata: z.object({}),
            terminalAcceptance: 'require-output',
          }),
          store: sqlite.store,
          models: {
            resolve: () => ({
              descriptor: {
                provider: 'fixture',
                modelId: 'approval',
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
          tools: (context) =>
            mountAgent([], {
              runtimeTools: createAgentCodingTools({
                root,
                authorize: (request) => {
                  effects.push(
                    `${request.operation}:${'path' in request ? request.path : ''}`,
                  );
                  return true;
                },
              }),
              lifecycle: context.toolFenceLifecycle,
            }),
          loop: {
            toolApproval: {
              read_file: mode === 'automatic' ? 'approved' : 'not-applicable',
              write_file: 'user-approval',
            },
            toolApprovalSecret: 'chronology-test-secret',
          },
          observe: observability,
        });
      let harness = open();
      try {
        await writeFile(path.join(root, 'seed.txt'), 'seed');
        const initial = await harness.submit({
          conversationId: 'conversation',
          idempotencyKey: 'initial',
          context: {},
          parts: [{ type: 'text', text: 'two operations' }],
          metadata: {},
        }).result;
        expect(initial.reason).toBe('provider_stop');
        if (!firstIsRead) {
          const [pending] = await harness.pendingApprovals('conversation');
          if (!pending) throw new Error('first approval missing');
          expect(pending.callId).toBe('first');
          expect(pending.signature).toBeString();
          const continuation = await harness.respondToApproval({
            conversationId: 'conversation',
            approvalId: pending.approvalId,
            approved: mode !== 'denied',
            context: {},
          });
          expect((await continuation.result).reason).toBe('provider_stop');
        }
        const [before] = await harness.pendingApprovals('conversation');
        if (!before) throw new Error('second approval missing');
        expect(before.callId).toBe('second');
        expect(model.doStreamCalls).toHaveLength(2);
        await harness.close();
        await sqlite.close();
        sqlite = createBunSqliteAgentRuntimeStore({ filename });
        harness = open();
        expect(await harness.pendingApprovals('conversation')).toEqual([before]);
        const continuation = await harness.respondToApproval({
          conversationId: 'conversation',
          approvalId: before.approvalId,
          approved: true,
          context: {},
        });
        const completed = await continuation.result;
        expect(completed.reason).toBe('success');
        expect(model.doStreamCalls).toHaveLength(3);
        expect(await readFile(path.join(root, 'second.txt'), 'utf8')).toBe('second effect');
        if (mode === 'user')
          expect(await readFile(path.join(root, 'first.txt'), 'utf8')).toBe('first effect');
        else await expect(readFile(path.join(root, 'first.txt'))).rejects.toThrow();
        const effectsBefore = [...effects];
        const snapshot = await harness.snapshot('conversation');
        const projected = await projectAgentHistoryDetailed(snapshot.messages);
        expect(projected.decisions.every(({ action }) => action === 'projected')).toBe(true);
        const results = snapshot.messages
          .flatMap(({ parts }) => parts)
          .filter((part) => part.type === 'tool-result');
        expect(results.map(({ callId, outcome }) => [callId, outcome])).toEqual([
          ['first', mode === 'denied' ? 'error' : 'success'],
          ['second', 'success'],
        ]);
        expect(await harness.pendingApprovals('conversation')).toEqual([]);
        await expect(
          harness.respondToApproval({
            conversationId: 'conversation',
            approvalId: before.approvalId,
            approved: true,
            context: {},
          }),
        ).rejects.toThrow('already answered');
        const later = await harness.submit({
          conversationId: 'conversation',
          idempotencyKey: 'later',
          context: {},
          parts: [{ type: 'text', text: 'continue normally' }],
          metadata: {},
        }).result;
        expect(later.reason).toBe('success');
        expect(model.doStreamCalls).toHaveLength(4);
        expect(effects).toEqual(effectsBefore);
        expect(effects).toEqual(
          mode === 'denied'
            ? ['write:second.txt']
            : [firstIsRead ? 'read:seed.txt' : 'write:first.txt', 'write:second.txt'],
        );
        await observability.flush();
        expect(events.some((event) => event.type === 'run-terminal')).toBe(true);
        expect(
          events.filter(
            (event) =>
              event.type === 'run-terminal' && event.terminalReason === 'provider_failure',
          ),
        ).toEqual([]);
      } finally {
        await harness.close();
        await sqlite.close();
        await observability.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  for (const invalid of ['unknown-response', 'unknown-without-request', 'forged-signature']) {
    test(`${invalid}: refuses continuation before effects or a provider call and retains a private cause`, async () => {
      const events: AgentRunEvent[] = [];
      const observe = createAgentObservability({
        includeInternalCause: true,
        write: (event) => {
          events.push(event);
        },
      });
      const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-invalid-approval-'));
      const effects: string[] = [];
      const model = new MockLanguageModelV4({
        doStream: [
          invalid === 'unknown-without-request'
            ? textStream('no tools requested')
            : toolStream('protected', 'write_file', {
                path: 'protected.txt',
                content: 'effect',
              }),
          textStream('must not run'),
        ],
      });
      let corruptSignature = false;
      const harness = createHeadlessAgentHarness({
        protocol: defineAgentProtocol({
          context: z.object({}),
          inputMetadata: z.object({}),
          terminalAcceptance: 'require-output',
        }),
        store: createMemoryAgentRuntimeStore(),
        models: {
          resolve: () => ({
            descriptor: {
              provider: 'fixture',
              modelId: 'invalid-approval',
              contextWindow: 8_000,
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
        tools: (context) =>
          mountAgent([], {
            runtimeTools: createAgentCodingTools({
              root,
              authorize: ({ operation }) => {
                effects.push(operation);
                return true;
              },
            }),
            lifecycle: context.toolFenceLifecycle,
          }),
        loop: {
          toolApproval: { write_file: 'user-approval' },
          toolApprovalSecret: 'invalid-approval-secret',
        },
        ...(invalid === 'forged-signature' && {
          history: {
            project: async (messages) =>
              (await projectAgentHistory(messages)).map((message) => {
                if (
                  !corruptSignature ||
                  message.role !== 'assistant' ||
                  typeof message.content === 'string'
                )
                  return message;
                return {
                  ...message,
                  content: message.content.map((part) =>
                    part.type === 'tool-approval-request'
                      ? { ...part, signature: 'forged-signature' }
                      : part,
                  ),
                };
              }),
          },
        }),
        observe,
      });
      try {
        await harness.submit({
          conversationId: 'invalid',
          idempotencyKey: 'initial',
          context: {},
          parts: [{ type: 'text', text: 'write once' }],
          metadata: {},
        }).result;
        const [pending] = await harness.pendingApprovals('invalid');
        if (!pending && invalid !== 'unknown-without-request')
          throw new Error('expected signed request');
        corruptSignature = true;
        const ticket =
          invalid === 'forged-signature' && pending
            ? await harness.respondToApproval({
                conversationId: 'invalid',
                approvalId: pending.approvalId,
                approved: true,
                context: {},
              })
            : harness.submit({
                conversationId: 'invalid',
                idempotencyKey: 'invalid',
                context: {},
                role: 'tool',
                parts: [
                  { type: 'tool-approval-response', approvalId: 'unknown', approved: true },
                ],
                metadata: {},
              });
        const failed = await ticket.result;
        expect(failed.reason).toBe('provider_failure');
        expect(model.doStreamCalls).toHaveLength(1);
        expect(effects).toEqual([]);
        await observe.flush();
        expect(
          events.some(
            (event) =>
              event.type === 'run-terminal' &&
              event.terminalReason === 'provider_failure' &&
              event.internalCause !== undefined,
          ),
        ).toBe(true);
        expect(JSON.stringify(await harness.snapshot('invalid'))).not.toContain(
          'forged-signature',
        );
      } finally {
        await harness.close();
        await observe.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
