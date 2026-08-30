import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import {
  type AgentPromptBudget,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
  projectAgentHistory,
  structuredCompaction,
} from '../src/agent-runtime';
import {
  type AgentHarnessProfileEvent,
  createAgentHarnessControlServer,
  createAgentHarnessFileResources,
  createHeadlessAgentHarness,
} from '../src/agent-runtime-harness';
import { createBunSqliteAgentRuntimeStore } from '../src/agent-runtime-sqlite-bun';
import { defineRuntimeTool, mountAgent } from '../src/tools';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

function budget(contextWindow: number): AgentPromptBudget {
  return {
    contextWindow,
    reservedOutput: 1_000,
    toolSchemas: { value: 100, provenance: 'measured' },
    attachments: { value: 0, provenance: 'measured' },
    providerOverhead: { provenance: 'unavailable' },
  };
}

describe('published headless Agent harness', () => {
  test('control connections isolate observer/controller leases and detach without closing the harness', async () => {
    const model = new MockLanguageModelV4({
      doStream: [textStream('controlled'), textStream('direct')],
    });
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
            modelId: 'control',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: () => ({}),
    });
    const originalSnapshot = harness.snapshot.bind(harness);
    let failNextSnapshot = true;
    const controlledHarness = new Proxy(harness, {
      get(target, property, receiver) {
        if (property !== 'snapshot') return Reflect.get(target, property, receiver);
        return async (conversationId: string) => {
          if (failNextSnapshot) {
            failNextSnapshot = false;
            throw new Error('snapshot unavailable');
          }
          return originalSnapshot(conversationId);
        };
      },
    });
    const server = createAgentHarnessControlServer(controlledHarness);
    const events: string[] = [];
    const terminal = Promise.withResolvers<void>();
    const controller = server.connect({
      id: 'controller',
      deliver: (delivery) => {
        events.push(delivery.type);
        if (delivery.type === 'event' && delivery.event.type === 'terminal')
          terminal.resolve();
      },
      onOverflow: () => undefined,
    });
    const failedAttach = server.connect({
      id: 'failed-attach',
      deliver: () => undefined,
      onOverflow: () => undefined,
    });
    expect(
      await failedAttach.request({
        schemaVersion: 1,
        requestId: 'failed-attach',
        operation: 'attach',
        conversationId: 'controlled',
        access: 'control',
      }),
    ).toMatchObject({ outcome: 'error', error: { code: 'REQUEST_REJECTED' } });
    failedAttach.close();
    const rival = server.connect({
      id: 'rival',
      deliver: () => undefined,
      onOverflow: () => undefined,
    });
    expect(
      await controller.request({
        schemaVersion: 1,
        requestId: 'attach-controller',
        operation: 'attach',
        conversationId: 'controlled',
        access: 'control',
      }),
    ).toMatchObject({ outcome: 'ok' });
    expect(
      await rival.request({
        schemaVersion: 1,
        requestId: 'attach-rival',
        operation: 'attach',
        conversationId: 'controlled',
        access: 'control',
      }),
    ).toMatchObject({ outcome: 'error', error: { code: 'LEASE_CONFLICT' } });
    expect(
      await controller.request({
        schemaVersion: 1,
        requestId: 'submit',
        operation: 'submit',
        conversationId: 'controlled',
        idempotencyKey: 'one',
        context: {},
        parts: [{ type: 'text', text: 'run' }],
        metadata: {},
      }),
    ).toMatchObject({ outcome: 'ok', runId: expect.any(String) });
    await Promise.race([
      terminal.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error('control terminal delivery timed out');
      }),
    ]);
    expect(events).toContain('event');
    expect(
      await controller.request({
        schemaVersion: 1,
        requestId: 'downgrade',
        operation: 'attach',
        conversationId: 'controlled',
        access: 'observe',
      }),
    ).toMatchObject({ outcome: 'ok' });
    expect(
      await rival.request({
        schemaVersion: 1,
        requestId: 'lease-after-downgrade',
        operation: 'attach',
        conversationId: 'controlled',
        access: 'control',
      }),
    ).toMatchObject({ outcome: 'ok' });
    controller.close();
    const replacement = server.connect({
      id: 'controller',
      deliver: () => undefined,
      onOverflow: () => undefined,
    });
    expect(
      await controller.request({
        schemaVersion: 1,
        requestId: 'stale-handle',
        operation: 'snapshot',
        conversationId: 'controlled',
      }),
    ).toMatchObject({ outcome: 'error', error: { code: 'CONNECTION_CLOSED' } });
    replacement.close();
    server.close();
    expect(
      (
        await harness.submit({
          conversationId: 'direct-after-control-close',
          idempotencyKey: 'two',
          context: {},
          parts: [{ type: 'text', text: 'still open' }],
          metadata: {},
        }).result
      ).reason,
    ).toBe('success');
    rival.close();
    await harness.close();
  });

  test('discovers explicit roots with lazy exact skill reads and opaque provenance', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-resources-'));
    roots.push(root);
    const skills = path.join(root, 'skills');
    await mkdir(path.join(skills, 'review'), { recursive: true });
    await writeFile(
      path.join(skills, 'review', 'SKILL.md'),
      '---\nname: "review"\ndescription: >\n  Review a change\n  carefully.\n---\n\nSecret body.',
    );
    const discovered = createAgentHarnessFileResources({
      roots: [{ id: 'skills', path: skills, kind: 'skill' }],
    });
    const loaded = await discovered.load();
    expect(loaded.resources).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'review',
        provenance: 'skills:review/SKILL.md',
      }),
    ]);
    expect(loaded.resources[0]?.text).not.toContain('Secret body.');
    await writeFile(
      path.join(skills, 'review', 'SKILL.md'),
      "---\nname: 'changed'\ndescription: changed\n---\n\nChanged body.",
    );
    expect(await discovered.load()).toBe(loaded);
    const tools = mountAgent([], { runtimeTools: discovered.runtimeTools });
    const execute = tools.read_resource?.execute;
    if (!execute) throw new Error('expected read_resource');
    expect(
      await execute(
        { name: 'review' },
        { toolCallId: 'resource', messages: [], context: undefined },
      ),
    ).toEqual(
      expect.objectContaining({
        name: 'review',
        text: expect.stringContaining('Secret body.'),
      }),
    );
    const refreshed = createAgentHarnessFileResources({
      roots: [{ id: 'skills', path: skills, kind: 'skill' }],
    });
    expect((await refreshed.load()).resources[0]?.name).toBe('changed');
  });

  if (process.platform !== 'win32') {
    test('resource discovery refuses a symlinked ancestor instead of reading outside its root', async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-resource-containment-'));
      roots.push(root);
      const resources = path.join(root, 'resources');
      const outside = path.join(root, 'outside');
      await mkdir(resources);
      await mkdir(outside);
      await writeFile(path.join(outside, 'secret.md'), 'outside secret');
      await symlink(outside, path.join(resources, 'escaped'), 'dir');
      const discovered = createAgentHarnessFileResources({
        roots: [{ id: 'resources', path: resources, kind: 'resource' }],
      });
      await expect(discovered.load()).rejects.toThrow('refuses symlink');
    });
  }

  test('signals control resync on bounded-delivery overflow without blocking a run', async () => {
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
            modelId: 'overflow',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: new MockLanguageModelV4({ doStream: [textStream('complete')] }),
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: () => ({}),
    });
    const blocked = Promise.withResolvers<void>();
    const resync = Promise.withResolvers<void>();
    let deliveries = 0;
    const server = createAgentHarnessControlServer(harness, { maxPendingEvents: 1 });
    const observer = server.connect({
      id: 'slow-observer',
      deliver: () => {
        deliveries += 1;
        if (deliveries === 1) return blocked.promise;
      },
      onOverflow: () => resync.resolve(),
    });
    await observer.request({
      schemaVersion: 1,
      requestId: 'attach',
      operation: 'attach',
      conversationId: 'overflow',
      access: 'observe',
    });
    expect(
      (
        await harness.submit({
          conversationId: 'overflow',
          idempotencyKey: 'run',
          context: {},
          parts: [{ type: 'text', text: 'run' }],
          metadata: {},
        }).result
      ).reason,
    ).toBe('success');
    await expect(
      Promise.race([resync.promise.then(() => true), Bun.sleep(1_000).then(() => false)]),
    ).resolves.toBe(true);
    blocked.resolve();
    observer.close();
    server.close();
    await harness.close();
  });

  test('continues an exact signed tool approval through a durable tool-role message', async () => {
    let effects = 0;
    const dangerous = defineRuntimeTool({
      name: 'dangerous_change',
      description: 'Apply one fixture effect.',
      identity: { serviceName: 'fixture', action: 'dangerous-change', method: 'POST' },
      input: z.object({ value: z.string() }),
      output: z.object({ ok: z.literal(true) }),
      transports: ['AGENT'],
      handler: () => {
        effects += 1;
        return { ok: true as const };
      },
    });
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'approval-call',
                toolName: 'dangerous_change',
                input: JSON.stringify({ value: 'exact' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
        textStream('approved and complete'),
        textStream('recent answer'),
      ],
    });
    const store = createMemoryAgentRuntimeStore();
    const harness = createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: 'require-output',
      }),
      store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'approval-model',
            contextWindow: 8_000,
            capabilities: ['tools'],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: (context) =>
        mountAgent([], { runtimeTools: [dangerous], lifecycle: context.toolFenceLifecycle }),
      loop: {
        toolApproval: { dangerous_change: 'user-approval' },
        toolApprovalSecret: 'fixture-approval-secret',
      },
    });
    const requested = await harness.submit({
      conversationId: 'approval',
      idempotencyKey: 'request',
      context: {},
      parts: [{ type: 'text', text: 'change it' }],
      metadata: {},
    }).result;
    expect(requested.reason).toBe('provider_stop');
    expect(effects).toBe(0);
    const [pending] = await harness.pendingApprovals('approval');
    expect(pending).toMatchObject({ callId: 'approval-call', toolName: 'dangerous_change' });
    expect(pending?.signature).toBeString();
    expect(
      JSON.stringify(await projectAgentHistory((await harness.snapshot('approval')).messages)),
    ).toContain(pending?.signature ?? 'missing');
    if (!pending) throw new Error('expected pending approval');
    const continuation = await harness.respondToApproval({
      conversationId: 'approval',
      approvalId: pending.approvalId,
      approved: true,
      context: {},
    });
    const completed = await continuation.result;
    expect(completed.reason).toBe('success');
    expect(effects).toBe(1);
    expect(await harness.pendingApprovals('approval')).toEqual([]);
    await expect(
      harness.respondToApproval({
        conversationId: 'approval',
        approvalId: pending.approvalId,
        approved: true,
        context: {},
      }),
    ).rejects.toThrow('missing, stale or already answered');
    expect(
      (
        await harness.submit({
          conversationId: 'approval',
          idempotencyKey: 'recent',
          context: {},
          parts: [{ type: 'text', text: 'next' }],
          metadata: {},
        }).result
      ).reason,
    ).toBe('success');
    const compact = structuredCompaction({
      schema: z.object({ summary: z.string() }),
      keepRecentTurns: 1,
      threshold: () => true,
      summarize: ({ eligibleMessages }) => ({
        summary: eligibleMessages.map(({ id }) => id).join(','),
      }),
      createSummaryMessage: ({ conversationId, summary }) => ({
        schemaVersion: 1,
        id: 'approval-summary',
        conversationId,
        role: 'summary',
        status: 'committed',
        parts: [{ type: 'text', text: summary.summary }],
        createdAt: '2026-08-30T00:00:00.000Z',
        updatedAt: '2026-08-30T00:00:00.000Z',
      }),
    });
    const compacted = await compact({
      conversationId: 'approval',
      store,
      signal: new AbortController().signal,
    });
    expect(compacted.outcome).toBe('applied');
    expect(compacted.snapshot.messages[0]?.id).toBe('approval-summary');
    await harness.close();
  });

  test('reconstructs a pending approval after SQLite reopen without replaying the effect', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-approval-recovery-'));
    roots.push(root);
    const filename = path.join(root, 'runtime.sqlite');
    let effects = 0;
    const effect = defineRuntimeTool({
      name: 'recoverable_change',
      description: 'Apply one recoverable fixture effect.',
      identity: { serviceName: 'fixture', action: 'recoverable-change', method: 'POST' },
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      transports: ['AGENT'],
      handler: () => {
        effects += 1;
        return { ok: true as const };
      },
    });
    const protocol = defineAgentProtocol({
      context: z.object({}),
      inputMetadata: z.object({}),
      terminalAcceptance: 'allow-empty',
    });
    const firstModel = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'recovery-call',
                toolName: 'recoverable_change',
                input: '{}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
      ],
    });
    const firstStore = createBunSqliteAgentRuntimeStore({ filename });
    const first = createHeadlessAgentHarness({
      protocol,
      store: firstStore.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'first',
            contextWindow: 8_000,
            capabilities: ['tools'],
          },
          model: firstModel,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: (context) =>
        mountAgent([], { runtimeTools: [effect], lifecycle: context.toolFenceLifecycle }),
      loop: {
        toolApproval: { recoverable_change: 'user-approval' },
        toolApprovalSecret: 'recovery-secret',
      },
    });
    await first.submit({
      conversationId: 'approval-recovery',
      idempotencyKey: 'request',
      context: {},
      parts: [{ type: 'text', text: 'apply' }],
      metadata: {},
    }).result;
    expect(effects).toBe(0);
    await first.close();
    await firstStore.close();

    const secondStore = createBunSqliteAgentRuntimeStore({ filename });
    const secondModel = new MockLanguageModelV4({ doStream: [textStream('recovered')] });
    const second = createHeadlessAgentHarness({
      protocol,
      store: secondStore.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'second',
            contextWindow: 8_000,
            capabilities: ['tools'],
          },
          model: secondModel,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: (context) =>
        mountAgent([], { runtimeTools: [effect], lifecycle: context.toolFenceLifecycle }),
      loop: {
        toolApproval: { recoverable_change: 'user-approval' },
        toolApprovalSecret: 'recovery-secret',
      },
    });
    const [pending] = await second.pendingApprovals('approval-recovery');
    if (!pending) throw new Error('expected recovered approval');
    const ticket = await second.respondToApproval({
      conversationId: 'approval-recovery',
      approvalId: pending.approvalId,
      approved: true,
      context: {},
    });
    expect((await ticket.result).reason).toBe('success');
    expect(effects).toBe(1);
    await second.close();
    await secondStore.close();
  });

  test('persists a denied approval as provider-facing evidence without executing the tool', async () => {
    let effects = 0;
    const denied = defineRuntimeTool({
      name: 'denied_change',
      description: 'Must not run after denial.',
      identity: { serviceName: 'fixture', action: 'denied-change', method: 'POST' },
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      transports: ['AGENT'],
      handler: () => {
        effects += 1;
        return { ok: true as const };
      },
    });
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'denied-call',
                toolName: 'denied_change',
                input: '{}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
        textStream('denial observed'),
      ],
    });
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
            modelId: 'denial',
            contextWindow: 8_000,
            capabilities: ['tools'],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: (context) =>
        mountAgent([], { runtimeTools: [denied], lifecycle: context.toolFenceLifecycle }),
      loop: {
        toolApproval: { denied_change: 'user-approval' },
        toolApprovalSecret: 'denial-secret',
      },
    });
    await harness.submit({
      conversationId: 'denial',
      idempotencyKey: 'request',
      context: {},
      parts: [{ type: 'text', text: 'try it' }],
      metadata: {},
    }).result;
    const [pending] = await harness.pendingApprovals('denial');
    if (!pending) throw new Error('expected denied approval request');
    const continuation = await harness.respondToApproval({
      conversationId: 'denial',
      approvalId: pending.approvalId,
      approved: false,
      reason: 'not allowed',
      context: {},
    });
    expect((await continuation.result).reason).toBe('success');
    expect(effects).toBe(0);
    expect(
      JSON.stringify(await projectAgentHistory((await harness.snapshot('denial')).messages)),
    ).toContain('not allowed');
    await harness.close();
  });

  test('switches caller-provided models without changing direct tool or resource identity', async () => {
    const calls: string[] = [];
    const lifecycle: string[] = [];
    const profiles: AgentHarnessProfileEvent[] = [];
    const modelA = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'call-a',
                toolName: 'workspace_echo',
                input: JSON.stringify({ value: 'A' }),
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
        textStream('model-a'),
      ],
    });
    const modelB = new MockLanguageModelV4({ doStream: [textStream('model-b')] });
    const echo = defineRuntimeTool({
      name: 'workspace_echo',
      description: 'Echo a workspace value.',
      identity: { serviceName: 'workspace', action: 'echo', method: 'POST' },
      input: z.object({ value: z.string() }),
      output: z.object({ value: z.string() }),
      transports: ['AGENT'],
      handler: ({ input }) => {
        calls.push(input.value);
        return input;
      },
    });
    const harness = createHeadlessAgentHarness({
      protocol: defineAgentProtocol({
        context: z.object({ model: z.enum(['a', 'b']) }),
        inputMetadata: z.object({}),
        terminalAcceptance: 'require-output',
      }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: ({ context }) => ({
          descriptor: {
            provider: 'fixture',
            modelId: context.model === 'a' ? 'model-a' : 'model-b',
            contextWindow: 8_000,
            capabilities: ['tools'],
          },
          model: context.model === 'a' ? modelA : modelB,
        }),
      },
      resources: {
        load: () => ({
          resources: [
            {
              kind: 'skill',
              name: 'workspace-policy',
              text: 'Use direct workspace tools.',
              provenance: 'fixture:skill',
            },
          ],
          diagnostics: [],
        }),
      },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      estimateResourceTokens: () => ({ value: 4, provenance: 'measured' }),
      tools: (context) =>
        mountAgent([], {
          runtimeTools: [echo],
          context: context.context,
          lifecycle: {
            beforeHandle: (_toolContext, operation) => {
              if (!operation.toolName) throw new Error('expected direct tool identity');
              lifecycle.push(operation.toolName);
            },
          },
        }),
      onProfile: (event) => {
        profiles.push(event);
      },
    });

    const run = (conversationId: string, model: 'a' | 'b') =>
      harness.submit({
        conversationId,
        idempotencyKey: `input-${model}`,
        context: { model },
        parts: [{ type: 'text', text: 'run' }],
        metadata: {},
      }).result;
    const [first, second] = await Promise.all([
      run('conversation-a', 'a'),
      run('conversation-b', 'b'),
    ]);

    expect(first.reason).toBe('success');
    expect(second.reason).toBe('success');
    expect(calls).toEqual(['A']);
    expect(lifecycle).toEqual(['workspace_echo']);
    expect(profiles.map(({ model }) => model.modelId).sort()).toEqual(['model-a', 'model-b']);
    expect(
      profiles.every(
        ({ resources, toolNames }) =>
          resources[0]?.provenance === 'fixture:skill' && toolNames.includes('workspace_echo'),
      ),
    ).toBe(true);
    expect((await harness.snapshot('conversation-a')).messages.length).toBeGreaterThan(1);
    await harness.close();
  });

  test('store reopen retains completed tool history and recover does not replay it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stitchkit-harness-'));
    roots.push(root);
    const filename = path.join(root, 'runtime.sqlite');
    let effects = 0;
    const effect = defineRuntimeTool({
      name: 'durable_effect',
      description: 'Record one fixture effect.',
      identity: { serviceName: 'fixture', action: 'effect', method: 'POST' },
      input: z.object({}),
      output: z.object({ ok: z.literal(true) }),
      transports: ['AGENT'],
      handler: (): { ok: true } => {
        effects += 1;
        return { ok: true };
      },
    });
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              {
                type: 'tool-call',
                toolCallId: 'effect-1',
                toolName: 'durable_effect',
                input: '{}',
              },
              {
                type: 'finish',
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage,
              },
            ],
          }),
        },
        textStream('done'),
      ],
    });
    const protocol = defineAgentProtocol({
      context: z.object({}),
      inputMetadata: z.object({}),
      terminalAcceptance: 'require-output',
    });
    const sqlite = createBunSqliteAgentRuntimeStore({ filename });
    const harness = createHeadlessAgentHarness({
      protocol,
      store: sqlite.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'effect-model',
            contextWindow: 8_000,
            capabilities: ['tools'],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: (context) =>
        mountAgent([], {
          runtimeTools: [effect],
          lifecycle: context.toolFenceLifecycle,
        }),
    });
    await harness.submit({
      conversationId: 'durable',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'run' }],
      metadata: {},
    }).result;
    await harness.close();
    await sqlite.close();

    const reopened = createBunSqliteAgentRuntimeStore({ filename });
    const replacementModel = new MockLanguageModelV4({ doStream: [textStream('unexpected')] });
    const restarted = createHeadlessAgentHarness({
      protocol,
      store: reopened.store,
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'fixture',
            modelId: 'replacement',
            contextWindow: 8_000,
            capabilities: [],
          },
          model: replacementModel,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: () => ({}),
    });
    expect((await restarted.snapshot('durable')).messages).toContainEqual(
      expect.objectContaining({ role: 'assistant', status: 'completed' }),
    );
    expect(await restarted.recover({ resolveContext: () => ({}) })).toEqual([]);
    expect(effects).toBe(1);
    expect(replacementModel.doStreamCalls).toHaveLength(0);
    await restarted.close();
    await reopened.close();
  });

  test('profile observer failures are isolated from execution', async () => {
    let observedError = false;
    const model = new MockLanguageModelV4({ doStream: [textStream('ok')] });
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
            modelId: 'observer',
            contextWindow: 8_000,
            capabilities: [],
          },
          model,
        }),
      },
      resources: { load: () => ({ resources: [], diagnostics: [] }) },
      promptBudget: ({ contextWindow }) => budget(contextWindow),
      tools: () => ({}),
      onProfile: () => {
        throw new Error('observer failed');
      },
      onProfileError: () => {
        observedError = true;
      },
    });
    const result = await harness.submit({
      conversationId: 'observer',
      idempotencyKey: 'one',
      context: {},
      parts: [{ type: 'text', text: 'run' }],
      metadata: {},
    }).result;
    expect(result.reason).toBe('success');
    expect(observedError).toBe(true);
    await harness.close();
  });
});
