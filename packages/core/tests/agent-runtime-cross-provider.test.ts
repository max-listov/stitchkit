import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { AgentModelMessage } from '../src/agent-parts/model';
import { anthropicProvider } from '../src/agent-runtime/anthropic';
import { openAiProvider } from '../src/agent-runtime/openai';
import { openRouterProvider } from '../src/agent-runtime/openrouter';
import { completeText } from '../src/agent-runtime/run-complete';
import {
  createAgentRuntime,
  createMemoryAgentRuntimeStore,
  defineAgentProtocol,
} from '../src/entrypoints/agent-runtime';
import { defineAgentTool } from '../src/tools/agent-tools';

function sseResponse(frames: readonly string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

describe('cross-provider conversation handoff (Anthropic -> OpenAI -> OpenRouter -> Anthropic)', () => {
  test('switches cleanly across all three native providers while preserving valid reasoning and tool traffic', async () => {
    const capturedBodies: Array<{ provider: string; body: Record<string, unknown> }> = [];
    let anthropicCall = 0;

    const anthropic = anthropicProvider(
      {
        apiKey: 'sk-ant-test',
        baseUrl: 'https://anthropic.invalid/v1',
        fetch: async (_input, init) => {
          anthropicCall += 1;
          const body = JSON.parse(String(init?.body ?? '{}'));
          capturedBodies.push({ provider: `anthropic-${anthropicCall}`, body });
          if (anthropicCall === 1) {
            return sseResponse([
              `event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: {
                  id: 'msg_ant_1',
                  model: 'claude-sonnet-4-5',
                  usage: { input_tokens: 40 },
                },
              })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '' },
              })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'Checking weather first.' },
              })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'ant-sig-1' },
              })}\n\n`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 1,
                content_block: { type: 'redacted_thinking', data: 'ant-redacted-blob' },
              })}\n\n`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 1 })}\n\n`,
              `event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 2,
                content_block: {
                  type: 'tool_use',
                  id: 'toolu_ant_1',
                  name: 'lookup',
                  input: {},
                },
              })}\n\n`,
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 2,
                delta: { type: 'input_json_delta', partial_json: '{"topic":"tokyo"}' },
              })}\n\n`,
              `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 2 })}\n\n`,
              `event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'tool_use' },
                usage: { output_tokens: 18 },
              })}\n\n`,
              `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
            ]);
          }
          return sseResponse([
            `event: message_start\ndata: ${JSON.stringify({
              type: 'message_start',
              message: {
                id: 'msg_ant_2',
                model: 'claude-sonnet-4-5',
                usage: { input_tokens: 80 },
              },
            })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'Final Anthropic synthesis complete.' },
            })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
            `event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 9 },
            })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
          ]);
        },
      },
      { defaultPolicy: { maxOutputTokens: 2048 } },
    );

    const openai = openAiProvider({
      apiKey: 'sk-openai-test',
      baseUrl: 'https://openai.invalid/v1',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        capturedBodies.push({ provider: 'openai', body });
        return sseResponse([
          `event: response.created\ndata: ${JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_oai_1', model: 'gpt-5' },
          })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              id: 'rs_oai_1',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'Reviewed Tokyo lookup.' }],
              encrypted_content: 'enc_oai_blob',
            },
          })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({
            type: 'response.output_item.done',
            output_index: 1,
            item: {
              id: 'fc_oai_1',
              type: 'function_call',
              call_id: 'call:oai/with.weird+chars',
              name: 'lookup',
              arguments: '{"topic":"kyoto"}',
            },
          })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_oai_1',
              model: 'gpt-5',
              status: 'completed',
              usage: { input_tokens: 55, output_tokens: 22, total_tokens: 77 },
              output: [],
            },
          })}\n\n`,
        ]);
      },
    });

    const openrouter = openRouterProvider({
      apiKey: 'sk-or-test',
      baseUrl: 'https://openrouter.invalid/api/v1',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body ?? '{}'));
        capturedBodies.push({ provider: 'openrouter', body });
        return sseResponse([
          `data: ${JSON.stringify({
            id: 'gen_or_1',
            model: 'deepseek/deepseek-r1',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  reasoning_details: [
                    {
                      type: 'reasoning.text',
                      text: 'Comparing Tokyo and Kyoto.',
                      format: 'unknown',
                    },
                  ],
                  content: 'OpenRouter compared both cities.',
                },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 70,
              completion_tokens: 15,
              total_tokens: 85,
              cost: 0.0012,
            },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]);
      },
    });

    const lookupTool = defineAgentTool({
      description: 'Lookup a city topic',
      input: z.object({ topic: z.string() }),
      needsApproval: (input) => input.topic === 'never',
      execute: async (input) => ({ found: input.topic.toUpperCase() }),
    });

    // Compile-time proof that defineAgentTool with typed needsApproval assigns to AgentToolSet directly.
    const tools = { lookup: lookupTool };

    const drivers = [
      anthropic.create('claude-sonnet-4-5'),
      openai.create('gpt-5'),
      openrouter.create('deepseek/deepseek-r1'),
    ];
    let stepIndex = 0;

    // Step 1 (Anthropic tool_use) -> Step 2 (OpenAI function_call) -> Step 3 (OpenRouter stop)
    const firstTurn = await completeText({
      driver: {
        provider: 'switch-test',
        modelId: 'multi',
        stream(request, signal) {
          const target = drivers[stepIndex] ?? drivers[2];
          if (!target) throw new Error('Missing scripted provider driver');
          stepIndex += 1;
          return target.stream(request, signal);
        },
      },
      instructions: 'Be concise.',
      messages: [{ role: 'user', content: 'Compare Tokyo and Kyoto.' }],
      tools,
      maxSteps: 4,
    });

    expect(firstTurn.text).toBe('OpenRouter compared both cities.');
    expect(firstTurn.steps).toHaveLength(3);

    // Inspect OpenAI wire payload: must NOT forward Anthropic thinking/redacted blocks, must forward tool call/result
    const openaiBody = capturedBodies.find((entry) => entry.provider === 'openai')?.body;
    expect(openaiBody).toBeDefined();
    const openaiInput = JSON.stringify(openaiBody?.input ?? []);
    expect(openaiInput).not.toContain('ant-sig-1');
    expect(openaiInput).not.toContain('ant-redacted-blob');
    expect(openaiInput).toContain('toolu_ant_1');
    expect(openaiInput).toContain('TOKYO');

    // Inspect OpenRouter wire payload: must NOT forward OpenAI encrypted_content or Anthropic signatures
    const openrouterBody = capturedBodies.find(
      (entry) => entry.provider === 'openrouter',
    )?.body;
    expect(openrouterBody).toBeDefined();
    const openrouterMsgs = JSON.stringify(openrouterBody?.messages ?? []);
    expect(openrouterMsgs).not.toContain('enc_oai_blob');
    expect(openrouterMsgs).not.toContain('ant-sig-1');
    expect(openrouterMsgs).toContain('KYOTO');

    // Turn 4: run full createAgentRuntime on Anthropic with the accumulated multi-provider history!
    const history: AgentModelMessage[] = [
      { role: 'user', content: 'Compare Tokyo and Kyoto.' },
      ...firstTurn.responseMessages,
    ];
    const store = createMemoryAgentRuntimeStore();
    const anthropicDriver = anthropic.create('claude-sonnet-4-5');
    const runtime = createAgentRuntime({
      store,
      protocol: defineAgentProtocol({ context: z.object({}), inputMetadata: z.object({}) }),
      models: {
        resolve: () => ({
          descriptor: {
            provider: 'anthropic',
            modelId: 'claude-sonnet-4-5',
            contextWindow: 200_000,
            capabilities: ['tools', 'reasoning'],
          },
          driver: anthropicDriver,
        }),
      },
      prompt: () => ({
        instructions: 'Be concise.',
        sections: [],
        instructionTokens: { provenance: 'unavailable' as const },
        contextDecision: 'unavailable' as const,
      }),
      tools: () => tools,
      loop: {
        prepareStep: ({ messages }) => ({
          messages: [...history, ...messages.slice(1)],
        }),
      },
    });
    const finalResult = await runtime.submit({
      conversationId: 'conv-cross-provider',
      idempotencyKey: crypto.randomUUID(),
      context: {},
      parts: [{ type: 'text', text: 'Give final verdict.' }],
    }).result;
    expect(finalResult.reason).toBe('success');
    const textPart = finalResult.message.parts.find((p) => p.type === 'text');
    expect(textPart).toEqual({ type: 'text', text: 'Final Anthropic synthesis complete.' });

    // Inspect Anthropic turn 2 wire payload:
    // 1. Preserves its own Anthropic thinking + signature + redacted_thinking from step 1
    // 2. Drops foreign OpenAI/OpenRouter reasoning blocks
    // 3. Sanitizes OpenAI's non-[a-zA-Z0-9_-] call_id (`call:oai/with.weird+chars`) bijectively across tool_use & tool_result
    const anthropic2Body = capturedBodies.find(
      (entry) => entry.provider === 'anthropic-2',
    )?.body;
    expect(anthropic2Body).toBeDefined();
    const ant2Wire = JSON.stringify(anthropic2Body?.messages ?? []);
    expect(ant2Wire).toContain('ant-sig-1');
    expect(ant2Wire).toContain('ant-redacted-blob');
    expect(ant2Wire).not.toContain('enc_oai_blob');
    expect(ant2Wire).not.toContain('call:oai/with.weird+chars');

    // Verify every Anthropic tool_use / tool_result ID conforms strictly to /^[a-zA-Z0-9_-]{1,64}$/
    const ids = [...ant2Wire.matchAll(/"(?:id|tool_use_id)":"([^"]+)"/g)].map(
      (m) => m[1] ?? '',
    );
    expect(ids.length).toBeGreaterThanOrEqual(4);
    for (const id of ids) {
      expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
  });
});
