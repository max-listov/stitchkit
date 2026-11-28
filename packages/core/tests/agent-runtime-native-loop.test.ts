import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  AgentInvalidToolApprovalSignatureError,
  AgentToolApprovalError,
  AgentToolCallNotFoundForApprovalError,
  canonicalApprovalJson,
  collectApprovalContinuations,
  evaluateToolApprovalPolicy,
  signToolApproval,
  verifyToolApprovalSignature,
} from '../src/agent-runtime/run-approval';
import { createRunHistoryProjection } from '../src/agent-runtime/run-prompt-history';
import {
  AgentInvalidToolInputError,
  type AgentModelDriver,
  type AgentModelMessage,
  type AgentModelRequest,
  type AgentModelStreamPart,
  AgentProviderError,
  type AgentRuntimeConfig,
  AgentRuntimeConflictError,
  type AgentRuntimeStopPolicy,
  type AgentStepResult,
  type AgentStepSpend,
  AgentUnknownToolError,
  type AgentUsage,
  type ComposedAgentPrompt,
  carriedToolWork,
  createAgentObservability,
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  createModelInvocationLedger,
  createToolDependencyResolver,
  defineAgentProtocol,
  defineModelRegistry,
  isAgentProviderError,
  projectAgentHistory,
  recordAgentRetryDecision,
} from '../src/entrypoints/agent-runtime';
import { fromAiSdkModel } from '../src/entrypoints/agent-runtime/ai-sdk';
import { anthropicProvider } from '../src/entrypoints/agent-runtime/anthropic';
import { openAiProvider } from '../src/entrypoints/agent-runtime/openai';
import { openRouterProvider } from '../src/entrypoints/agent-runtime/openrouter';
import { createScriptedModelDriver } from '../src/entrypoints/agent-runtime/testing';
import {
  type AgentTool,
  AgentToolError,
  type AgentToolSet,
  defineAgentTool,
  defineRuntimeTool,
  defineViewFileTool,
  mountAgentTools,
} from '../src/entrypoints/tools';

function makeTool<T extends z.ZodType>(config: {
  description: string;
  input: T;
  needsApproval?: boolean;
  execute: (input: z.output<T>) => unknown | Promise<unknown>;
}): AgentTool {
  const built = defineAgentTool(config);
  const parseInput = built.parseInput;
  return {
    description: built.description,
    inputSchema: built.inputSchema,
    ...(config.needsApproval !== undefined && { needsApproval: config.needsApproval }),
    ...(parseInput && { parseInput: (value) => parseInput(value) }),
    execute: (input) => config.execute(config.input.parse(input)),
  };
}

function emptyPrompt(instructions: string): ComposedAgentPrompt {
  return {
    instructions,
    sections: [],
    instructionTokens: { provenance: 'unavailable' },
    contextDecision: 'unavailable',
  };
}

function usage(input: number, output: number): AgentUsage {
  return {
    inputTokens: { value: input, provenance: 'provider-reported' },
    outputTokens: { value: output, provenance: 'provider-reported' },
  };
}

function finish(
  finishReason: 'stop' | 'length' | 'tool-calls' | 'error' = 'stop',
  extra?: Partial<Extract<AgentModelStreamPart, { type: 'finish' }>>,
): AgentModelStreamPart {
  return {
    type: 'finish',
    finishReason,
    usage: usage(20, 10),
    ...extra,
  };
}

const TEST_DESCRIPTOR = {
  provider: 'scripted',
  modelId: 'scripted-1',
  contextWindow: 128_000,
  capabilities: ['tools', 'reasoning', 'vision', 'files'] satisfies Array<
    'tools' | 'reasoning' | 'vision' | 'files'
  >,
};

function makeRuntime(options: {
  driver: AgentModelDriver;
  tools?: AgentToolSet;
  store?: ReturnType<typeof createMemoryAgentRuntimeStore>;
  instructions?: string;
  loop?: AgentRuntimeConfig<Record<string, never>, AgentToolSet>['loop'];
  protocol?: AgentRuntimeConfig<Record<string, never>, AgentToolSet>['protocol'];
  onStepSpend?: AgentRuntimeConfig<Record<string, never>, AgentToolSet>['onStepSpend'];
  observe?: AgentRuntimeConfig<Record<string, never>, AgentToolSet>['observe'];
  history?: AgentRuntimeConfig<Record<string, never>, AgentToolSet>['history'];
  persistGeneratedFile?: AgentRuntimeConfig<
    Record<string, never>,
    AgentToolSet
  >['persistGeneratedFile'];
}) {
  const store = options.store ?? createMemoryAgentRuntimeStore();
  const runtime = createAgentRuntime({
    store,
    protocol:
      options.protocol ??
      defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
    models: {
      resolve: () => ({
        descriptor: { ...TEST_DESCRIPTOR },
        driver: options.driver,
      }),
    },
    prompt: () => emptyPrompt(options.instructions ?? 'You are a test assistant.'),
    tools: () => options.tools ?? {},
    ...(options.loop && { loop: options.loop }),
    ...(options.onStepSpend && { onStepSpend: options.onStepSpend }),
    ...(options.observe && { observe: options.observe }),
    ...(options.history && { history: options.history }),
    ...(options.persistGeneratedFile && {
      persistGeneratedFile: options.persistGeneratedFile,
    }),
  });
  return { store, runtime };
}

function userInput(
  conversationId: string,
  text: string,
  idempotencyKey = crypto.randomUUID(),
) {
  return {
    conversationId,
    idempotencyKey,
    context: {},
    parts: [{ type: 'text' as const, text }],
  };
}

describe('P0-1: retry on throws, Retry-After, wall-clock budget, and onAttemptDiscarded', () => {
  test('retries on driver.stream() 429 throw with retryAfterMs and invokes onAttemptDiscarded', async () => {
    const driver = createScriptedModelDriver({
      steps: [
        {
          throw: new AgentProviderError('Rate limited', {
            provider: 'scripted',
            statusCode: 429,
            retryAfterMs: 15,
          }),
        },
        [{ type: 'text-delta', id: 't1', delta: 'Recovered!' }, finish('stop')],
      ],
    });

    const seenDelays: Array<{ attempt: number; retryAfterMs?: number; reason: string }> = [];
    const discarded: Array<{ attempt: number; reason: string }> = [];

    const { runtime } = makeRuntime({
      driver,
      loop: {
        retry: {
          maxAttempts: 2,
          delayMs: ({ attempt, failure }) => {
            seenDelays.push({
              attempt,
              retryAfterMs: failure.retryAfterMs,
              reason: failure.reason,
            });
            return 0;
          },
        },
        onAttemptDiscarded: ({ attempt, reason }) => {
          discarded.push({ attempt, reason });
        },
      },
    });

    const outcome = await runtime.submit(userInput('conv-retry-429', 'hi')).result;
    expect(outcome.reason).toBe('success');
    expect(outcome.message.parts.find((p) => p.type === 'text')).toEqual({
      type: 'text',
      text: 'Recovered!',
    });
    expect(seenDelays).toEqual([{ attempt: 1, retryAfterMs: 15, reason: 'rate-limited' }]);
    expect(discarded).toEqual([{ attempt: 1, reason: 'rate-limited' }]);
    expect(driver.requests).toHaveLength(2);
  });

  test('retries on silent stream cut (AgentProviderStreamCutError) and does NOT retry runtime-owned throws', async () => {
    const cutDriver = createScriptedModelDriver({
      steps: [
        [{ type: 'text-delta', id: 't1', delta: 'partial' }],
        [{ type: 'text-delta', id: 't2', delta: 'complete' }, finish('stop')],
      ],
    });
    const { runtime: cutRuntime } = makeRuntime({
      driver: cutDriver,
      loop: { retry: { maxAttempts: 2, delayMs: () => 0 } },
    });
    const cutResult = await cutRuntime.submit(userInput('conv-cut', 'go')).result;
    expect(cutResult.reason).toBe('success');
    expect(cutDriver.requests).toHaveLength(2);

    // Negative control: runtime-owned error (AgentRuntimeConflictError) must NEVER be retried.
    const conflictDriver = createScriptedModelDriver({
      steps: [
        { throw: new AgentRuntimeConflictError('CAS lost') },
        [{ type: 'text-delta', id: 't2', delta: 'should not happen' }, finish('stop')],
      ],
    });
    const { runtime: conflictRuntime } = makeRuntime({
      driver: conflictDriver,
      loop: { retry: { maxAttempts: 3, delayMs: () => 0 } },
    });
    const conflictResult = await conflictRuntime.submit(userInput('conv-conflict', 'go'))
      .result;
    expect(conflictResult.reason).toBe('storage_conflict');
    expect(conflictDriver.requests).toHaveLength(1);
  });

  test('recordAgentRetryDecision enforces maxRetryDurationMs wall-clock budget', async () => {
    const store = createMemoryAgentRuntimeStore();
    const policy = {
      maxAttempts: 5,
      maxRetryDurationMs: 1_000,
      delayMs: () => 300,
    };
    const failure = {
      retryable: true,
      reason: 'rate-limited' as const,
      evidence: 'status' as const,
    };

    const ok = await recordAgentRetryDecision({
      store,
      conversationId: 'conv-budget',
      policy,
      attempt: 1,
      failure,
      elapsedMs: 600,
    });
    expect(ok.retry).toBe(true);
    expect(ok.delayMs).toBe(300);

    // elapsedMs (800) + delayMs (300) > 1000 -> budget exhausted.
    const overDelay = await recordAgentRetryDecision({
      store,
      conversationId: 'conv-budget',
      policy,
      attempt: 2,
      failure,
      elapsedMs: 800,
    });
    expect(overDelay.retry).toBe(false);

    // elapsedMs >= maxRetryDurationMs -> budget exhausted.
    const overElapsed = await recordAgentRetryDecision({
      store,
      conversationId: 'conv-budget',
      policy,
      attempt: 2,
      failure,
      elapsedMs: 1_000,
    });
    expect(overElapsed.retry).toBe(false);
  });
});

describe('P0-2: no double approval side-effects on retry & clean reasoning reset', () => {
  test('approved tool runs ONCE before retry loop even when subsequent model step retries', async () => {
    let executions = 0;
    const tools = {
      charge: makeTool({
        description: 'Charge card once',
        input: z.object({ amount: z.number() }),
        needsApproval: true,
        execute: async ({ amount }) => {
          executions += 1;
          return { charged: amount, count: executions };
        },
      }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        // Turn 1: model requests charge -> parks for approval.
        [
          {
            type: 'tool-call',
            toolCallId: 'call-charge',
            toolName: 'charge',
            input: JSON.stringify({ amount: 50 }),
          },
          finish('tool-calls'),
        ],
        // Turn 2 attempt 1: fails with 503 after approved tool already executed.
        {
          throw: new AgentProviderError('Upstream 503', {
            provider: 'scripted',
            statusCode: 503,
          }),
        },
        // Turn 2 attempt 2: succeeds with final answer.
        [{ type: 'text-delta', id: 't2', delta: 'Charged once.' }, finish('stop')],
      ],
    });

    const store = createMemoryAgentRuntimeStore();
    const { runtime } = makeRuntime({
      driver,
      tools,
      store,
      loop: {
        toolApprovalSecret: 'test-hmac-secret',
        retry: { maxAttempts: 2, delayMs: () => 0 },
      },
    });

    const turn1 = await runtime.submit(userInput('conv-apr-retry', 'Charge $50')).result;
    expect(turn1.reason).toBe('provider_stop');
    const aprReq = turn1.message.parts.find((p) => p.type === 'tool-approval-request');
    expect(aprReq?.type).toBe('tool-approval-request');
    if (aprReq?.type !== 'tool-approval-request') return;

    // Submit approval response -> Turn 2 executes charge ONCE, then retries step 0 on 503.
    const turn2 = await runtime.submit({
      conversationId: 'conv-apr-retry',
      idempotencyKey: 'apr-msg-1',
      role: 'tool',
      parts: [
        {
          type: 'tool-approval-response',
          approvalId: aprReq.approvalId,
          approved: true,
        },
      ],
      context: {},
    }).result;

    expect(turn2.reason).toBe('success');
    expect(executions).toBe(1);
    expect(turn2.message.parts.some((p) => p.type === 'tool-result')).toBe(true);
    expect(
      turn2.message.parts.some((p) => p.type === 'text' && p.text === 'Charged once.'),
    ).toBe(true);
  });

  test('provider tool-call blocks retry on subsequent error part and retry resets reasoning indexes', async () => {
    // 1. Provider tool-call followed by error part -> must NOT retry.
    const noRetryDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'srv-1',
            toolName: 'web_search',
            input: '{}',
            providerExecuted: true,
          },
          {
            type: 'error',
            error: new AgentProviderError('503', { provider: 'scripted', statusCode: 503 }),
          },
        ],
        [{ type: 'text-delta', id: 't2', delta: 'must not retry' }, finish('stop')],
      ],
    });
    const { runtime: r1 } = makeRuntime({
      driver: noRetryDriver,
      loop: { retry: { maxAttempts: 3, delayMs: () => 0 } },
    });
    const res1 = await r1.submit(userInput('conv-prov-tool-noretry', 'search')).result;
    expect(res1.reason).toBe('provider_failure');
    expect(noRetryDriver.requests).toHaveLength(1);

    // 2. Reasoning streamed before retry reset is cleared cleanly on attempt 2.
    const reasoningRetryDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'discarded thought' },
          {
            type: 'error',
            error: new AgentProviderError('503', { provider: 'scripted', statusCode: 503 }),
          },
        ],
        [
          { type: 'reasoning-start', id: 'r1' },
          { type: 'reasoning-delta', id: 'r1', delta: 'fresh thought' },
          { type: 'reasoning-end', id: 'r1' },
          { type: 'text-delta', id: 't1', delta: 'done' },
          finish('stop'),
        ],
      ],
    });
    const { runtime: r2 } = makeRuntime({
      driver: reasoningRetryDriver,
      loop: { retry: { maxAttempts: 2, delayMs: () => 0 } },
    });
    const res2 = await r2.submit(userInput('conv-reason-reset', 'think')).result;
    expect(res2.reason).toBe('success');
    const reasoningParts = res2.message.parts.filter((p) => p.type === 'reasoning');
    expect(reasoningParts).toEqual([{ type: 'reasoning', text: 'fresh thought' }]);
  });
});

describe('P0-4: multi-block reasoning, empty redacted reasoning, and text provider envelopes', () => {
  test('preserves ordered multi-block reasoning, empty redacted reasoning, and text provider metadata', async () => {
    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'reasoning-start',
            id: 'r1',
            provider: {
              schemaVersion: 1,
              provider: 'anthropic',
              data: { signature: 'sig-1' },
            },
          },
          { type: 'reasoning-delta', id: 'r1', delta: 'First block' },
          { type: 'reasoning-end', id: 'r1' },
          // Empty redacted/encrypted reasoning block with provider envelope on end.
          { type: 'reasoning-start', id: 'r2' },
          {
            type: 'reasoning-end',
            id: 'r2',
            provider: {
              schemaVersion: 1,
              provider: 'anthropic',
              data: { redactedData: 'enc-blob' },
            },
          },
          { type: 'reasoning-start', id: 'r3' },
          { type: 'reasoning-delta', id: 'r3', delta: 'Third block' },
          {
            type: 'reasoning-end',
            id: 'r3',
            provider: {
              schemaVersion: 1,
              provider: 'anthropic',
              data: { signature: 'sig-3' },
            },
          },
          {
            type: 'text-start',
            id: 't1',
            provider: { schemaVersion: 1, provider: 'openai', data: { phase: 'final' } },
          },
          { type: 'text-delta', id: 't1', delta: 'Final answer.' },
          { type: 'text-end', id: 't1' },
          finish('stop'),
        ],
      ],
    });

    const { store, runtime } = makeRuntime({ driver });
    const outcome = await runtime.submit(userInput('conv-multi-reason', 'solve')).result;
    expect(outcome.reason).toBe('success');

    expect(outcome.message.parts).toEqual([
      {
        type: 'reasoning',
        text: 'First block',
        provider: { schemaVersion: 1, provider: 'anthropic', data: { signature: 'sig-1' } },
      },
      {
        type: 'reasoning',
        text: '',
        provider: {
          schemaVersion: 1,
          provider: 'anthropic',
          data: { redactedData: 'enc-blob' },
        },
      },
      {
        type: 'reasoning',
        text: 'Third block',
        provider: { schemaVersion: 1, provider: 'anthropic', data: { signature: 'sig-3' } },
      },
      {
        type: 'text',
        text: 'Final answer.',
        provider: { schemaVersion: 1, provider: 'openai', data: { phase: 'final' } },
      },
    ]);

    // Verify history projection preserves all 4 blocks and their individual providerOptions.
    const snapshot = await store.loadSnapshot('conv-multi-reason');
    const projected = await projectAgentHistory(snapshot.messages);
    const assistantMsg = projected.find((m) => m.role === 'assistant');
    expect(assistantMsg?.role).toBe('assistant');
    if (assistantMsg?.role === 'assistant') {
      expect(assistantMsg.content).toEqual([
        {
          type: 'reasoning',
          text: 'First block',
          providerOptions: { anthropic: { signature: 'sig-1' } },
        },
        {
          type: 'reasoning',
          text: '',
          providerOptions: { anthropic: { redactedData: 'enc-blob' } },
        },
        {
          type: 'reasoning',
          text: 'Third block',
          providerOptions: { anthropic: { signature: 'sig-3' } },
        },
        {
          type: 'text',
          text: 'Final answer.',
          providerOptions: { openai: { phase: 'final' } },
        },
      ]);
    }
  });
});

describe('P0-5 & B4: tool errors, activeTools enforcement, deterministic order, beforeStepToolCalls, and CAS safety', () => {
  test('AgentUnknownToolError & AgentInvalidToolInputError are PII-safe', () => {
    const unknown = new AgentUnknownToolError('secret_tool', { activeTools: ['ping'] });
    expect(unknown.toolName).toBe('secret_tool');
    expect(unknown.activeTools).toEqual(['ping']);
    expect(unknown.message).toContain('secret_tool');

    const parsed = z
      .object({ apiKey: z.string().min(20) })
      .safeParse({ apiKey: 'RAW_SECRET_99' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const invalid = new AgentInvalidToolInputError('auth', {
        reason: 'validation-failed',
        cause: parsed.error,
      });
      expect(invalid.message).toContain('apiKey');
      expect(invalid.message).not.toContain('RAW_SECRET_99');
      expect(invalid.cause).toBe(parsed.error);
    }
  });

  test('enforces activeTools after repair, deterministic parallel order, safe error redaction, invalid-input {}, and beforeStepToolCalls (B4)', async () => {
    const executed: string[] = [];
    const tools = {
      slow: makeTool({
        description: 'Completes slower',
        input: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          await Bun.sleep(15);
          executed.push(`slow:${id}`);
          return { id, order: 'first' };
        },
      }),
      fast: makeTool({
        description: 'Completes faster',
        input: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          executed.push(`fast:${id}`);
          return { id, order: 'second' };
        },
      }),
      blocked: makeTool({
        description: 'Refused by beforeStepToolCalls',
        input: z.object({ id: z.string() }),
        execute: async ({ id }) => {
          executed.push(`blocked:${id}`);
          return { id };
        },
      }),
      crash: makeTool({
        description: 'Throws raw non-AgentToolError',
        input: z.object({ token: z.string() }),
        execute: async ({ token }) => {
          throw new Error(`internal panic with ${token}`);
        },
      }),
      hidden: makeTool({
        description: 'Inactive tool',
        input: z.object({}),
        execute: async () => {
          executed.push('hidden');
          return { secret: true };
        },
      }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'c1',
            toolName: 'slow',
            input: JSON.stringify({ id: '1' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c2',
            toolName: 'fast',
            input: JSON.stringify({ id: '2' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c3',
            toolName: 'blocked',
            input: JSON.stringify({ id: '3' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'c4',
            toolName: 'crash',
            input: JSON.stringify({ token: 'SUPER_SECRET_XYZ' }),
          },
          { type: 'tool-call', toolCallId: 'c5', toolName: 'fast', input: '{bad-json' },
          // Model calls inactive 'hidden' -> repair tries to keep 'hidden' -> must STILL be rejected!
          { type: 'tool-call', toolCallId: 'c6', toolName: 'hidden', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: 'Summary ready.' }, finish('stop')],
      ],
    });

    const batchSeen: string[] = [];
    const { runtime } = makeRuntime({
      driver,
      tools,
      loop: {
        prepareStep: () => ({
          activeTools: ['slow', 'fast', 'blocked', 'crash'],
        }),
        repairToolCall: ({ toolCall }) => {
          if (toolCall.toolName === 'hidden') {
            return { toolCallId: toolCall.toolCallId, toolName: 'hidden', input: '{}' };
          }
          return null;
        },
        beforeStepToolCalls: ({ calls }) => {
          batchSeen.push(...calls.map((c) => `${c.toolCallId}:${c.toolName}`));
          return {
            refuse: new Map([
              [
                'c3',
                new AgentToolError({
                  code: 'QUOTA_EXCEEDED',
                  message: 'Quota exceeded for blocked',
                }),
              ],
            ]),
          };
        },
      },
    });

    const res = await runtime.submit(userInput('conv-tools-all', 'run batch')).result;
    expect(res.reason).toBe('success');

    // beforeStepToolCalls saw only the 4 valid active calls (c1..c4); c5 failed input validation, c6 inactive.
    expect(batchSeen).toEqual(['c1:slow', 'c2:fast', 'c3:blocked', 'c4:crash']);
    expect(executed).not.toContain('blocked:3');
    expect(executed).not.toContain('hidden');

    // Step 2 request has deterministic call order c1..c6, `{}` on c5 input, and redacted c4 error.
    const step2Msgs = driver.requests[1]?.messages ?? [];
    const assistantMsg = step2Msgs.find((m) => m.role === 'assistant');
    const toolMsg = step2Msgs.find((m) => m.role === 'tool');
    expect(assistantMsg?.role).toBe('assistant');
    if (assistantMsg?.role === 'assistant' && typeof assistantMsg.content !== 'string') {
      const c5Call = assistantMsg.content.find(
        (p) => p.type === 'tool-call' && p.toolCallId === 'c5',
      );
      expect(c5Call?.type).toBe('tool-call');
      if (c5Call?.type === 'tool-call') {
        expect(c5Call.input).toEqual({});
      }
    }
    expect(toolMsg?.role).toBe('tool');
    if (toolMsg?.role === 'tool') {
      expect(
        toolMsg.content.map((p) => (p.type === 'tool-result' ? p.toolCallId : '')),
      ).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
      expect(toolMsg.content[2]).toEqual({
        type: 'tool-result',
        toolCallId: 'c3',
        toolName: 'blocked',
        output: {
          type: 'error-text',
          value: JSON.stringify({
            code: 'QUOTA_EXCEEDED',
            message: 'Quota exceeded for blocked',
          }),
        },
      });
      expect(toolMsg.content[3]).toEqual({
        type: 'tool-result',
        toolCallId: 'c4',
        toolName: 'crash',
        output: { type: 'error-text', value: 'Tool execution failed' },
      });
      expect(JSON.stringify(toolMsg)).not.toContain('SUPER_SECRET_XYZ');
    }
  });

  test('CAS conflict during tool-result checkpoint is never swallowed into error-text', async () => {
    const baseStore = createMemoryAgentRuntimeStore();
    let triggerConflict = false;
    const store: typeof baseStore = {
      ...baseStore,
      checkpointRunAssistant: async (input) => {
        if (triggerConflict && input.assistant.parts.some((p) => p.type === 'tool-result')) {
          return { outcome: 'conflict', actualVersion: input.expectedRevision + 1 };
        }
        return baseStore.checkpointRunAssistant(input);
      },
    };

    const tools = {
      ping: makeTool({
        description: 'Ping',
        input: z.object({}),
        execute: async () => {
          triggerConflict = true;
          return { pong: true };
        },
      }),
    };
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: 'should never run' }, finish('stop')],
      ],
    });

    const { runtime } = makeRuntime({ driver, tools, store });
    const res = await runtime.submit(userInput('conv-cas-tool', 'ping')).result;
    expect(res.reason).toBe('storage_conflict');
    expect(driver.requests).toHaveLength(1);
  });
});

describe('P0-6: collectApprovalContinuations hardening', () => {
  test('scans all tool messages for settled calls, deduplicates responses, and signs undefined input', async () => {
    const secret = 'hmac-secret-p06';
    const sigUndef = await signToolApproval({
      secret,
      approvalId: 'apr-undef',
      toolCallId: 'call-undef',
      toolName: 'noop',
      toolInput: undefined,
    });
    expect(
      await verifyToolApprovalSignature({
        secret,
        approvalId: 'apr-undef',
        toolCallId: 'call-undef',
        toolName: 'noop',
        toolInput: undefined,
        signature: sigUndef,
      }),
    ).toBe(true);

    const sig1 = await signToolApproval({
      secret,
      approvalId: 'apr-1',
      toolCallId: 'c1',
      toolName: 'noop',
      toolInput: { x: 1 },
    });
    const sig2 = await signToolApproval({
      secret,
      approvalId: 'apr-2',
      toolCallId: 'c2',
      toolName: 'noop',
      toolInput: { x: 2 },
    });

    const tools = {
      noop: makeTool({
        description: 'Noop',
        input: z.object({ x: z.number() }),
        execute: async () => ({ ok: true }),
      }),
    };

    const messages: AgentModelMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'noop', input: { x: 1 } },
          { type: 'tool-call', toolCallId: 'c2', toolName: 'noop', input: { x: 2 } },
          {
            type: 'tool-approval-request',
            approvalId: 'apr-1',
            toolCallId: 'c1',
            signature: sig1,
          },
          {
            type: 'tool-approval-request',
            approvalId: 'apr-2',
            toolCallId: 'c2',
            signature: sig2,
          },
        ],
      },
      // Earlier tool message already settled c1!
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'noop',
            output: { type: 'json', value: { ok: true } },
          },
        ],
      },
      // Tail tool message has duplicate approval responses for c2 AND a stale response for already-settled c1.
      {
        role: 'tool',
        content: [
          { type: 'tool-approval-response', approvalId: 'apr-1', approved: true },
          { type: 'tool-approval-response', approvalId: 'apr-2', approved: true },
          { type: 'tool-approval-response', approvalId: 'apr-2', approved: true },
        ],
      },
    ];

    const continuations = await collectApprovalContinuations({ messages, tools, secret });
    expect(continuations).toHaveLength(1);
    expect(continuations[0]?.toolCallId).toBe('c2');
    expect(continuations[0]?.approvalId).toBe('apr-2');
  });
});

describe('P0-8, P0-12, A4, A6: length/error stop safety, ping keepalive, timings, and tool-input-start', () => {
  test('never executes client tools on finishReason length and preserves partial=true on error without finish', async () => {
    let sideEffect = false;
    const tools = {
      mutate: makeTool({
        description: 'Mutate state',
        input: z.object({}),
        execute: async () => {
          sideEffect = true;
          return { ok: true };
        },
      }),
    };

    const lenDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'mutate', input: '{}' },
          finish('length'),
        ],
      ],
    });
    const { runtime: lenRuntime } = makeRuntime({ driver: lenDriver, tools });
    const lenRes = await lenRuntime.submit(userInput('conv-len', 'go')).result;
    expect(lenRes.reason).toBe('provider_stop');
    expect(sideEffect).toBe(false);

    const errDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'text-delta', id: 't1', delta: 'halfway' },
          { type: 'error', error: new Error('mid-stream fatal') },
        ],
      ],
    });
    const { runtime: errRuntime } = makeRuntime({ driver: errDriver });
    const errRes = await errRuntime.submit(userInput('conv-err-partial', 'go')).result;
    expect(errRes.reason).toBe('provider_failure');
    expect(errRes.metrics?.partial).toBe(true);
  });

  test('ping resets idleDeadline, timings/costDetails/rawFinishReason & empty responseId fallback recorded, and tool-input-start fires', async () => {
    const driver = createScriptedModelDriver({
      steps: [
        () => ({
          parts: (async function* () {
            yield { type: 'response-metadata' as const, id: '' };
            for (let i = 0; i < 3; i += 1) {
              await Bun.sleep(25);
              yield { type: 'ping' as const };
            }
            yield { type: 'tool-input-start' as const, toolCallId: 'tc-a6', toolName: 'echo' };
            yield {
              type: 'tool-input-delta' as const,
              toolCallId: 'tc-a6',
              delta: '{"v":"ok"}',
            };
            yield { type: 'tool-input-end' as const, toolCallId: 'tc-a6' };
            yield {
              type: 'tool-call' as const,
              toolCallId: 'tc-a6',
              toolName: 'echo',
              input: '{"v":"ok"}',
            };
            yield finish('tool-calls', {
              rawFinishReason: 'tool_use',
              costDetails: { promptCostUsd: 0.001, outputCostUsd: 0.002, isByok: true },
            });
          })(),
        }),
        [{ type: 'text-delta', id: 't2', delta: 'echoed' }, finish('stop')],
      ],
    });

    const tools = {
      echo: makeTool({
        description: 'Echo',
        input: z.object({ v: z.string() }),
        execute: async ({ v }) => ({ v }),
      }),
    };

    const spends: AgentStepSpend[] = [];
    const startedInputs: Array<{ toolCallId: string; toolName: string }> = [];

    const { runtime } = makeRuntime({
      driver,
      tools,
      loop: {
        // Total ping sleep is ~75ms > 55ms idleTimeoutMs -> succeeds ONLY because ping touches idleDeadline!
        idleTimeoutMs: 55,
        onToolInputStart: (info) => {
          startedInputs.push(info);
        },
      },
      onStepSpend: (spend) => {
        spends.push(spend);
      },
    });

    const res = await runtime.submit(userInput('conv-ping-a4-a6', 'go')).result;
    expect(res.reason).toBe('success');
    expect(startedInputs).toEqual([{ toolCallId: 'tc-a6', toolName: 'echo' }]);
    const firstSpend = spends.find((s) => s.phase === 'step');
    expect(firstSpend?.phase).toBe('step');
    if (firstSpend?.phase === 'step') {
      expect(firstSpend.response.id.length).toBeGreaterThan(0);
      expect(firstSpend.rawFinishReason).toBe('tool_use');
      expect(firstSpend.costDetails).toEqual({
        promptCostUsd: 0.001,
        outputCostUsd: 0.002,
        isByok: true,
      });
      expect(firstSpend.timings?.stepTimeMs).toBeGreaterThanOrEqual(0);
      expect(firstSpend.timings?.responseTimeMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('A7, B3, B7 & prepareStep hygiene', () => {
  test('A7: stepBarriers.onPredecessorFailure refuses dependent call on failure while default still runs', async () => {
    const runScenario = async (mode: 'refuse' | 'run') => {
      let readRan = false;
      const tools = {
        writeDoc: makeTool({
          description: 'Write document',
          input: z.object({ docId: z.string() }),
          execute: async () => {
            throw new AgentToolError({ code: 'WRITE_FAILED', message: 'Disk full' });
          },
        }),
        readDoc: makeTool({
          description: 'Read document',
          input: z.object({ docId: z.string() }),
          execute: async ({ docId }) => {
            readRan = true;
            return { docId, content: 'stale' };
          },
        }),
      };

      const driver = createScriptedModelDriver({
        steps: [
          [
            {
              type: 'tool-call',
              toolCallId: 'w1',
              toolName: 'writeDoc',
              input: JSON.stringify({ docId: 'doc-1' }),
            },
            {
              type: 'tool-call',
              toolCallId: 'r1',
              toolName: 'readDoc',
              input: JSON.stringify({ docId: 'doc-1' }),
            },
            finish('tool-calls'),
          ],
          [{ type: 'text-delta', id: 't2', delta: 'done' }, finish('stop')],
        ],
      });

      const resolver = createToolDependencyResolver({
        effects: {
          writeDoc: 'write',
          readDoc: 'read',
        },
        entityOf: (_toolName, input) =>
          typeof input === 'object' && input !== null && 'docId' in input
            ? `doc:${String(input.docId)}`
            : undefined,
      });

      const { runtime } = makeRuntime({
        driver,
        tools,
        loop: {
          stepBarriers: {
            toolDependencies: resolver,
            onPredecessorFailure: mode,
          },
        },
      });

      const res = await runtime.submit(userInput(`conv-a7-${mode}`, 'update then read'))
        .result;
      return { res, readRan, requests: driver.requests };
    };

    const refused = await runScenario('refuse');
    expect(refused.res.reason).toBe('success');
    expect(refused.readRan).toBe(false);
    const refusedToolMsg = refused.requests[1]?.messages.find((m) => m.role === 'tool');
    expect(JSON.stringify(refusedToolMsg)).toContain('STEP_PREDECESSOR_FAILED');

    const continued = await runScenario('run');
    expect(continued.res.reason).toBe('success');
    expect(continued.readRan).toBe(true);
  });

  test('B3: bounded terminal continuation, carriedToolWork, and maxContinuations hard cap', async () => {
    const tools = {
      lookup: makeTool({
        description: 'Lookup',
        input: z.object({ q: z.string() }),
        execute: async ({ q }) => ({ answer: `found:${q}` }),
      }),
    };

    // 1. Continuation succeeds within cap and uses continuation instructions for that step only.
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'lookup', input: '{"q":"sky"}' },
          finish('tool-calls'),
        ],
        // Model stops with empty text after tool work -> acceptTerminal continues with nudge!
        [finish('stop')],
        // Continuation step produces final answer.
        [{ type: 'text-delta', id: 't3', delta: 'The sky was found.' }, finish('stop')],
      ],
    });

    const sawCarried: boolean[] = [];
    const { runtime } = makeRuntime({
      driver,
      tools,
      instructions: 'Original system prompt.',
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: ({ message, steps, continuations }) => {
          sawCarried.push(carriedToolWork(steps ?? []));
          const hasText = message.parts.some(
            (p) => p.type === 'text' && p.text.trim().length > 0,
          );
          if (!hasText && (continuations ?? 0) === 0) {
            return {
              action: 'continue',
              message: {
                role: 'user',
                content: 'Please summarize your findings for the user.',
              },
              instructions: 'Continuation-only instructions.',
            };
          }
          return { action: 'accept' };
        },
      }),
      loop: { maxContinuations: 2 },
    });

    const res = await runtime.submit(userInput('conv-b3-ok', 'find sky')).result;
    expect(res.reason).toBe('success');
    expect(sawCarried).toEqual([true, true]);
    expect(driver.requests).toHaveLength(3);
    expect(driver.requests[2]?.instructions).toEqual([
      { role: 'system', content: 'Continuation-only instructions.' },
    ]);
    expect(res.message.parts.find((p) => p.type === 'text')).toEqual({
      type: 'text',
      text: 'The sky was found.',
    });

    // 2. Exceeding maxContinuations rejects with output_rejected (hard cap, I10).
    const capDriver = createScriptedModelDriver({
      steps: [[finish('stop')], [finish('stop')], [finish('stop')]],
    });
    const { runtime: capRuntime } = makeRuntime({
      driver: capDriver,
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: ({ steps }) => {
          expect(carriedToolWork(steps ?? [])).toBe(false);
          return {
            action: 'continue',
            message: { role: 'user', content: 'Try again.' },
          };
        },
      }),
      loop: { maxContinuations: 1 },
    });
    const capRes = await capRuntime.submit(userInput('conv-b3-cap', 'loop')).result;
    expect(capRes.reason).toBe('output_rejected');
    expect(capDriver.requests).toHaveLength(2);
  });

  test('B7: provider tool-result isError emits tool-error and provider approval-request is preserved', async () => {
    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'srv-call-1',
            toolName: 'code_exec',
            input: '{"code":"1/0"}',
            providerExecuted: true,
            provider: { schemaVersion: 1, provider: 'openai', data: { itemId: 'fc_1' } },
          },
          {
            type: 'tool-result',
            toolCallId: 'srv-call-1',
            toolName: 'code_exec',
            result: { stderr: 'ZeroDivisionError' },
            providerExecuted: true,
            isError: true,
          },
          {
            type: 'tool-approval-request',
            approvalId: 'srv-apr-1',
            toolCallId: 'srv-call-2',
          },
          { type: 'text-delta', id: 't1', delta: 'Execution failed on server.' },
          finish('stop'),
        ],
      ],
    });

    const { runtime } = makeRuntime({ driver });
    const res = await runtime.submit(userInput('conv-b7', 'run server code')).result;
    expect(res.reason).toBe('success');
    const toolResultPart = res.message.parts.find(
      (p) => p.type === 'tool-result' && p.callId === 'srv-call-1',
    );
    expect(toolResultPart?.type).toBe('tool-result');
    if (toolResultPart?.type === 'tool-result') {
      expect(toolResultPart.outcome).toBe('error');
    }
    expect(
      res.message.parts.some(
        (p) => p.type === 'tool-approval-request' && p.approvalId === 'srv-apr-1',
      ),
    ).toBe(true);
  });

  test('prepareStep forwards responseFormat/cacheControl/activeTools without leaking instructions and skips empty system messages', async () => {
    // Empty instructions with durableSystem must NOT emit `{ role: 'system', content: '' }`.
    const emptyDriver = createScriptedModelDriver({
      steps: [[{ type: 'text-delta', id: 't1', delta: 'ok' }, finish('stop')]],
    });
    const projection = createRunHistoryProjection({
      config: {
        store: createMemoryAgentRuntimeStore(),
        protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
        models: {
          resolve: () => ({ descriptor: { ...TEST_DESCRIPTOR }, driver: emptyDriver }),
        },
        prompt: () => emptyPrompt(''),
        tools: () => ({}),
      },
      currentRun: () => {
        throw new Error('unused');
      },
      durableSystem: ['Carried slot'],
      tools: {},
    });
    expect(projection.withCarriedSystem('')).toEqual([
      { role: 'system', content: 'Carried slot' },
    ]);

    const tools = {
      a: makeTool({
        description: 'Tool A',
        input: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    };
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: '{"ok":true}' }, finish('stop')],
      ],
    });

    const seenActive: Array<readonly string[]> = [];
    const { runtime } = makeRuntime({
      driver,
      tools,
      instructions: 'Base sys',
      loop: {
        prepareStep: ({ stepNumber, activeTools }) => {
          seenActive.push([...activeTools]);
          if (stepNumber === 0) {
            return {
              instructions: 'Step 0 only',
              cacheControl: { type: 'ephemeral', ttl: '5m' },
            };
          }
          return {
            responseFormat: { type: 'json-object' },
          };
        },
      },
    });

    const res = await runtime.submit(userInput('conv-prep-hygiene', 'go')).result;
    expect(res.reason).toBe('success');
    expect(seenActive).toEqual([['a'], ['a']]);
    expect(driver.requests[0]?.instructions).toEqual([
      { role: 'system', content: 'Step 0 only' },
    ]);
    expect(driver.requests[0]?.cacheControl).toEqual({ type: 'ephemeral', ttl: '5m' });
    // Step 0 override must NOT leak to Step 1.
    expect(driver.requests[1]?.instructions).toEqual([
      { role: 'system', content: 'Base sys' },
    ]);
    expect(driver.requests[1]?.responseFormat).toEqual({ type: 'json-object' });
  });
});

describe('Invocations: topP/seed forwarding, correlated encrypted payload, mid-stream error status, and stream ownership', () => {
  test('forwards topP/seed, writes correlatedRequest to payload, and records failed status on mid-stream error', async () => {
    const store = createMemoryAgentRuntimeStore();
    const payloadKey = new Uint8Array(32).fill(7);
    const seenRequests: AgentModelRequest[] = [];
    let released = false;

    const okDriver = createScriptedModelDriver({
      provider: 'scripted',
      modelId: 'scripted-1',
      onRequest: (req) => {
        seenRequests.push(req);
      },
      steps: [
        [{ type: 'ping' }, { type: 'text-delta', id: 't1', delta: 'ok' }, finish('stop')],
      ],
    });

    const errDriver: AgentModelDriver = {
      provider: 'scripted',
      modelId: 'scripted-err',
      async stream() {
        return {
          parts: {
            [Symbol.asyncIterator]() {
              let sent = false;
              return {
                async next() {
                  if (!sent) {
                    sent = true;
                    return {
                      done: false,
                      value: { type: 'error' as const, error: new Error('upstream boom') },
                    };
                  }
                  return { done: true, value: undefined };
                },
                async return() {
                  released = true;
                  return { done: true, value: undefined };
                },
              };
            },
          },
        };
      },
    };

    const models = defineModelRegistry({
      models: {
        fast: { ...TEST_DESCRIPTOR, provider: 'ok', modelId: 'fast-1' },
        broken: { ...TEST_DESCRIPTOR, provider: 'err', modelId: 'err-1' },
      },
      providers: {
        ok: { create: () => okDriver },
        err: { create: () => errDriver },
      },
    });

    const ledger = createModelInvocationLedger({
      store,
      models,
      payloadKey,
      authorize: () => ({ subject: 'user-1' }),
    });

    const okResult = await ledger.complete(
      {
        conversationId: 'conv-inv-1',
        idempotencyKey: 'inv-key-1',
        models: ['fast'],
        prompt: 'Say ok',
        settings: { topP: 0.75, seed: 42 },
        timeoutMs: 10_000,
        trace: { operationId: 'op-1', purpose: 'test', project: 'test-proj' },
      },
      {},
    );
    expect(okResult.outcome).toBe('succeeded');
    expect(okResult.text).toBe('ok');
    expect(seenRequests[0]?.settings.topP).toBe(0.75);
    expect(seenRequests[0]?.settings.seed).toBe(42);

    const records = await ledger.read({ conversationId: 'conv-inv-1', limit: 50 }, {});
    const reqRecord = records.items
      .map((item) => item.record)
      .find((r) => r.type === 'provider/request');
    expect(reqRecord?.type).toBe('provider/request');
    if (reqRecord?.type === 'provider/request' && reqRecord.sent.artifactId) {
      const payload = await ledger.readPayload(
        { conversationId: 'conv-inv-1', artifactId: reqRecord.sent.artifactId },
        {},
      );
      expect(payload.status).toBe('available');
      if (payload.status === 'available') {
        // Encrypted request payload must carry correlated invocationId and attemptId.
        const serialized = JSON.stringify(payload.payload);
        expect(serialized).toContain(okResult.invocationId);
        expect(serialized).toContain(reqRecord.attemptId);
      }
    }

    // Mid-stream error part: releases stream (I10) and records 'failed' attempt status (NOT 'cancelled').
    const errResult = await ledger.complete(
      {
        conversationId: 'conv-inv-err',
        idempotencyKey: 'inv-key-err',
        models: ['broken'],
        prompt: 'Fail mid-stream',
        timeoutMs: 10_000,
        trace: { operationId: 'op-2', purpose: 'test', project: 'test-proj' },
      },
      {},
    );
    expect(errResult.outcome).toBe('failed');
    expect(released).toBe(true);
    const errRecords = await ledger.read({ conversationId: 'conv-inv-err', limit: 50 }, {});
    const errResp = errRecords.items
      .map((item) => item.record)
      .find((r) => r.type === 'provider/response');
    expect(errResp?.type).toBe('provider/response');
    if (errResp?.type === 'provider/response') {
      expect(errResp.status).toBe('failed');
    }
  });
});

describe('Security & durability regressions: approvals, retries, redaction, attribution, barriers, and multimodal rounds', () => {
  test('prototype tool names (toString/constructor) never bypass toolApproval, invalid policy fails closed, and empty secret fails fast', async () => {
    const unknown = new AgentUnknownToolError('missing');
    expect(unknown.reason).toBe('unknown-tool');
    expect(new AgentInvalidToolApprovalSignatureError('a1').reason).toBe('invalid-signature');
    expect(new AgentToolCallNotFoundForApprovalError('a2').reason).toBe('call-not-found');

    // Empty toolApprovalSecret fails synchronously at createAgentRuntime() and in HMAC helpers.
    const idleDriver = createScriptedModelDriver({ steps: [] });
    expect(() =>
      makeRuntime({ driver: idleDriver, loop: { toolApprovalSecret: '' } }),
    ).toThrow(TypeError);
    expect(() =>
      makeRuntime({ driver: idleDriver, loop: { toolApprovalSecret: new Uint8Array(0) } }),
    ).toThrow(TypeError);
    await expect(
      signToolApproval({
        secret: '',
        approvalId: 'a',
        toolCallId: 'c',
        toolName: 't',
        toolInput: {},
      }),
    ).rejects.toThrow(TypeError);

    // Prototype keys in toolApproval map must NOT match Object.prototype methods.
    let ran = false;
    const dangerTool = defineAgentTool({
      input: z.object({}),
      needsApproval: true,
      execute: () => {
        ran = true;
        return { ok: true };
      },
    });
    for (const protoName of ['toString', 'constructor', 'valueOf']) {
      const outcome = await evaluateToolApprovalPolicy({
        tool: dangerTool,
        toolName: protoName,
        toolCallId: `call-${protoName}`,
        toolInput: {},
        messages: [],
        runtimeContext: {},
        toolApproval: {},
      });
      expect(outcome).toEqual({ kind: 'user-approval' });
    }
    expect(ran).toBe(false);

    // Invalid decision string/object from policy callback fails closed with AgentToolApprovalError.
    await expect(
      evaluateToolApprovalPolicy({
        tool: dangerTool,
        toolName: 'danger',
        toolCallId: 'c-bad-policy',
        toolInput: {},
        messages: [],
        runtimeContext: {},
        toolApproval: () => JSON.parse('"allow-all"'),
      }),
    ).rejects.toMatchObject({
      name: 'AgentToolApprovalError',
      reason: 'invalid-policy-decision',
    });
  });

  test('HMAC approval round-trips Date and optional undefined inputs, rejects mutating or throwing parseInput', async () => {
    const d1 = new Date('2026-01-01T00:00:00.000Z');
    const d2 = new Date('2026-06-15T12:30:00.000Z');
    expect(canonicalApprovalJson({ at: d1 })).not.toBe(canonicalApprovalJson({ at: d2 }));
    expect(canonicalApprovalJson({ at: d1 })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');

    let receivedDate: unknown;
    const schedule = defineAgentTool({
      description: 'Schedule at date',
      input: z.object({
        at: z.string().transform((iso) => new Date(iso)),
        note: z.string().optional(),
      }),
      needsApproval: true,
      execute: ({ at }) => {
        receivedDate = at;
        return { iso: at.toISOString() };
      },
    });

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'c-date',
            toolName: 'schedule',
            input: JSON.stringify({ at: '2026-01-01T00:00:00.000Z' }),
          },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: 'Scheduled.' }, finish('stop')],
      ],
    });
    const store = createMemoryAgentRuntimeStore();
    const { runtime } = makeRuntime({
      driver,
      tools: { schedule },
      store,
      loop: { toolApprovalSecret: 'date-hmac-secret' },
    });
    const turn1 = await runtime.submit(userInput('conv-date-apr', 'schedule')).result;
    const reqPart = turn1.message.parts.find((p) => p.type === 'tool-approval-request');
    expect(reqPart?.type).toBe('tool-approval-request');
    if (reqPart?.type !== 'tool-approval-request') return;

    const turn2 = await runtime.submit({
      conversationId: 'conv-date-apr',
      idempotencyKey: 'apr-date-ok',
      role: 'tool',
      parts: [
        { type: 'tool-approval-response', approvalId: reqPart.approvalId, approved: true },
      ],
      context: {},
    }).result;
    expect(turn2.reason).toBe('success');
    expect(receivedDate).toBeInstanceOf(Date);
    if (receivedDate instanceof Date) {
      expect(receivedDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    }

    // Mutating parseInput in place is caught via structuredClone -> AgentToolApprovalError('input-mutated').
    const secret = 'mutate-secret';
    const sig = await signToolApproval({
      secret,
      approvalId: 'apr-mut',
      toolCallId: 'c-mut',
      toolName: 'mutator',
      toolInput: { amount: 10 },
    });
    const messages: AgentModelMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'c-mut',
            toolName: 'mutator',
            input: { amount: 10 },
          },
          {
            type: 'tool-approval-request',
            approvalId: 'apr-mut',
            toolCallId: 'c-mut',
            signature: sig,
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-approval-response', approvalId: 'apr-mut', approved: true }],
      },
    ];
    await expect(
      collectApprovalContinuations({
        messages,
        secret,
        tools: {
          mutator: {
            inputSchema: { type: 'object' },
            parseInput: (raw) => {
              if (typeof raw === 'object' && raw !== null && 'amount' in raw) {
                Object.assign(raw, { amount: 9999 });
              }
              return { ok: true, value: raw };
            },
          },
        },
      }),
    ).rejects.toMatchObject({ name: 'AgentToolApprovalError', reason: 'input-mutated' });

    // Throwing parseInput wraps into AgentToolApprovalError('input-validation-failed') with cause.
    const parseCrash = new Error('validator crashed');
    await expect(
      collectApprovalContinuations({
        messages,
        secret,
        tools: {
          mutator: {
            inputSchema: { type: 'object' },
            parseInput: () => {
              throw parseCrash;
            },
          },
        },
      }),
    ).rejects.toMatchObject({
      name: 'AgentToolApprovalError',
      reason: 'input-validation-failed',
      cause: parseCrash,
    });
    expect(AgentToolApprovalError).toBeDefined();
  });

  test('acceptTerminal continue -> retryable 503 preserves all step usage/cost without double counting and keeps step text blocks separate', async () => {
    const pricedUsage = (input: number, output: number, usd: number): AgentUsage => ({
      inputTokens: { value: input, provenance: 'provider-reported' },
      outputTokens: { value: output, provenance: 'provider-reported' },
      cost: { value: usd, currency: 'USD', provenance: 'provider-reported' },
    });

    const driver = createScriptedModelDriver({
      steps: [
        // Attempt 1, Step 0: returns "Draft" ($0.01, 100in/50out).
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Draft' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage: pricedUsage(100, 50, 0.01) },
        ],
        // Attempt 1, Step 1 (after acceptTerminal continue): fails with retryable 503.
        {
          throw: new AgentProviderError('Temporary 503', {
            provider: 'scripted',
            statusCode: 503,
          }),
        },
        // Attempt 2, Step 0: returns "Draft 2" ($0.02, 120in/60out).
        [
          { type: 'text-start', id: 't1' },
          { type: 'text-delta', id: 't1', delta: 'Draft 2' },
          { type: 'text-end', id: 't1' },
          { type: 'finish', finishReason: 'stop', usage: pricedUsage(120, 60, 0.02) },
        ],
        // Attempt 2, Step 1 (after acceptTerminal continue): returns "Final" ($0.03, 200in/80out).
        [
          { type: 'text-start', id: 't2' },
          { type: 'text-delta', id: 't2', delta: 'Final' },
          { type: 'text-end', id: 't2' },
          { type: 'finish', finishReason: 'stop', usage: pricedUsage(200, 80, 0.03) },
        ],
      ],
    });

    const spends: AgentStepSpend[] = [];
    const { runtime } = makeRuntime({
      driver,
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
        terminalAcceptance: ({ message }) => {
          const texts = message.parts.filter((p) => p.type === 'text').map((p) => p.text);
          if (!texts.includes('Final')) {
            return {
              action: 'continue',
              message: { role: 'user', content: 'Please produce the final version.' },
            };
          }
          return { action: 'accept' };
        },
      }),
      loop: {
        retry: { maxAttempts: 2, delayMs: () => 0 },
      },
      onStepSpend: (spend) => {
        spends.push(spend);
      },
    });

    const outcome = await runtime.submit(userInput('conv-cont-retry', 'write')).result;
    expect(outcome.reason).toBe('success');
    // Text from Step 0 and Step 1 must NOT be glued into "Draft 2Final".
    const textParts = outcome.message.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(textParts).toEqual(['Draft 2', 'Final']);
    // Total usage equals exact sum of Attempt 1 Step 0 + Attempt 2 Step 0 + Attempt 2 Step 1.
    expect(outcome.metrics?.usage.inputTokens.value).toBe(420);
    expect(outcome.metrics?.usage.outputTokens.value).toBe(190);
    expect(outcome.metrics?.usage.cost?.value).toBeCloseTo(0.06, 6);
    expect(spends).toHaveLength(3);
    expect(spends.map((s) => ({ step: s.step, attempt: s.attempt }))).toEqual([
      { step: 0, attempt: 1 },
      { step: 0, attempt: 2 },
      { step: 1, attempt: 2 },
    ]);
  });

  test('redacts plain Error in beforeStepToolCalls.refuse (I13), attributes prepareStep driver switch, and clears internalCause on recoverable tool-error', async () => {
    const tools = {
      secretTool: makeTool({
        description: 'Refused with raw Error',
        input: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    };
    const primaryDriver = createScriptedModelDriver({
      provider: 'scripted',
      modelId: 'scripted-1',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c-refuse', toolName: 'secretTool', input: '{}' },
          finish('tool-calls'),
        ],
      ],
    });
    const fallbackDriver = createScriptedModelDriver({
      provider: 'anthropic',
      modelId: 'claude-sonnet-fallback',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c-step1', toolName: 'secretTool', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: 'Recovered cleanly.' }, finish('stop')],
      ],
    });

    const observed: Array<{
      type: string;
      modelId?: string;
      provider?: unknown;
      internalCause?: unknown;
    }> = [];
    const observe = createAgentObservability({
      includeInternalCause: true,
      write: (event) => {
        observed.push(event);
      },
    });
    const spends: AgentStepSpend[] = [];
    const driversSeenInPrepare: string[] = [];

    const store = createMemoryAgentRuntimeStore();
    const { runtime } = makeRuntime({
      driver: primaryDriver,
      tools,
      store,
      observe,
      onStepSpend: (spend) => {
        spends.push(spend);
      },
      loop: {
        prepareStep: ({ stepNumber, driver }) => {
          driversSeenInPrepare.push(`${stepNumber}:${driver.provider}/${driver.modelId}`);
          if (stepNumber === 1) return { driver: fallbackDriver };
          return undefined;
        },
        beforeStepToolCalls: ({ calls }) => ({
          refuse: new Map(
            calls.map((c) => [c.toolCallId, new Error('INTERNAL_DB_SECRET_LEAK_999')]),
          ),
        }),
      },
    });

    const res = await runtime.submit(userInput('conv-refuse-switch', 'go')).result;
    await observe.flush();
    expect(res.reason).toBe('success');

    // I13: raw Error.message from beforeStepToolCalls.refuse must NEVER reach persisted parts or model wire messages.
    expect(JSON.stringify(res.message.parts)).not.toContain('INTERNAL_DB_SECRET_LEAK_999');
    expect(JSON.stringify(fallbackDriver.requests)).not.toContain(
      'INTERNAL_DB_SECRET_LEAK_999',
    );
    const step1ToolMsg = fallbackDriver.requests[0]?.messages.find((m) => m.role === 'tool');
    expect(step1ToolMsg).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c-refuse',
          toolName: 'secretTool',
          output: { type: 'error-text', value: 'Tool execution failed' },
        },
      ],
    });

    // prepareStep driver switch attributes actual fallback model in spend, ledger, observe, and subsequent prepareStep.
    expect(driversSeenInPrepare).toEqual([
      '0:scripted/scripted-1',
      '1:scripted/scripted-1',
      '2:anthropic/claude-sonnet-fallback',
    ]);
    expect(spends[0]).toMatchObject({
      phase: 'step',
      model: 'scripted-1',
      provider: { key: 'scripted' },
    });
    expect(spends[1]).toMatchObject({
      phase: 'step',
      model: 'claude-sonnet-fallback',
      provider: { key: 'anthropic' },
    });
    const ledgerEvents = (
      await store.readEvents({ conversationId: 'conv-refuse-switch', limit: 50 })
    ).items;
    const reqModels = ledgerEvents
      .filter((e) => e.kind === 'provider/request')
      .map((e) =>
        typeof e.payload === 'object' && e.payload !== null && 'modelId' in e.payload
          ? e.payload.modelId
          : undefined,
      );
    expect(reqModels).toEqual([
      'scripted-1',
      'claude-sonnet-fallback',
      'claude-sonnet-fallback',
    ]);

    // Recoverable tool-error must NOT leave internalCause on a successful run-terminal event.
    const terminalEvent = observed.find((e) => e.type === 'run-terminal');
    expect(terminalEvent?.internalCause).toBeUndefined();
  });

  test('aborts parallel sibling tools on fatal failure, blocks client tools on interrupted/content-filter, and enforces non-executable onInputAvailable + maxToolCallsPerStep', async () => {
    // 1. Parallel sibling abort when another tool fails fatally (onInputAvailable throw on call 2).
    const siblingAborted = Promise.withResolvers<boolean>();
    const toolsAbort = {
      slow: defineAgentTool({
        input: z.object({}),
        execute: (_input, call) =>
          new Promise((_resolve, reject) => {
            call.abortSignal?.addEventListener(
              'abort',
              () => {
                siblingAborted.resolve(true);
                reject(call.abortSignal?.reason ?? new Error('aborted'));
              },
              { once: true },
            );
          }),
      }),
      boomInput: defineAgentTool({
        input: z.object({}),
        onInputAvailable: () => {
          throw new Error('fatal onInputAvailable');
        },
        execute: () => ({ ok: true }),
      }),
    };
    const abortDriver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c-slow', toolName: 'slow', input: '{}' },
          { type: 'tool-call', toolCallId: 'c-boom', toolName: 'boomInput', input: '{}' },
          finish('tool-calls'),
        ],
      ],
    });
    const { runtime: rtAbort } = makeRuntime({ driver: abortDriver, tools: toolsAbort });
    const abortRes = await rtAbort.submit(userInput('conv-sibling-abort', 'go')).result;
    expect(abortRes.reason).toBe('runtime_failure');
    expect(await siblingAborted.promise).toBe(true);

    // 2. Client tools NEVER execute on finishReason 'interrupted' or 'content-filter'.
    let sideEffects = 0;
    const guardTools = {
      mutate: makeTool({
        description: 'Mutate',
        input: z.object({}),
        execute: () => {
          sideEffects += 1;
          return { ok: true };
        },
      }),
    };
    for (const reason of ['interrupted', 'content-filter'] as const) {
      const d = createScriptedModelDriver({
        steps: [
          [
            { type: 'tool-call', toolCallId: `c-${reason}`, toolName: 'mutate', input: '{}' },
            { type: 'finish', finishReason: reason, usage: usage(10, 5) },
          ],
        ],
      });
      const { runtime: rtGuard } = makeRuntime({ driver: d, tools: guardTools });
      const r = await rtGuard.submit(userInput(`conv-unsafe-${reason}`, 'go')).result;
      expect(r.reason).toBe('provider_stop');
    }
    expect(sideEffects).toBe(0);

    // 3. Non-executable client tool invokes onInputAvailable and enforces maxToolCallsPerStep.
    const seenInputs: unknown[] = [];
    const clientOnlyTools = {
      clientPrompt: defineAgentTool({
        input: z.object({ label: z.string() }),
        onInputAvailable: ({ input }) => {
          seenInputs.push(input);
        },
      }),
    };
    const clientDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'cl-1',
            toolName: 'clientPrompt',
            input: JSON.stringify({ label: 'first' }),
          },
          {
            type: 'tool-call',
            toolCallId: 'cl-2',
            toolName: 'clientPrompt',
            input: JSON.stringify({ label: 'second' }),
          },
          finish('tool-calls'),
        ],
      ],
    });
    const { runtime: rtClient } = makeRuntime({
      driver: clientDriver,
      tools: clientOnlyTools,
      loop: { stepBarriers: { maxToolCallsPerStep: 1 } },
    });
    const clientRes = await rtClient.submit(userInput('conv-client-only', 'ask')).result;
    expect(seenInputs).toEqual([{ label: 'first' }]);
    expect(
      clientRes.message.parts.some(
        (p) =>
          p.type === 'tool-result' &&
          p.callId === 'cl-2' &&
          p.outcome === 'error' &&
          JSON.stringify(p.output).includes('STEP_TOOL_CALL_LIMIT'),
      ),
    ).toBe(true);
  });

  test('dedupes double reasoning-end backfill, preserves file/reasoning-file/custom/source across steps, distinguishes awaiting-approval predecessor, and hydrates multimodal defineViewFileTool on Turn 2', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const viewFileDef = defineViewFileTool({
      description: 'View image',
      identity: { serviceName: 'media', action: 'view', scope: 'user' },
      files: {
        read: async () => ({
          bytes: pngBytes,
          ref: { path: 'img.png', mediaType: 'image/png', size: pngBytes.byteLength },
        }),
        write: async (path) => ({ path, size: 0 }),
      },
    });
    const mountedViewTools = mountAgentTools([], {
      access: { open: 'local-operator' },
      runtimeTools: [viewFileDef],
    });

    const stepContents: AgentStepResult['content'][] = [];
    const driver = createScriptedModelDriver({
      steps: [
        // Turn 1, Step 0: double reasoning-end backfill + file + reasoning-file + custom + source + view_file call.
        [
          {
            type: 'reasoning-start',
            id: 'rs_1',
            provider: { schemaVersion: 1, provider: 'openai', data: { itemId: 'rs_1' } },
          },
          { type: 'reasoning-delta', id: 'rs_1', delta: 'Thinking...' },
          { type: 'reasoning-end', id: 'rs_1' },
          // Second reasoning-end backfill for same id with encryptedContent must update in place (NO duplicate!).
          {
            type: 'reasoning-end',
            id: 'rs_1',
            provider: {
              schemaVersion: 1,
              provider: 'openai',
              data: { encryptedContent: 'enc_99' },
            },
          },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
          },
          {
            type: 'reasoning-file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL('https://example.com/rf.png') },
          },
          {
            type: 'custom',
            kind: 'anthropic.citation',
            provider: { schemaVersion: 1, provider: 'anthropic', data: { cited: true } },
          },
          {
            type: 'source',
            source: { type: 'source', sourceId: 'src-1', url: 'https://example.com/doc' },
          },
          {
            type: 'tool-call',
            toolCallId: 'vf-call-1',
            toolName: 'view_file',
            input: JSON.stringify({ paths: ['img.png'] }),
          },
          finish('tool-calls'),
        ],
        // Turn 1, Step 1: final text answer.
        [{ type: 'text-delta', id: 't-final', delta: 'Image inspected.' }, finish('stop')],
        // Turn 2, Step 0: inspects projected history from Turn 1.
        [{ type: 'text-delta', id: 't-turn2', delta: 'Still see image.' }, finish('stop')],
      ],
    });

    const store = createMemoryAgentRuntimeStore();
    const { runtime } = makeRuntime({
      driver,
      tools: mountedViewTools,
      store,
      persistGeneratedFile: () => ({
        reference: 'mem://generated/file-1.png',
        filename: 'file-1.png',
      }),
      history: {
        resolveFile: () => ({
          type: 'url',
          url: new URL('https://cdn.example.com/file-1.png'),
        }),
      },
      loop: {
        prepareStep: ({ steps }) => {
          const last = steps.at(-1);
          if (last) stepContents.push(last.content);
          return undefined;
        },
      },
    });

    const turn1 = await runtime.submit(userInput('conv-mm-roundtrip', 'look at img.png'))
      .result;
    expect(turn1.reason).toBe('success');

    // Only ONE persisted reasoning part with BOTH itemId and encryptedContent!
    const persistedReasonings = turn1.message.parts.filter((p) => p.type === 'reasoning');
    expect(persistedReasonings).toEqual([
      {
        type: 'reasoning',
        text: 'Thinking...',
        provider: {
          schemaVersion: 1,
          provider: 'openai',
          data: { itemId: 'rs_1', encryptedContent: 'enc_99' },
        },
      },
    ]);
    // Persisted custom part uses real provider name ('anthropic'), NOT 'ai-sdk-custom'.
    const customPart = turn1.message.parts.find((p) => p.type === 'provider');
    expect(customPart).toEqual({
      type: 'provider',
      envelope: {
        schemaVersion: 1,
        provider: 'anthropic',
        data: { kind: 'anthropic.citation', provider: { cited: true } },
      },
    });

    // Step 1 request preserved ONE reasoning segment + file + reasoning-file + custom from Step 0.
    const step1Assistant = driver.requests[1]?.messages.find((m) => m.role === 'assistant');
    expect(step1Assistant?.role).toBe('assistant');
    if (step1Assistant?.role === 'assistant' && typeof step1Assistant.content !== 'string') {
      expect(step1Assistant.content.filter((p) => p.type === 'reasoning')).toHaveLength(1);
      expect(step1Assistant.content.some((p) => p.type === 'file')).toBe(true);
      expect(step1Assistant.content.some((p) => p.type === 'reasoning-file')).toBe(true);
      expect(step1Assistant.content.some((p) => p.type === 'custom')).toBe(true);
    }
    // AgentStepResult.content preserved file, reasoning-file, custom, and source.
    expect(stepContents[0]?.map((p) => p.type)).toEqual(
      expect.arrayContaining(['reasoning', 'file', 'reasoning-file', 'custom', 'source']),
    );

    // Turn 2: provider request MUST receive multimodal content (NOT raw base64 JSON) AND resolved assistant file!
    const turn2 = await runtime.submit(userInput('conv-mm-roundtrip', 'describe again'))
      .result;
    expect(turn2.reason).toBe('success');
    const turn2Messages = driver.requests[2]?.messages ?? [];
    const turn2ToolMsg = turn2Messages.find((m) => m.role === 'tool');
    expect(turn2ToolMsg).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'vf-call-1',
          toolName: 'view_file',
          output: {
            type: 'content',
            value: [
              {
                type: 'file',
                mediaType: 'image/png',
                data: { type: 'data', data: 'iVBORw0KGgo=' },
              },
              { type: 'text', text: '[image] image/png, 0KB' },
            ],
          },
        },
      ],
    });
    const turn2AssistantWithFile = turn2Messages.find(
      (m) =>
        m.role === 'assistant' &&
        typeof m.content !== 'string' &&
        m.content.some((p) => p.type === 'file'),
    );
    expect(turn2AssistantWithFile).toBeDefined();

    // Predecessor awaiting approval produces STEP_PREDECESSOR_AWAITING_APPROVAL (distinct from STEP_PREDECESSOR_FAILED).
    const aprDepTools = {
      writeDoc: makeTool({
        description: 'Write doc',
        input: z.object({ docId: z.string() }),
        needsApproval: true,
        execute: () => ({ ok: true }),
      }),
      readDoc: makeTool({
        description: 'Read doc',
        input: z.object({ docId: z.string() }),
        execute: () => ({ ok: true }),
      }),
    };
    const depDriver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'w-apr',
            toolName: 'writeDoc',
            input: '{"docId":"d1"}',
          },
          {
            type: 'tool-call',
            toolCallId: 'r-dep',
            toolName: 'readDoc',
            input: '{"docId":"d1"}',
          },
          finish('tool-calls'),
        ],
      ],
    });
    const { runtime: rtDep } = makeRuntime({
      driver: depDriver,
      tools: aprDepTools,
      loop: {
        stepBarriers: {
          toolDependencies: createToolDependencyResolver({
            effects: { writeDoc: 'write', readDoc: 'read' },
            entityOf: (_name, inp) =>
              typeof inp === 'object' && inp !== null && 'docId' in inp
                ? `doc:${String(inp.docId)}`
                : undefined,
          }),
          onPredecessorFailure: 'refuse',
        },
      },
    });
    const depRes = await rtDep.submit(userInput('conv-pred-apr', 'edit and read')).result;
    const refusedRead = depRes.message.parts.find(
      (p) => p.type === 'tool-result' && p.callId === 'r-dep',
    );
    expect(refusedRead).toMatchObject({
      type: 'tool-result',
      outcome: 'error',
      output: {
        code: 'STEP_PREDECESSOR_AWAITING_APPROVAL',
        message: expect.stringContaining('awaiting approval'),
      },
    });
  });

  test('preliminary streaming tool-result does not reset eventsSinceCheckpoint', async () => {
    let checkpointCalls = 0;
    const baseStore = createMemoryAgentRuntimeStore();
    const store: typeof baseStore = {
      ...baseStore,
      checkpointRunAssistant: async (input) => {
        checkpointCalls += 1;
        return baseStore.checkpointRunAssistant(input);
      },
    };
    const streamer = defineAgentTool({
      input: z.object({}),
      async *execute() {
        yield { step: 1 };
        yield { step: 2 };
        yield { step: 3 };
        yield { step: 4 };
      },
    });
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 's1', toolName: 'streamer', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: 'done' }, finish('stop')],
      ],
    });
    const { runtime } = makeRuntime({
      driver,
      tools: { streamer },
      store,
      loop: { checkpointEveryEvents: 2 },
    });
    const res = await runtime.submit(userInput('conv-prelim-ckpt', 'stream')).result;
    expect(res.reason).toBe('success');
    // With checkpointEveryEvents=2 and 4 preliminary yields, preliminary events trigger checkpointing rather than resetting counter to 0.
    expect(checkpointCalls).toBeGreaterThanOrEqual(5);
  });

  test('loop.maxDurationMs enforces wall-clock run deadline during tool execution while null disables it and invalid values reject', async () => {
    const slowTool = defineAgentTool({
      input: z.object({}),
      execute: async (_input, { abortSignal }) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 250);
          abortSignal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(abortSignal.reason);
            },
            { once: true },
          );
        });
        return 'slow-done';
      },
    });
    const driver = createScriptedModelDriver({
      steps: [
        [
          { type: 'tool-call', toolCallId: 'c1', toolName: 'slowTool', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't', delta: 'unreachable' }, finish('stop')],
      ],
    });
    const { runtime } = makeRuntime({
      driver,
      tools: { slowTool },
      loop: { idleTimeoutMs: null, maxDurationMs: 40 },
    });
    const timedOut = await runtime.submit(userInput('conv-max-dur', 'go')).result;
    await runtime.close();
    expect(timedOut.reason).toBe('timeout');

    // null disables maxDurationMs cleanly.
    const fastDriver = createScriptedModelDriver({
      steps: [[{ type: 'text-delta', id: 't', delta: 'ok' }, finish('stop')]],
    });
    const { runtime: disabledRt } = makeRuntime({
      driver: fastDriver,
      loop: { maxDurationMs: null },
    });
    const ok = await disabledRt.submit(userInput('conv-max-dur-null', 'go')).result;
    await disabledRt.close();
    expect(ok.reason).toBe('success');

    // Invalid maxDurationMs rejected at runtime creation.
    expect(() => makeRuntime({ driver: fastDriver, loop: { maxDurationMs: 0 } })).toThrow(
      RangeError,
    );
    expect(() => makeRuntime({ driver: fastDriver, loop: { maxDurationMs: -10 } })).toThrow(
      RangeError,
    );
  });

  test('providers resolve dynamic apiKey per call, merge request.headers while protecting content-type, emit server timestamp, and fail-fast on provider tools', async () => {
    let keyCounter = 0;
    const seenHeaders: Array<Record<string, string>> = [];
    const sseResponse = (body: string, extraHeaders?: Record<string, string>) =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', ...extraHeaders },
      });

    const captureFetch = (
      body: string,
      extraHeaders?: Record<string, string>,
    ): typeof fetch => {
      const fn = async (_input: string | URL | Request, init?: RequestInit) => {
        const record: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => {
          record[key.toLowerCase()] = value;
        });
        seenHeaders.push(record);
        return sseResponse(body, extraHeaders);
      };
      return Object.assign(fn, { preconnect: () => undefined });
    };

    const baseRequest: AgentModelRequest = {
      instructions: [{ role: 'system', content: 'hi' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [],
      settings: { maxOutputTokens: 256 },
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'content-type': 'text/plain',
      },
      correlation: { conversationId: 'c', attemptId: 'a', step: 0 },
    };

    const providerToolRequest: AgentModelRequest = {
      ...baseRequest,
      tools: [{ type: 'provider', id: 'web_search', name: 'web_search' }],
    };

    // 1. OpenRouter: dynamic apiKey + headers + created timestamp + fail-fast on provider tool.
    const orSse = [
      `data: ${JSON.stringify({ id: 'gen-1', created: 1732788000, model: 'openai/gpt-4o', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'gen-1', created: 1732788000, model: 'openai/gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const orDriver = openRouterProvider({
      apiKey: async () => {
        keyCounter += 1;
        return `or-key-${keyCounter}`;
      },
      fetch: captureFetch(orSse),
    }).create('openai/gpt-4o');
    const orStream1 = await orDriver.stream(baseRequest, new AbortController().signal);
    const orParts1: AgentModelStreamPart[] = [];
    for await (const part of orStream1.parts) orParts1.push(part);
    const orStream2 = await orDriver.stream(baseRequest, new AbortController().signal);
    for await (const _part of orStream2.parts) {
      // drain
    }
    expect(seenHeaders[0]?.authorization).toBe('Bearer or-key-1');
    expect(seenHeaders[1]?.authorization).toBe('Bearer or-key-2');
    expect(seenHeaders[0]?.traceparent).toBe(baseRequest.headers?.traceparent);
    expect(seenHeaders[0]?.['content-type']).toBe('application/json');
    const orMeta = orParts1.find((p) => p.type === 'response-metadata');
    expect(
      orMeta?.type === 'response-metadata' ? orMeta.timestamp?.toISOString() : undefined,
    ).toBe(new Date(1732788000 * 1000).toISOString());
    await expect(
      orDriver.stream(providerToolRequest, new AbortController().signal),
    ).rejects.toThrow(TypeError);

    // 2. OpenAI Responses: dynamic apiKey + headers + created_at timestamp + fail-fast on provider tool.
    seenHeaders.length = 0;
    const oaSse = [
      `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1', model: 'gpt-4.1', created_at: 1732788100 } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_1', model: 'gpt-4.1', created_at: 1732788100, status: 'completed', output: [], usage: { input_tokens: 4, output_tokens: 1 } } })}\n\n`,
    ].join('');
    const oaDriver = openAiProvider({
      apiKey: () => {
        keyCounter += 1;
        return `oa-key-${keyCounter}`;
      },
      fetch: captureFetch(oaSse),
    }).create('gpt-4.1');
    const oaStream = await oaDriver.stream(baseRequest, new AbortController().signal);
    const oaParts: AgentModelStreamPart[] = [];
    for await (const part of oaStream.parts) oaParts.push(part);
    expect(seenHeaders[0]?.authorization).toBe('Bearer oa-key-3');
    expect(seenHeaders[0]?.traceparent).toBe(baseRequest.headers?.traceparent);
    expect(seenHeaders[0]?.['content-type']).toBe('application/json');
    const oaMeta = oaParts.find((p) => p.type === 'response-metadata');
    expect(
      oaMeta?.type === 'response-metadata' ? oaMeta.timestamp?.toISOString() : undefined,
    ).toBe(new Date(1732788100 * 1000).toISOString());
    await expect(
      oaDriver.stream(providerToolRequest, new AbortController().signal),
    ).rejects.toThrow(TypeError);

    // 3. Anthropic: dynamic apiKey + headers + HTTP Date timestamp + fail-fast on provider tool.
    seenHeaders.length = 0;
    const httpDate = 'Sat, 28 Nov 2026 10:20:00 GMT';
    const anSse = [
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 0 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    const anDriver = anthropicProvider({
      apiKey: async () => {
        keyCounter += 1;
        return `an-key-${keyCounter}`;
      },
      fetch: captureFetch(anSse, { date: httpDate }),
    }).create('claude-sonnet-4-6');
    const anStream = await anDriver.stream(baseRequest, new AbortController().signal);
    const anParts: AgentModelStreamPart[] = [];
    for await (const part of anStream.parts) anParts.push(part);
    expect(seenHeaders[0]?.['x-api-key']).toBe('an-key-4');
    expect(seenHeaders[0]?.traceparent).toBe(baseRequest.headers?.traceparent);
    expect(seenHeaders[0]?.['content-type']).toBe('application/json');
    const anMeta = anParts.find((p) => p.type === 'response-metadata');
    expect(
      anMeta?.type === 'response-metadata' ? anMeta.timestamp?.toISOString() : undefined,
    ).toBe(new Date(httpDate).toISOString());
    await expect(
      anDriver.stream(providerToolRequest, new AbortController().signal),
    ).rejects.toThrow(TypeError);

    // 4. AI SDK adapter: fail-fast on provider tool.
    const { MockLanguageModelV4 } = await import('ai/test');
    const aiSdkDriver = fromAiSdkModel(new MockLanguageModelV4());
    await expect(
      aiSdkDriver.stream(providerToolRequest, new AbortController().signal),
    ).rejects.toThrow(TypeError);
  });

  test('mountAgentTools(config) overload, isAgentProviderError guard, and model invocation ledger complete work cleanly', async () => {
    const tool = defineRuntimeTool({
      name: 'echo_msg',
      description: 'Echo message',
      identity: { serviceName: 'demo', action: 'echo', method: 'POST' },
      input: z.object({ msg: z.string() }),
      output: z.object({ echoed: z.string() }),
      handler: ({ input }) => ({ echoed: input.msg }),
    });
    const mounted = mountAgentTools({
      runtimeTools: [tool],
      access: { open: 'local-operator' },
    });
    expect(Object.keys(mounted)).toEqual(['echo_msg']);
    const out = await mounted.echo_msg?.execute?.(
      { msg: 'hi' },
      { toolCallId: 't1', messages: [] },
    );
    expect(out).toEqual({ echoed: 'hi' });

    // Negative control: passing config as 1st arg alongside a 2nd arg is rejected.
    expect(() =>
      Reflect.apply(mountAgentTools, undefined, [
        { runtimeTools: [tool], access: { open: 'local-operator' } },
        { access: { open: 'local-operator' } },
      ]),
    ).toThrow(TypeError);

    // isAgentProviderError positive and negative controls.
    expect(
      isAgentProviderError(
        new AgentProviderError('down', { provider: 'test', statusCode: 503 }),
      ),
    ).toBe(true);
    expect(isAgentProviderError(new Error('plain'))).toBe(false);
    expect(isAgentProviderError(null)).toBe(false);

    // createModelInvocationLedger.complete uses shared consumeStandaloneDriverStream.
    const store = createMemoryAgentRuntimeStore();
    const driver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'inv-m',
      steps: [
        [
          { type: 'text-delta', id: 't1', delta: 'hello ' },
          { type: 'text-delta', id: 't1', delta: 'ledger' },
          finish('stop'),
        ],
      ],
    });
    const ledger = createModelInvocationLedger({
      store,
      payloadKey: new Uint8Array(32).fill(7),
      authorize: () => ({ subject: 'user-1' }),
      models: defineModelRegistry({
        providers: { test: { create: () => driver } },
        models: {
          fast: {
            provider: 'test',
            modelId: 'inv-m',
            contextWindow: 10_000,
            capabilities: [],
          },
        },
      }),
    });
    const completed = await ledger.complete(
      {
        conversationId: 'conv-inv',
        idempotencyKey: 'inv-k1',
        trace: { operationId: 'op-1', purpose: 'summarize', project: 'demo' },
        models: ['fast'],
        prompt: 'say hi',
        timeoutMs: 5_000,
      },
      { authorization: {} },
    );
    expect(completed.text).toBe('hello ledger');
  });

  test('propagates STEP_PREDECESSOR_AWAITING_APPROVAL across 3-call cascades, passes instructions to beforeStepToolCalls, populates step.model, wires history.resolveToolModelOutput + project tools, and rejects prototype provider keys', async () => {
    // 1. 3-call cascade: Call 1 awaits approval on entity e1 -> Call 2 AND Call 3 BOTH receive STEP_PREDECESSOR_AWAITING_APPROVAL.
    //    Negative control: Call 4 fails on entity e2 -> Call 5 AND Call 6 BOTH receive STEP_PREDECESSOR_FAILED.
    const write = makeTool({
      description: 'Write entity',
      input: z.object({ id: z.string(), fail: z.boolean().optional() }),
      execute: async ({ id, fail }) => {
        if (fail) throw new Error(`write failed on ${id}`);
        return { wrote: id };
      },
    });
    const read = makeTool({
      description: 'Read entity',
      input: z.object({ id: z.string() }),
      execute: async ({ id }) => ({ read: id }),
    });
    const cascadeDriver = createScriptedModelDriver({
      provider: 'prov-main',
      modelId: 'model-main',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'e1-1', toolName: 'write', input: '{"id":"e1"}' },
          { type: 'tool-call', toolCallId: 'e1-2', toolName: 'write', input: '{"id":"e1"}' },
          { type: 'tool-call', toolCallId: 'e1-3', toolName: 'read', input: '{"id":"e1"}' },
          {
            type: 'tool-call',
            toolCallId: 'e2-1',
            toolName: 'write',
            input: '{"id":"e2","fail":true}',
          },
          { type: 'tool-call', toolCallId: 'e2-2', toolName: 'write', input: '{"id":"e2"}' },
          { type: 'tool-call', toolCallId: 'e2-3', toolName: 'read', input: '{"id":"e2"}' },
          finish('tool-calls'),
        ],
      ],
    });
    const seenBatchInstructions: string[][] = [];
    const seenStepModels: Array<{ provider: string; modelId: string } | undefined> = [];
    const cascadeStore = createMemoryAgentRuntimeStore();
    const cascadeRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: cascadeStore,
      models: {
        resolve: () => ({
          descriptor: { ...TEST_DESCRIPTOR, provider: 'prov-main', modelId: 'model-main' },
          driver: cascadeDriver,
        }),
      },
      prompt: () => emptyPrompt('Base system prompt'),
      tools: () => ({ write, read }),
      loop: {
        prepareStep: ({ stepNumber, steps }) => {
          if (steps.length > 0) seenStepModels.push(steps.at(-1)?.model);
          return stepNumber === 0
            ? { instructions: 'Step 0 override instructions' }
            : undefined;
        },
        beforeStepToolCalls: ({ instructions }) => {
          seenBatchInstructions.push(instructions.map((m) => m.content));
          return undefined;
        },
        toolApproval: ({ toolCall }) =>
          toolCall.toolCallId === 'e1-1' ? 'user-approval' : 'not-applicable',
        stepBarriers: {
          toolDependencies: createToolDependencyResolver({
            effects: { write: 'write', read: 'read' },
            entityOf: (_toolName, inp) =>
              typeof inp === 'object' &&
              inp !== null &&
              'id' in inp &&
              typeof inp.id === 'string'
                ? inp.id
                : undefined,
          }),
          onPredecessorFailure: 'refuse',
        },
      },
    });
    const cascadeRes = await cascadeRuntime.submit({
      conversationId: 'c-cascade-3',
      idempotencyKey: 'k-c3',
      context: {},
      parts: [{ type: 'text', text: 'run cascade' }],
      metadata: {},
    }).result;
    await cascadeRuntime.close();

    expect(seenBatchInstructions).toEqual([['Step 0 override instructions']]);
    const toolResults = cascadeRes.message.parts.filter((p) => p.type === 'tool-result');
    expect(toolResults.find((r) => r.callId === 'e1-2')).toMatchObject({
      outcome: 'error',
      output: { code: 'STEP_PREDECESSOR_AWAITING_APPROVAL' },
    });
    expect(toolResults.find((r) => r.callId === 'e1-3')).toMatchObject({
      outcome: 'error',
      output: { code: 'STEP_PREDECESSOR_AWAITING_APPROVAL' },
    });
    expect(toolResults.find((r) => r.callId === 'e2-2')).toMatchObject({
      outcome: 'error',
      output: { code: 'STEP_PREDECESSOR_FAILED' },
    });
    expect(toolResults.find((r) => r.callId === 'e2-3')).toMatchObject({
      outcome: 'error',
      output: { code: 'STEP_PREDECESSOR_FAILED' },
    });

    // 2. history.resolveToolModelOutput projects Turn 2 tool-results directly in one pass, and step.model reflects active driver.
    const echoTool = makeTool({
      description: 'Echo',
      input: z.object({ q: z.string() }),
      execute: async ({ q }) => ({ raw: q }),
    });
    const histDriver = createScriptedModelDriver({
      provider: 'prov-h',
      modelId: 'model-h',
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'h1',
            toolName: 'echoTool',
            input: '{"q":"hello"}',
          },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't1', delta: 'Turn 1 done' }, finish('stop')],
        [{ type: 'text-delta', id: 't2', delta: 'Turn 2 done' }, finish('stop')],
      ],
    });
    const histStore = createMemoryAgentRuntimeStore();
    const observedModels: Array<{ provider: string; modelId: string } | undefined> = [];
    const histRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: histStore,
      models: {
        resolve: () => ({
          descriptor: { ...TEST_DESCRIPTOR, provider: 'prov-h', modelId: 'model-h' },
          driver: histDriver,
        }),
      },
      prompt: () => emptyPrompt('sys'),
      tools: () => ({ echoTool }),
      loop: {
        prepareStep: ({ steps }) => {
          if (steps.length > 0) observedModels.push(steps.at(-1)?.model);
          return undefined;
        },
      },
      history: {
        resolveToolModelOutput: ({ toolName, output }) =>
          toolName === 'echoTool'
            ? { type: 'text', value: `projected:${JSON.stringify(output)}` }
            : undefined,
      },
    });
    await histRuntime.submit({
      conversationId: 'c-resolve-tmo',
      idempotencyKey: 'tmo-1',
      context: {},
      parts: [{ type: 'text', text: 'turn 1' }],
      metadata: {},
    }).result;
    await histRuntime.submit({
      conversationId: 'c-resolve-tmo',
      idempotencyKey: 'tmo-2',
      context: {},
      parts: [{ type: 'text', text: 'turn 2' }],
      metadata: {},
    }).result;
    await histRuntime.close();

    expect(observedModels).toEqual([{ provider: 'prov-h', modelId: 'model-h' }]);
    const turn2ToolMsg = histDriver.requests[2]?.messages.find((m) => m.role === 'tool');
    expect(turn2ToolMsg?.role === 'tool' ? turn2ToolMsg.content[0] : undefined).toMatchObject({
      type: 'tool-result',
      toolCallId: 'h1',
      output: { type: 'text', value: 'projected:{"raw":"hello"}' },
    });

    // 3. Custom history.project receives `{ tools }` as second argument.
    let projectSawTools: string[] = [];
    const customProjDriver = createScriptedModelDriver({
      provider: 'p',
      modelId: 'm',
      steps: [[{ type: 'text-delta', id: 't1', delta: 'ok' }, finish('stop')]],
    });
    const customProjRuntime = createAgentRuntime({
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      store: createMemoryAgentRuntimeStore(),
      models: {
        resolve: () => ({ descriptor: { ...TEST_DESCRIPTOR }, driver: customProjDriver }),
      },
      prompt: () => emptyPrompt('sys'),
      tools: () => ({ echoTool }),
      history: {
        project: (_messages, { tools }) => {
          projectSawTools = Object.keys(tools);
          return [{ role: 'user', content: 'custom projected' }];
        },
      },
    });
    await customProjRuntime.submit({
      conversationId: 'c-custom-proj',
      idempotencyKey: 'cp-1',
      context: {},
      parts: [{ type: 'text', text: 'hi' }],
      metadata: {},
    }).result;
    await customProjRuntime.close();
    expect(projectSawTools).toEqual(['echoTool']);

    // 4. defineModelRegistry rejects Object.prototype provider names ('constructor', 'toString').
    const registry = defineModelRegistry({
      providers: {},
      models: {
        bad: {
          provider: 'constructor',
          modelId: 'x',
          contextWindow: 4_096,
          capabilities: [],
        },
      },
    });
    expect(() => registry.preflight('bad')).toThrow(
      'Unknown agent model provider: constructor',
    );
    expect(() => registry.resolve('bad')).toThrow('Unknown agent model provider: constructor');
  });

  test('defineAgentTool({ output }) .transform()/.default(), zero-lag streaming, empty iterable, hand-built outputSchema, AgentRuntimeStopPolicy<Ctx>, and file.filename work in createAgentRuntime', async () => {
    const releaseChunk2 = Promise.withResolvers<void>();
    let producedChunk2 = false;
    const progressObserved: unknown[] = [];

    const transformTool = defineAgentTool({
      input: z.object({ raw: z.string() }),
      output: z.object({
        n: z.string().transform(Number),
        d: z.boolean().default(true),
      }),
      execute: async ({ raw }) => ({ n: raw }),
    });

    const streamTool = defineAgentTool({
      input: z.object({}),
      output: z.object({
        n: z.string().transform(Number),
        d: z.boolean().default(true),
        progress: z.number().optional(),
      }),
      async *execute() {
        yield { n: '1', progress: 1 };
        await releaseChunk2.promise;
        producedChunk2 = true;
        yield { n: '55' };
      },
    });

    const emptyTool = defineAgentTool({
      input: z.object({}),
      output: z.object({ ok: z.boolean() }),
      async *execute() {
        // yields nothing
      },
    });

    const handBuilt: AgentTool = {
      inputSchema: { type: 'object', properties: {} },
      outputSchema: z.object({ v: z.string().transform(Number) }),
      execute: () => ({ v: '8' }),
    };

    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'tool-call',
            toolCallId: 'rt-tr',
            toolName: 'transformTool',
            input: '{"raw":"42"}',
          },
          { type: 'tool-call', toolCallId: 'rt-st', toolName: 'streamTool', input: '{}' },
          { type: 'tool-call', toolCallId: 'rt-em', toolName: 'emptyTool', input: '{}' },
          { type: 'tool-call', toolCallId: 'rt-hb', toolName: 'handBuilt', input: '{}' },
          finish('tool-calls'),
        ],
        [
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'data', data: new Uint8Array([1, 2, 3]) },
            filename: 'report.png',
          },
          { type: 'text-delta', id: 't-done', delta: 'finished' },
          finish('stop'),
        ],
      ],
    });

    type MyCtx = { stopAfterOne?: boolean };
    const stopPolicy: AgentRuntimeStopPolicy<MyCtx> = {
      name: 'ctx-stop',
      when: ({ context, steps }) => Boolean(context.stopAfterOne && steps.length >= 1),
    };

    // Release chunk 2 shortly after chunk 1 is yielded (verifies no 1-chunk buffering deadlock).
    const releaseTimer = setTimeout(() => {
      progressObserved.push({ producedChunk2BeforeRelease: producedChunk2 });
      releaseChunk2.resolve();
    }, 15);

    const persistedFilenames: Array<string | undefined> = [];
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({ stopAfterOne: z.boolean().optional() }),
        inputMetadata: z.object({}),
      }),
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor: { ...TEST_DESCRIPTOR }, driver }) },
      prompt: () => emptyPrompt('sys'),
      tools: () => ({ transformTool, streamTool, emptyTool, handBuilt }),
      loop: { stopPolicies: [stopPolicy] },
      persistGeneratedFile: (file) => {
        persistedFilenames.push(file.filename);
        return { reference: 'ref-1' };
      },
    });

    try {
      const res = await runtime.submit({
        conversationId: 'c-r2-dx',
        idempotencyKey: 'k-r2-dx',
        context: { stopAfterOne: false },
        parts: [{ type: 'text', text: 'go' }],
        metadata: {},
      }).result;
      expect(res.reason).toBe('success');
      expect(progressObserved).toEqual([{ producedChunk2BeforeRelease: false }]);
      const results = res.message.parts.filter((p) => p.type === 'tool-result');
      expect(results.find((r) => r.callId === 'rt-tr')).toMatchObject({
        outcome: 'success',
        output: { n: 42, d: true },
      });
      expect(results.find((r) => r.callId === 'rt-st')).toMatchObject({
        outcome: 'success',
        output: { n: 55, d: true },
      });
      expect(results.find((r) => r.callId === 'rt-em')).toMatchObject({
        outcome: 'error',
      });
      expect(results.find((r) => r.callId === 'rt-hb')).toMatchObject({
        outcome: 'success',
        output: { v: 8 },
      });
      expect(persistedFilenames).toEqual(['report.png']);
      const filePart = res.message.parts.find((p) => p.type === 'file');
      expect(filePart?.type === 'file' && filePart.filename).toBe('report.png');
    } finally {
      clearTimeout(releaseTimer);
      await runtime.close();
    }
  });

  test('persistGeneratedFile receives file.filename for inline and URL files and undefined when omitted', async () => {
    const observed: Array<{
      readonly mediaType: string;
      readonly filename: string | undefined;
      readonly kind: 'data' | 'url';
    }> = [];
    const driver = createScriptedModelDriver({
      steps: [
        [
          {
            type: 'file',
            mediaType: 'text/plain',
            data: { type: 'data', data: new Uint8Array([65, 66]) },
            filename: 'notes.txt',
          },
          {
            type: 'file',
            mediaType: 'image/png',
            data: { type: 'url', url: new URL('https://files.example.test/chart.png') },
            filename: 'chart.png',
          },
          {
            type: 'file',
            mediaType: 'application/octet-stream',
            data: { type: 'data', data: new Uint8Array([1]) },
          },
          {
            type: 'reasoning-file',
            mediaType: 'text/markdown',
            data: { type: 'data', data: new Uint8Array([35]) },
          },
          { type: 'text-delta', id: 't-files', delta: 'saved' },
          finish('stop'),
        ],
      ],
    });
    const runtime = createAgentRuntime({
      protocol: defineAgentProtocol({
        context: z.object({}),
        inputMetadata: z.object({}),
      }),
      store: createMemoryAgentRuntimeStore(),
      models: { resolve: () => ({ descriptor: { ...TEST_DESCRIPTOR }, driver }) },
      prompt: () => emptyPrompt('sys'),
      tools: () => ({}),
      persistGeneratedFile: (file) => {
        observed.push({
          mediaType: file.mediaType,
          filename: file.filename,
          kind: file.data.type,
        });
        return {
          reference: `ref-${observed.length}`,
          ...(file.filename === 'chart.png' && { filename: 'renamed-chart.png' }),
        };
      },
    });
    try {
      const res = await runtime.submit({
        conversationId: 'c-file-name',
        idempotencyKey: 'k-file-name',
        context: {},
        parts: [{ type: 'text', text: 'emit files' }],
        metadata: {},
      }).result;
      expect(res.reason).toBe('success');
      expect(observed).toEqual([
        { mediaType: 'text/plain', filename: 'notes.txt', kind: 'data' },
        { mediaType: 'image/png', filename: 'chart.png', kind: 'url' },
        { mediaType: 'application/octet-stream', filename: undefined, kind: 'data' },
        { mediaType: 'text/markdown', filename: undefined, kind: 'data' },
      ]);
      const files = res.message.parts.filter((p) => p.type === 'file');
      expect(files).toEqual([
        { type: 'file', mediaType: 'text/plain', reference: 'ref-1', filename: 'notes.txt' },
        {
          type: 'file',
          mediaType: 'image/png',
          reference: 'ref-2',
          filename: 'renamed-chart.png',
        },
        { type: 'file', mediaType: 'application/octet-stream', reference: 'ref-3' },
        { type: 'file', mediaType: 'text/markdown', reference: 'ref-4' },
      ]);
    } finally {
      await runtime.close();
    }
  });

  test('prepareStep forwards every AgentPrepareStepResult override and AgentModelCallSettings field to the driver', async () => {
    const primaryDriver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'primary',
      steps: [],
    });
    const overrideDriver = createScriptedModelDriver({
      provider: 'test',
      modelId: 'override',
      steps: [
        [
          { type: 'tool-call', toolCallId: 'p1', toolName: 'alpha', input: '{}' },
          finish('tool-calls'),
        ],
        [{ type: 'text-delta', id: 't2', delta: 'done' }, finish('stop')],
      ],
    });
    const tools = {
      alpha: makeTool({
        description: 'Alpha',
        input: z.object({}),
        execute: async () => ({ ok: true }),
      }),
      beta: makeTool({
        description: 'Beta',
        input: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    };

    const { runtime } = makeRuntime({
      driver: primaryDriver,
      tools,
      instructions: 'Base instructions',
      loop: {
        prepareStep: ({ stepNumber }) => {
          if (stepNumber === 0) {
            return {
              driver: overrideDriver,
              instructions: 'Override instructions',
              messages: [{ role: 'user', content: 'Rewritten prompt' }],
              activeTools: ['alpha'],
              toolChoice: { type: 'tool', toolName: 'alpha' },
              responseFormat: { type: 'json-object' },
              cacheControl: { type: 'ephemeral', ttl: '5m' },
              maxOutputTokens: 256,
              temperature: 0.3,
              topP: 0.85,
              topK: 32,
              presencePenalty: 0.15,
              frequencyPenalty: 0.25,
              seed: 123,
              stopSequences: ['STOP'],
              providerOptions: { openai: { reasoning: { effort: 'low' } } },
              headers: { 'x-step-header': 'step-0' },
            };
          }
          return {};
        },
      },
    });

    try {
      const res = await runtime.submit(userInput('conv-prep-all', 'original')).result;
      expect(res.reason).toBe('success');
      expect(primaryDriver.requests).toHaveLength(0);
      expect(overrideDriver.requests).toHaveLength(2);
      const req0 = overrideDriver.requests[0];
      expect(req0?.instructions).toEqual([
        { role: 'system', content: 'Override instructions' },
      ]);
      expect(req0?.messages).toEqual([{ role: 'user', content: 'Rewritten prompt' }]);
      expect(req0?.tools.map((t) => t.name)).toEqual(['alpha']);
      expect(req0?.toolChoice).toEqual({ type: 'tool', toolName: 'alpha' });
      expect(req0?.responseFormat).toEqual({ type: 'json-object' });
      expect(req0?.cacheControl).toEqual({ type: 'ephemeral', ttl: '5m' });
      expect(req0?.settings).toEqual({
        maxOutputTokens: 256,
        temperature: 0.3,
        topP: 0.85,
        topK: 32,
        presencePenalty: 0.15,
        frequencyPenalty: 0.25,
        seed: 123,
        stopSequences: ['STOP'],
      });
      expect(req0?.providerOptions).toEqual({ openai: { reasoning: { effort: 'low' } } });
      expect(req0?.headers).toEqual({ 'x-step-header': 'step-0' });

      // Step 1 omits per-step overrides: none of step 0's transient overrides leak.
      const req1 = overrideDriver.requests[1];
      expect(req1?.instructions).toEqual([{ role: 'system', content: 'Base instructions' }]);
      expect(req1?.tools.map((t) => t.name)).toEqual(['alpha', 'beta']);
      expect(req1?.settings).toEqual({});
      expect(req1?.headers).toBeUndefined();
      expect(req1?.toolChoice).toBeUndefined();
      expect(req1?.responseFormat).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });
});
