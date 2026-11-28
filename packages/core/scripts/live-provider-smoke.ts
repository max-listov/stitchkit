import { z } from 'zod';
import { anthropicProvider } from '../src/entrypoints/agent-runtime/anthropic';
import { openAiProvider } from '../src/entrypoints/agent-runtime/openai';
import { openRouterProvider } from '../src/entrypoints/agent-runtime/openrouter';
import {
  ANTHROPIC_THINKING_BUDGET,
  ANTHROPIC_THINKING_MAX_TOKENS,
  type CrossDriverLeg,
  printSummaryTable,
  REASONING_MAX_OUTPUT_TOKENS,
  runCrossDriverHandoffScenario,
  runNegativeModelUnavailableScenario,
  runOpenRouterHandoffChainScenario,
} from './live-provider-smoke-cross';
import {
  emptyMetrics,
  type ProviderTarget,
  runTimedScenario,
  type ScenarioResult,
  STANDARD_MAX_OUTPUT_TOKENS,
} from './live-provider-smoke-helpers';
import { runModelSuite } from './live-provider-smoke-scenarios';

const CliOptionsSchema = z.strictObject({
  provider: z.enum(['openrouter', 'openai', 'anthropic', 'all']).default('all'),
  openrouterOpenai: z.string().min(1).default('openai/gpt-5-mini'),
  openrouterAnthropic: z.string().min(1).default('anthropic/claude-haiku-4.5'),
  openrouterGemini: z.string().min(1).default('google/gemini-2.5-flash'),
  openaiModel: z.string().min(1).default('gpt-5-mini'),
  anthropicModel: z.string().min(1).default('claude-haiku-4-5'),
});

type CliOptions = z.infer<typeof CliOptionsSchema>;

const FLAG_TO_FIELD: Readonly<Record<string, keyof CliOptions>> = {
  '--provider': 'provider',
  '--openrouter-openai': 'openrouterOpenai',
  '--openrouter-anthropic': 'openrouterAnthropic',
  '--openrouter-gemini': 'openrouterGemini',
  '--openai-model': 'openaiModel',
  '--anthropic-model': 'anthropicModel',
};

const USAGE_TEXT = [
  'Refused: STITCHKIT_LIVE_SMOKE=1 is required to execute paid live provider API calls.',
  '',
  'Usage:',
  '  STITCHKIT_LIVE_SMOKE=1 bun packages/core/scripts/live-provider-smoke.ts [options]',
  '',
  'Options:',
  '  --provider openrouter|openai|anthropic|all   Target provider(s) (default: all)',
  '  --openrouter-openai <modelId>                Default: openai/gpt-5-mini',
  '  --openrouter-anthropic <modelId>             Default: anthropic/claude-haiku-4.5',
  '  --openrouter-gemini <modelId>                Default: google/gemini-2.5-flash',
  '  --openai-model <modelId>                     Default: gpt-5-mini',
  '  --anthropic-model <modelId>                  Default: claude-haiku-4-5',
  '',
  'Required env keys per provider: OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY.',
].join('\n');

function parseCliOptions(argv: readonly string[]): CliOptions {
  const raw: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    const eqIndex = token.indexOf('=');
    const flag = eqIndex >= 0 ? token.slice(0, eqIndex) : token;
    const field = FLAG_TO_FIELD[flag];
    if (field === undefined) throw new Error(`Unknown CLI flag: ${flag}`);
    let value: string | undefined;
    if (eqIndex >= 0) {
      value = token.slice(eqIndex + 1);
    } else {
      i += 1;
      value = argv[i];
    }
    if (value === undefined || value.trim().length === 0) {
      throw new Error(`Missing value for CLI flag: ${flag}`);
    }
    raw[field] = value.trim();
  }
  return CliOptionsSchema.parse(raw);
}

function readEnvKey(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

function unverifiedRow(provider: ProviderTarget, envVar: string): ScenarioResult {
  const detail = `UNVERIFIED (missing ${envVar})`;
  console.log(`[UNVERIFIED] ${provider} :: ${detail}`);
  return {
    provider,
    model: '-',
    scenario: 'provider-env-key',
    status: 'UNVERIFIED',
    durationMs: 0,
    metrics: emptyMetrics(),
    detail,
  };
}

interface ProviderSuiteOutcome {
  readonly results: ScenarioResult[];
  readonly crossLeg: CrossDriverLeg;
}

async function runOpenRouterSuite(
  apiKey: string,
  options: CliOptions,
  secretKeys: readonly string[],
): Promise<ProviderSuiteOutcome> {
  const factory = openRouterProvider(
    { apiKey, appName: 'stitchkit-live-provider-smoke' },
    { sessionPerConversation: true },
  );
  const openaiDriver = factory.create(options.openrouterOpenai);
  const anthropicDriver = factory.create(options.openrouterAnthropic);
  const geminiDriver = factory.create(options.openrouterGemini);
  const results: ScenarioResult[] = [
    ...(await runModelSuite({
      provider: 'openrouter',
      family: 'openai',
      modelId: options.openrouterOpenai,
      driver: openaiDriver,
      standardProviderOptions: { openrouter: { reasoning: { effort: 'low' } } },
      reasoningProviderOptions: { openrouter: { reasoning: { effort: 'low' } } },
      reasoningMaxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
      cacheProviderOptions: (cacheKey) => ({
        openrouter: { sessionId: cacheKey, reasoning: { effort: 'low' } },
      }),
      secretKeys,
    })),
    ...(await runModelSuite({
      provider: 'openrouter',
      family: 'anthropic',
      modelId: options.openrouterAnthropic,
      driver: anthropicDriver,
      reasoningProviderOptions: { openrouter: { reasoning: { effort: 'low' } } },
      reasoningMaxOutputTokens: ANTHROPIC_THINKING_MAX_TOKENS,
      cacheProviderOptions: (cacheKey) => ({ openrouter: { sessionId: cacheKey } }),
      secretKeys,
    })),
    ...(await runModelSuite({
      provider: 'openrouter',
      family: 'gemini',
      modelId: options.openrouterGemini,
      driver: geminiDriver,
      reasoningProviderOptions: { openrouter: { reasoning: { effort: 'low' } } },
      reasoningMaxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
      cacheProviderOptions: (cacheKey) => ({ openrouter: { sessionId: cacheKey } }),
      secretKeys,
    })),
  ];
  results.push(
    await runTimedScenario(
      {
        provider: 'openrouter',
        model: 'anthropic->openai->gemini->anthropic',
        scenario: '7-handoff-chain',
        secretKeys,
      },
      (signal) =>
        runOpenRouterHandoffChainScenario(
          { anthropic: anthropicDriver, openai: openaiDriver, gemini: geminiDriver },
          signal,
        ),
    ),
  );
  const badModel = 'nonexistent-vendor/does-not-exist-0000';
  results.push(
    await runTimedScenario(
      {
        provider: 'openrouter',
        model: badModel,
        scenario: '8-negative-model-unavailable',
        secretKeys,
      },
      (signal) =>
        runNegativeModelUnavailableScenario(factory.create(badModel), secretKeys, signal),
    ),
  );
  return {
    results,
    crossLeg: {
      label: `openrouter:${options.openrouterGemini}`,
      driver: geminiDriver,
      maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS,
    },
  };
}

async function runOpenAiSuite(
  apiKey: string,
  modelId: string,
  secretKeys: readonly string[],
): Promise<ProviderSuiteOutcome> {
  const factory = openAiProvider(
    { apiKey },
    { defaultPolicy: { store: false }, cachePerConversation: true },
  );
  const driver = factory.create(modelId);
  const results = await runModelSuite({
    provider: 'openai',
    family: 'openai',
    modelId,
    driver,
    standardProviderOptions: { openai: { store: false, reasoning: { effort: 'low' } } },
    reasoningProviderOptions: {
      openai: { store: false, reasoning: { effort: 'low', summary: 'auto' } },
    },
    reasoningMaxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
    cacheProviderOptions: (cacheKey) => ({
      openai: { store: false, promptCacheKey: cacheKey, reasoning: { effort: 'low' } },
    }),
    secretKeys,
  });
  const badModel = 'gpt-nonexistent-0000';
  results.push(
    await runTimedScenario(
      {
        provider: 'openai',
        model: badModel,
        scenario: '8-negative-model-unavailable',
        secretKeys,
      },
      (signal) =>
        runNegativeModelUnavailableScenario(factory.create(badModel), secretKeys, signal),
    ),
  );
  return {
    results,
    crossLeg: {
      label: `openai:${modelId}`,
      driver,
      maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS,
      providerOptions: { openai: { store: false, reasoning: { effort: 'low' } } },
    },
  };
}

async function runAnthropicSuite(
  apiKey: string,
  modelId: string,
  secretKeys: readonly string[],
): Promise<ProviderSuiteOutcome> {
  const factory = anthropicProvider({ apiKey });
  const driver = factory.create(modelId);
  const results = await runModelSuite({
    provider: 'anthropic',
    family: 'anthropic',
    modelId,
    driver,
    isDirectAnthropic: true,
    reasoningProviderOptions: {
      anthropic: { thinking: { type: 'enabled', budgetTokens: ANTHROPIC_THINKING_BUDGET } },
    },
    reasoningMaxOutputTokens: ANTHROPIC_THINKING_MAX_TOKENS,
    cacheProviderOptions: () => undefined,
    secretKeys,
  });
  const badModel = 'claude-nonexistent-0000';
  results.push(
    await runTimedScenario(
      {
        provider: 'anthropic',
        model: badModel,
        scenario: '8-negative-model-unavailable',
        secretKeys,
      },
      (signal) =>
        runNegativeModelUnavailableScenario(factory.create(badModel), secretKeys, signal),
    ),
  );
  return {
    results,
    crossLeg: {
      label: `anthropic:${modelId}`,
      driver,
      maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS,
    },
  };
}

async function main(): Promise<void> {
  if (process.env.STITCHKIT_LIVE_SMOKE !== '1') {
    console.error(USAGE_TEXT);
    process.exitCode = 1;
    return;
  }

  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Invalid arguments: ${message}\n\n${USAGE_TEXT}`);
    process.exitCode = 1;
    return;
  }

  const openrouterKey = readEnvKey('OPENROUTER_API_KEY');
  const openaiKey = readEnvKey('OPENAI_API_KEY');
  const anthropicKey = readEnvKey('ANTHROPIC_API_KEY');
  const secretKeys = [openrouterKey, openaiKey, anthropicKey].filter(
    (value): value is string => value !== undefined,
  );
  const targets: ProviderTarget[] =
    options.provider === 'all' ? ['openrouter', 'openai', 'anthropic'] : [options.provider];

  const startedAt = performance.now();
  const results: ScenarioResult[] = [];
  const crossLegs: CrossDriverLeg[] = [];
  let missingRequestedExplicitProvider = false;

  for (const target of targets) {
    if (target === 'openrouter') {
      if (!openrouterKey) {
        results.push(unverifiedRow('openrouter', 'OPENROUTER_API_KEY'));
        if (options.provider === 'openrouter') missingRequestedExplicitProvider = true;
      } else {
        const outcome = await runOpenRouterSuite(openrouterKey, options, secretKeys);
        results.push(...outcome.results);
        crossLegs.push(outcome.crossLeg);
      }
      continue;
    }
    if (target === 'openai') {
      if (!openaiKey) {
        results.push(unverifiedRow('openai', 'OPENAI_API_KEY'));
        if (options.provider === 'openai') missingRequestedExplicitProvider = true;
      } else {
        const outcome = await runOpenAiSuite(openaiKey, options.openaiModel, secretKeys);
        results.push(...outcome.results);
        crossLegs.push(outcome.crossLeg);
      }
      continue;
    }
    if (!anthropicKey) {
      results.push(unverifiedRow('anthropic', 'ANTHROPIC_API_KEY'));
      if (options.provider === 'anthropic') missingRequestedExplicitProvider = true;
    } else {
      const outcome = await runAnthropicSuite(
        anthropicKey,
        options.anthropicModel,
        secretKeys,
      );
      results.push(...outcome.results);
      crossLegs.push(outcome.crossLeg);
    }
  }

  if (crossLegs.length >= 2) {
    results.push(
      await runTimedScenario(
        {
          provider: 'cross-driver',
          model: crossLegs.map((leg) => leg.label).join('->'),
          scenario: '7b-cross-driver-handoff',
          secretKeys,
        },
        (signal) => runCrossDriverHandoffScenario(crossLegs, signal),
      ),
    );
  }

  printSummaryTable(results, performance.now() - startedAt);

  const executedCount = results.filter((r) => r.status !== 'UNVERIFIED').length;
  const failedCount = results.filter((r) => r.status === 'FAIL').length;
  if (failedCount > 0 || missingRequestedExplicitProvider || executedCount === 0) {
    process.exitCode = 1;
  }
}

await main();
