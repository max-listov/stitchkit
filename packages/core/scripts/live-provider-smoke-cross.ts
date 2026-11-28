import { z } from 'zod';
import {
  type AgentModelDriver,
  type AgentModelMessage,
  type AgentModelProviderOptions,
  AgentProviderError,
  classifyProviderFailure,
  completeText,
} from '../src/entrypoints/agent-runtime';
import { type AgentToolSet, defineAgentTool } from '../src/entrypoints/tools';
import {
  assertCondition,
  assertNoKeyLeak,
  emptyMetrics,
  extractMetrics,
  mergeMetrics,
  type ScenarioExecution,
  type ScenarioMetrics,
  type ScenarioResult,
  STANDARD_MAX_OUTPUT_TOKENS,
  scrubSecrets,
} from './live-provider-smoke-helpers';

export const ANTHROPIC_THINKING_MAX_TOKENS = 1536;
export const ANTHROPIC_THINKING_BUDGET = 1024;
export const REASONING_MAX_OUTPUT_TOKENS = 1024;

async function runHandoffToolTurn(input: {
  readonly label: string;
  readonly driver: AgentModelDriver;
  readonly history: AgentModelMessage[];
  readonly prompt: string;
  readonly tools: AgentToolSet;
  readonly maxOutputTokens: number;
  readonly providerOptions?: AgentModelProviderOptions;
  readonly expectedToken: string;
  readonly didToolRun: () => boolean;
  readonly signal: AbortSignal;
}): Promise<ScenarioMetrics> {
  input.history.push({ role: 'user', content: input.prompt });
  const result = await completeText({
    driver: input.driver,
    messages: input.history,
    tools: input.tools,
    maxSteps: 3,
    settings: { maxOutputTokens: input.maxOutputTokens },
    ...(input.providerOptions !== undefined && { providerOptions: input.providerOptions }),
    signal: input.signal,
  });
  assertCondition(
    input.didToolRun() && result.steps.length >= 2,
    `${input.label} failed to execute its tool`,
  );
  assertCondition(
    result.text.includes(input.expectedToken),
    `${input.label} missed ${input.expectedToken}: ${result.text.slice(0, 120)}`,
  );
  input.history.push(...result.responseMessages);
  return extractMetrics(result.usage);
}

/**
 * Scenario 7: 4-step cross-family handoff via OpenRouter passing accumulated history
 * across Anthropic (reasoning+tool) -> OpenAI (tool) -> Gemini (tool) -> Anthropic synthesis.
 */
export async function runOpenRouterHandoffChainScenario(
  drivers: {
    readonly anthropic: AgentModelDriver;
    readonly openai: AgentModelDriver;
    readonly gemini: AgentModelDriver;
  },
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  let stage1Calls = 0;
  let stage2Calls = 0;
  let stage3Calls = 0;
  const chainTools: AgentToolSet = {
    fetch_stage_one: defineAgentTool({
      description: 'Fetch the stage 1 handoff token for a ticket.',
      input: z.object({ ticket: z.string().min(1) }),
      execute: ({ ticket }) => {
        stage1Calls += 1;
        return { ticket, stage1Token: 'ALPHA-11' };
      },
    }),
    fetch_stage_two: defineAgentTool({
      description: 'Exchange the stage 1 token for the stage 2 handoff token.',
      input: z.object({ stage1Token: z.string().min(1) }),
      execute: ({ stage1Token }) => {
        stage2Calls += 1;
        return { from: stage1Token, stage2Token: 'BETA-22' };
      },
    }),
    fetch_stage_three: defineAgentTool({
      description: 'Exchange the stage 2 token for the stage 3 handoff token.',
      input: z.object({ stage2Token: z.string().min(1) }),
      execute: ({ stage2Token }) => {
        stage3Calls += 1;
        return { from: stage2Token, stage3Token: 'GAMMA-33' };
      },
    }),
  };

  const history: AgentModelMessage[] = [];
  const collectedMetrics: ScenarioMetrics[] = [];
  collectedMetrics.push(
    await runHandoffToolTurn({
      label: 'Handoff step 1 (Anthropic)',
      driver: drivers.anthropic,
      history,
      prompt:
        'Step 1: Call fetch_stage_one(ticket="CHAIN-01"), then briefly report stage1Token.',
      tools: chainTools,
      maxOutputTokens: ANTHROPIC_THINKING_MAX_TOKENS,
      providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
      expectedToken: 'ALPHA-11',
      didToolRun: () => stage1Calls >= 1,
      signal,
    }),
  );
  collectedMetrics.push(
    await runHandoffToolTurn({
      label: 'Handoff step 2 (OpenAI)',
      driver: drivers.openai,
      history,
      prompt:
        'Step 2: Using stage1Token from Step 1, call fetch_stage_two and report stage2Token.',
      tools: chainTools,
      maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS,
      providerOptions: { openrouter: { reasoning: { effort: 'low' } } },
      expectedToken: 'BETA-22',
      didToolRun: () => stage2Calls >= 1,
      signal,
    }),
  );
  collectedMetrics.push(
    await runHandoffToolTurn({
      label: 'Handoff step 3 (Gemini)',
      driver: drivers.gemini,
      history,
      prompt:
        'Step 3: Using stage2Token from Step 2, call fetch_stage_three and report stage3Token.',
      tools: chainTools,
      maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS,
      expectedToken: 'GAMMA-33',
      didToolRun: () => stage3Calls >= 1,
      signal,
    }),
  );

  history.push({
    role: 'user',
    content:
      'Step 4: Do not call any tools. In one short sentence, list the exact stage1Token, stage2Token, and stage3Token from Steps 1-3.',
  });
  const step4 = await completeText({
    driver: drivers.anthropic,
    messages: history,
    tools: chainTools,
    toolChoice: 'none',
    maxSteps: 1,
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    signal,
  });
  collectedMetrics.push(extractMetrics(step4.usage));
  assertCondition(
    step4.text.includes('ALPHA-11') &&
      step4.text.includes('BETA-22') &&
      step4.text.includes('GAMMA-33'),
    `Handoff step 4 missed one or more tokens: ${step4.text.slice(0, 140)}`,
  );
  return {
    metrics: mergeMetrics(collectedMetrics),
    detail: `historyMsgs=${history.length} 4-family-handoff=ok`,
  };
}

export interface CrossDriverLeg {
  readonly label: string;
  readonly driver: AgentModelDriver;
  readonly maxOutputTokens: number;
  readonly providerOptions?: AgentModelProviderOptions;
}

/**
 * Scenario 7b: Cross-driver handoff across >= 2 distinct live provider drivers
 * (for example direct OpenAI / Anthropic and OpenRouter), proving history portability
 * across different wire transports when multiple API keys are configured.
 */
export async function runCrossDriverHandoffScenario(
  legs: readonly CrossDriverLeg[],
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  assertCondition(legs.length >= 2, 'Cross-driver handoff requires at least 2 provider legs');
  const first = legs[0];
  const second = legs[1];
  const third = legs[2];
  assertCondition(
    first !== undefined && second !== undefined,
    'Missing required cross-driver legs',
  );
  let stage1Calls = 0;
  let stage2Calls = 0;
  const tools: AgentToolSet = {
    cross_stage_one: defineAgentTool({
      description: 'Fetch the first cross-driver verification token.',
      input: z.object({ ticket: z.string().min(1) }),
      execute: ({ ticket }) => {
        stage1Calls += 1;
        return { ticket, stage1Token: 'XDRV-ALPHA-11' };
      },
    }),
    cross_stage_two: defineAgentTool({
      description: 'Exchange the stage 1 token for the second cross-driver token.',
      input: z.object({ stage1Token: z.string().min(1) }),
      execute: ({ stage1Token }) => {
        stage2Calls += 1;
        return { from: stage1Token, stage2Token: 'XDRV-BETA-22' };
      },
    }),
  };

  const history: AgentModelMessage[] = [];
  const collectedMetrics: ScenarioMetrics[] = [];
  collectedMetrics.push(
    await runHandoffToolTurn({
      label: `Cross-driver leg 1 (${first.label})`,
      driver: first.driver,
      history,
      prompt:
        'Step 1: Call cross_stage_one(ticket="XDRV-01"), then briefly report stage1Token.',
      tools,
      maxOutputTokens: first.maxOutputTokens,
      ...(first.providerOptions !== undefined && { providerOptions: first.providerOptions }),
      expectedToken: 'XDRV-ALPHA-11',
      didToolRun: () => stage1Calls >= 1,
      signal,
    }),
  );
  collectedMetrics.push(
    await runHandoffToolTurn({
      label: `Cross-driver leg 2 (${second.label})`,
      driver: second.driver,
      history,
      prompt:
        'Step 2: Using stage1Token from Step 1, call cross_stage_two and report stage2Token.',
      tools,
      maxOutputTokens: second.maxOutputTokens,
      ...(second.providerOptions !== undefined && { providerOptions: second.providerOptions }),
      expectedToken: 'XDRV-BETA-22',
      didToolRun: () => stage2Calls >= 1,
      signal,
    }),
  );

  const synthesizer = third ?? first;
  history.push({
    role: 'user',
    content:
      'Final step: Do not call any tools. In one short sentence, list both exact tokens from Steps 1 and 2.',
  });
  const finalTurn = await completeText({
    driver: synthesizer.driver,
    messages: history,
    tools,
    toolChoice: 'none',
    maxSteps: 1,
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    signal,
  });
  collectedMetrics.push(extractMetrics(finalTurn.usage));
  assertCondition(
    finalTurn.text.includes('XDRV-ALPHA-11') && finalTurn.text.includes('XDRV-BETA-22'),
    `Cross-driver final turn missed tokens: ${finalTurn.text.slice(0, 140)}`,
  );
  return {
    metrics: mergeMetrics(collectedMetrics),
    detail: `legs=${legs.map((l) => l.label).join('->')} historyMsgs=${history.length}`,
  };
}

/**
 * Scenario 8: Negative error path proving typed `AgentProviderError`, `model-unavailable`
 * classification, and zero API key leakage in message or response body.
 */
export async function runNegativeModelUnavailableScenario(
  driver: AgentModelDriver,
  secretKeys: readonly string[],
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  let caught: unknown;
  try {
    await completeText({
      driver,
      prompt: 'Respond with OK.',
      settings: { maxOutputTokens: 128 },
      signal,
    });
  } catch (error) {
    caught = error;
  }
  assertCondition(caught !== undefined, 'Expected nonexistent model request to throw');
  assertCondition(
    caught instanceof AgentProviderError,
    `Expected AgentProviderError, got ${caught instanceof Error ? caught.name : typeof caught}`,
  );
  assertNoKeyLeak(caught.message, secretKeys, 'error.message');
  if (caught.responseBody !== undefined) {
    assertNoKeyLeak(caught.responseBody, secretKeys, 'error.responseBody');
  }
  assertNoKeyLeak(String(caught), secretKeys, 'String(error)');
  const classified = classifyProviderFailure(caught);
  assertCondition(
    classified.reason === 'model-unavailable',
    `Expected failure reason "model-unavailable", got "${classified.reason}" ` +
      `(status=${String(caught.statusCode)}, code=${String(caught.code)}, msg=${scrubSecrets(caught.message, secretKeys)})`,
  );
  return {
    metrics: emptyMetrics(),
    detail: `reason=${classified.reason} status=${String(caught.statusCode ?? 'n/a')} keyLeak=0`,
  };
}

function fmtNum(value: number | undefined): string {
  return value === undefined ? '-' : String(value);
}

function fmtUsd(value: number | undefined): string {
  return value === undefined ? 'n/a' : `$${value.toFixed(6)}`;
}

/** Print compact aligned summary table and totals across all executed/unverified scenarios. */
export function printSummaryTable(results: readonly ScenarioResult[], totalMs: number): void {
  const headers = [
    'Provider',
    'Model',
    'Scenario',
    'Status',
    'Ms',
    'In',
    'Out',
    'CacheR',
    'Reason',
    'Cost USD',
    'Detail',
  ];
  const rows = results.map((r) => [
    r.provider,
    r.model,
    r.scenario,
    r.status,
    String(r.durationMs),
    fmtNum(r.metrics.inputTokens),
    fmtNum(r.metrics.outputTokens),
    fmtNum(r.metrics.cacheReadTokens),
    fmtNum(r.metrics.reasoningTokens),
    fmtUsd(r.metrics.costUsd),
    r.detail,
  ]);
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => (row[col] ?? '').length)),
  );
  const formatLine = (cells: readonly string[]) =>
    cells.map((cell, col) => cell.padEnd(widths[col] ?? cell.length)).join(' | ');
  const divider = widths.map((w) => '-'.repeat(w)).join('-+-');

  console.log('');
  console.log(formatLine(headers));
  console.log(divider);
  for (const row of rows) console.log(formatLine(row));

  const executed = results.filter((r) => r.status !== 'UNVERIFIED');
  const passed = executed.filter((r) => r.status === 'PASS').length;
  const failed = executed.filter((r) => r.status === 'FAIL').length;
  const unverified = results.filter((r) => r.status === 'UNVERIFIED').length;
  const totals = mergeMetrics(executed.map((r) => r.metrics));
  const anyUnreportedCost = executed.some(
    (r) =>
      r.status === 'PASS' &&
      r.metrics.inputTokens !== undefined &&
      r.metrics.costUsd === undefined,
  );
  const costSummary =
    totals.costUsd !== undefined
      ? `$${totals.costUsd.toFixed(6)} USD${anyUnreportedCost ? ' (measured only; direct providers omit wire USD)' : ''}`
      : 'n/a (no wire USD reported)';

  console.log('');
  console.log(
    `Summary: PASS=${passed} FAIL=${failed} UNVERIFIED=${unverified} | ` +
      `Tokens in=${fmtNum(totals.inputTokens)} out=${fmtNum(totals.outputTokens)} ` +
      `cacheR=${fmtNum(totals.cacheReadTokens)} reason=${fmtNum(totals.reasoningTokens)} | ` +
      `Total Cost: ${costSummary} | Elapsed: ${Math.round(totalMs)}ms`,
  );
}
