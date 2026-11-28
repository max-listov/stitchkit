import { z } from 'zod';
import {
  type AgentModelMessage,
  type AgentModelSystemMessage,
  completeObject,
  completeText,
} from '../src/entrypoints/agent-runtime';
import { defineAgentTool } from '../src/entrypoints/tools';
import {
  assertCondition,
  BLUE_PNG,
  buildStaticCacheHandbook,
  COMPACT_MAX_OUTPUT_TOKENS,
  extractMetrics,
  inspectReasoningArtifacts,
  type ModelScenarioSpec,
  mergeMetrics,
  pauseMs,
  RED_PNG,
  runTimedScenario,
  type ScenarioExecution,
  type ScenarioMetrics,
  type ScenarioResult,
  STANDARD_MAX_OUTPUT_TOKENS,
} from './live-provider-smoke-helpers';

const StructuredCitySchema = z.object({
  city: z.string().min(1),
  country: z.enum(['JP', 'FR', 'US']),
  note: z.string().optional(),
  meta: z.object({
    populationRank: z.number().int(),
  }),
  classification: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('capital'),
      seat: z.string().min(1),
      alias: z.string().optional(),
    }),
    z.object({
      kind: z.literal('port'),
      harbor: z.string().min(1),
    }),
  ]),
  landmarks: z
    .array(
      z.object({
        id: z.string().min(1),
        note: z.string().optional(),
      }),
    )
    .nullable(),
});

async function runStreamingTextScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  const result = await completeText({
    driver: spec.driver,
    prompt:
      'Reply in one short sentence confirming the live check and include the token SMOKE_OK.',
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    ...(spec.standardProviderOptions !== undefined && {
      providerOptions: spec.standardProviderOptions,
    }),
    signal,
  });
  const step = result.steps[0];
  assertCondition(result.text.trim().length > 0, 'Expected non-empty completion text');
  assertCondition(
    step !== undefined && step.response.id.trim().length > 0,
    'Expected non-empty response.id',
  );
  const metrics = extractMetrics(result.usage);
  assertCondition(
    metrics.inputTokens !== undefined &&
      Number.isInteger(metrics.inputTokens) &&
      metrics.inputTokens > 0,
    `Expected positive integer inputTokens, got ${String(metrics.inputTokens)}`,
  );
  assertCondition(
    metrics.outputTokens !== undefined &&
      Number.isInteger(metrics.outputTokens) &&
      metrics.outputTokens > 0,
    `Expected positive integer outputTokens, got ${String(metrics.outputTokens)}`,
  );
  if (spec.provider === 'openrouter') {
    assertCondition(
      metrics.costUsd !== undefined && metrics.costUsd >= 0,
      `Expected OpenRouter cost provenance, got ${metrics.costProvenance}`,
    );
    assertCondition(
      typeof step.response.provider === 'string' && step.response.provider.length > 0,
      'Expected non-empty OpenRouter responseProvider',
    );
  }
  const upstream = step.response.provider
    ? `upstream=${step.response.provider}`
    : `id=${step.response.id.slice(0, 14)}`;
  return { metrics, detail: upstream };
}

async function runParallelToolLoopScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  let addCalls = 0;
  let markerCalls = 0;
  const tools = {
    add_numbers: defineAgentTool({
      description: 'Add two integers and return their exact sum.',
      input: z.object({ a: z.number().int(), b: z.number().int() }),
      execute: ({ a, b }) => {
        addCalls += 1;
        return { sum: a + b };
      },
    }),
    get_marker: defineAgentTool({
      description: 'Return the verification marker string. Takes no arguments.',
      input: z.object({}),
      execute: () => {
        markerCalls += 1;
        return { marker: 'DELTA-742' };
      },
    }),
  };
  const result = await completeText({
    driver: spec.driver,
    prompt:
      'Call BOTH add_numbers(a=19, b=23) AND get_marker() in parallel before answering. ' +
      'Then reply in one short sentence containing both the exact sum and the exact marker.',
    tools,
    maxSteps: 4,
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    ...(spec.standardProviderOptions !== undefined && {
      providerOptions: spec.standardProviderOptions,
    }),
    signal,
  });
  assertCondition(
    addCalls >= 1 && markerCalls >= 1,
    `Expected both tools to run (add=${addCalls}, marker=${markerCalls})`,
  );
  assertCondition(result.steps.length >= 2, `Expected >= 2 steps, got ${result.steps.length}`);
  assertCondition(
    result.text.includes('42') && result.text.includes('DELTA-742'),
    `Expected "42" and "DELTA-742" in final text, got: ${result.text.slice(0, 140)}`,
  );
  return { metrics: extractMetrics(result.usage), detail: `steps=${result.steps.length}` };
}

async function runCompleteObjectScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  const result = await completeObject({
    driver: spec.driver,
    schema: StructuredCitySchema,
    schemaName: 'city_record',
    strict: true,
    prompt:
      'Return JSON for Tokyo: city="Tokyo", country="JP", meta.populationRank=1, ' +
      'classification={ kind: "capital", seat: "Chiyoda" } (omit optional "alias"), ' +
      'landmarks=[{ id: "tokyo-tower" }] (omit optional "note" on the landmark). ' +
      'Also omit top-level optional "note" completely (leave omitted optional fields unset or null).',
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    ...(spec.standardProviderOptions !== undefined && {
      providerOptions: spec.standardProviderOptions,
    }),
    signal,
  });
  assertCondition(
    result.object.city.toLowerCase().includes('tokyo'),
    `Unexpected city: ${result.object.city}`,
  );
  assertCondition(
    result.object.country === 'JP',
    `Unexpected country: ${result.object.country}`,
  );
  assertCondition(
    result.object.note === undefined,
    `Expected omitted optional note === undefined, got ${JSON.stringify(result.object.note)}`,
  );
  assertCondition(
    result.object.meta.populationRank === 1,
    `Unexpected populationRank: ${String(result.object.meta.populationRank)}`,
  );
  assertCondition(
    result.object.classification.kind === 'capital',
    `Unexpected classification.kind: ${result.object.classification.kind}`,
  );
  assertCondition(
    result.object.classification.seat.toLowerCase().includes('chiyoda'),
    `Unexpected classification.seat: ${result.object.classification.seat}`,
  );
  assertCondition(
    result.object.classification.alias === undefined,
    `Expected omitted classification.alias === undefined, got ${JSON.stringify(result.object.classification.alias)}`,
  );
  assertCondition(
    Array.isArray(result.object.landmarks) && result.object.landmarks.length >= 1,
    `Expected non-empty landmarks array, got ${JSON.stringify(result.object.landmarks)}`,
  );
  const firstLandmark = result.object.landmarks[0];
  assertCondition(
    firstLandmark !== undefined && firstLandmark.id.trim().length > 0,
    `Unexpected first landmark: ${JSON.stringify(firstLandmark)}`,
  );
  assertCondition(
    firstLandmark.note === undefined,
    `Expected omitted landmark.note === undefined, got ${JSON.stringify(firstLandmark.note)}`,
  );
  return {
    metrics: extractMetrics(result.usage),
    detail: 'optional=undefined,union=ok,arrNull=ok',
  };
}

async function runMultimodalPngScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  let swatchCalls = 0;
  const tools = {
    get_swatch_b: defineAgentTool({
      description: 'Fetch Swatch B as a 16x16 PNG image for visual color inspection.',
      input: z.object({}),
      execute: () => {
        swatchCalls += 1;
        return { label: 'swatch-b' };
      },
      toModelOutput: () => ({
        type: 'content',
        value: [
          { type: 'text', text: 'Attached below is Swatch B (16x16 PNG).' },
          {
            type: 'file',
            data: { type: 'data', data: BLUE_PNG },
            mediaType: 'image/png',
            filename: 'swatch-b.png',
          },
        ],
      }),
    }),
  };
  const messages: AgentModelMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            'The attached image is Swatch A. First call get_swatch_b() to inspect Swatch B, ' +
            'then reply in one short sentence naming the dominant color (red or blue) of Swatch A and of Swatch B.',
        },
        {
          type: 'file',
          data: { type: 'data', data: RED_PNG },
          mediaType: 'image/png',
          filename: 'swatch-a.png',
        },
      ],
    },
  ];
  const result = await completeText({
    driver: spec.driver,
    messages,
    tools,
    maxSteps: 3,
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    ...(spec.standardProviderOptions !== undefined && {
      providerOptions: spec.standardProviderOptions,
    }),
    signal,
  });
  assertCondition(swatchCalls >= 1, 'Expected get_swatch_b tool to run');
  assertCondition(result.steps.length >= 2, `Expected >= 2 steps, got ${result.steps.length}`);
  const lower = result.text.toLowerCase();
  assertCondition(
    lower.includes('red') && lower.includes('blue'),
    `Expected red and blue in reply, got: ${result.text.slice(0, 140)}`,
  );
  return { metrics: extractMetrics(result.usage), detail: 'user+tool PNG=ok' };
}

async function runAnthropicErrorImageToolScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  let probeCalls = 0;
  const tools = {
    inspect_failed_frame: defineAgentTool({
      description: 'Return an error diagnostic accompanied by a 16x16 PNG screenshot.',
      input: z.object({}),
      execute: () => {
        probeCalls += 1;
        return { failed: true };
      },
      toModelOutput: () => ({
        type: 'content',
        providerOptions: { anthropic: { isError: true } },
        value: [
          { type: 'text', text: 'Probe failed with code ERR-512; see attached blue swatch.' },
          {
            type: 'file',
            data: { type: 'data', data: BLUE_PNG },
            mediaType: 'image/png',
            filename: 'error-swatch.png',
          },
        ],
      }),
    }),
  };
  const result = await completeText({
    driver: spec.driver,
    prompt:
      'Call inspect_failed_frame(), then reply in one short sentence citing the error code ' +
      'and the dominant color (red or blue) of the attached diagnostic image.',
    tools,
    maxSteps: 3,
    settings: { maxOutputTokens: STANDARD_MAX_OUTPUT_TOKENS },
    signal,
  });
  assertCondition(probeCalls >= 1, 'Expected inspect_failed_frame tool to run');
  assertCondition(result.steps.length >= 2, `Expected >= 2 steps, got ${result.steps.length}`);
  assertCondition(
    result.text.toLowerCase().includes('blue'),
    `Expected blue in reply, got: ${result.text.slice(0, 140)}`,
  );
  return { metrics: extractMetrics(result.usage), detail: 'splitErrorToolResultImages=ok' };
}

async function runReasoningRoundTripScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  let lookupCalls = 0;
  const tools = {
    lookup_secret_code: defineAgentTool({
      description: 'Look up the verification code for a topic.',
      input: z.object({ topic: z.string().min(1) }),
      execute: ({ topic }) => {
        lookupCalls += 1;
        return { topic, code: 'ORBIT-909' };
      },
    }),
  };
  const result = await completeText({
    driver: spec.driver,
    prompt:
      'Think briefly: first compute 17 * 13, then call lookup_secret_code(topic="orbit") ' +
      'to retrieve the code, and finally reply in one short sentence with both the product and exact code.',
    tools,
    maxSteps: 3,
    settings: { maxOutputTokens: spec.reasoningMaxOutputTokens },
    providerOptions: spec.reasoningProviderOptions,
    signal,
  });
  assertCondition(lookupCalls >= 1, 'Expected lookup_secret_code tool to run');
  assertCondition(result.steps.length >= 2, `Expected >= 2 steps, got ${result.steps.length}`);
  assertCondition(
    result.text.includes('ORBIT-909'),
    `Expected ORBIT-909 in final text, got: ${result.text.slice(0, 140)}`,
  );
  const artifacts = inspectReasoningArtifacts(result.steps[0], spec.provider, result.usage);
  if (spec.provider === 'openai') {
    assertCondition(
      artifacts.ok,
      `Expected step 0 OpenAI reasoning item to carry encrypted_content for stateless round-trip (${artifacts.tag})`,
    );
  }
  if (spec.provider === 'anthropic') {
    assertCondition(
      artifacts.ok,
      `Expected step 0 Anthropic thinking block to carry a signature for round-trip (${artifacts.tag})`,
    );
  }
  if (spec.provider === 'openrouter') {
    assertCondition(
      artifacts.ok,
      `Expected OpenRouter reasoning scenario to emit reasoning_details or extra_content (${artifacts.tag})`,
    );
  }
  return {
    metrics: extractMetrics(result.usage),
    detail: `steps=${result.steps.length} ${artifacts.tag}`,
  };
}

async function runPromptCacheScenario(
  spec: ModelScenarioSpec,
  signal: AbortSignal,
): Promise<ScenarioExecution> {
  const nonce = crypto.randomUUID().slice(0, 8);
  const cacheKey = `smoke-cache-${spec.family}-${nonce}`;
  const systemMessage: AgentModelSystemMessage = {
    role: 'system',
    content: buildStaticCacheHandbook(nonce),
    cacheControl: { type: 'ephemeral' },
  };
  const providerOptions = spec.cacheProviderOptions(cacheKey);
  const maxOutputTokens =
    spec.family === 'openai' ? STANDARD_MAX_OUTPUT_TOKENS : COMPACT_MAX_OUTPUT_TOKENS;
  const invoke = (section: string) =>
    completeText({
      driver: spec.driver,
      instructions: [systemMessage],
      prompt: `Using the reference handbook, reply with only the exact code for Section ${section}.`,
      settings: { maxOutputTokens },
      ...(providerOptions !== undefined && { providerOptions }),
      correlation: { conversationId: cacheKey },
      signal,
    });

  const call1 = await invoke('01');
  assertCondition(call1.text.trim().length > 0, 'Cache prime call 1 returned empty text');
  await pauseMs(500, signal);
  const call2 = await invoke('02');
  assertCondition(call2.text.trim().length > 0, 'Cache probe call 2 returned empty text');

  const m1 = extractMetrics(call1.usage);
  const m2 = extractMetrics(call2.usage);
  let hitRead = m2.cacheReadTokens;
  const allMetrics: ScenarioMetrics[] = [m1, m2];
  let hitCall = 2;

  if (hitRead === undefined || hitRead <= 0) {
    await pauseMs(1000, signal);
    const call3 = await invoke('03');
    assertCondition(
      call3.text.trim().length > 0,
      'Cache confirmation call 3 returned empty text',
    );
    const m3 = extractMetrics(call3.usage);
    allMetrics.push(m3);
    hitRead = m3.cacheReadTokens;
    hitCall = 3;
  }

  const summary = `c1_write=${String(m1.cacheWriteTokens ?? 'n/a')} c${hitCall}_read=${String(hitRead ?? 'n/a')}`;
  assertCondition(
    hitRead !== undefined && hitRead > 0,
    `Expected cacheReadTokens > 0 after priming (${summary})`,
  );
  return { metrics: mergeMetrics(allMetrics), detail: summary };
}

/** Execute scenarios 1-6 (plus Anthropic error-image split when applicable) for one model. */
export async function runModelSuite(spec: ModelScenarioSpec): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  const meta = (scenario: string) => ({
    provider: spec.provider,
    model: spec.modelId,
    scenario,
    secretKeys: spec.secretKeys,
  });
  results.push(
    await runTimedScenario(meta('1-streaming-text'), (s) => runStreamingTextScenario(spec, s)),
  );
  results.push(
    await runTimedScenario(meta('2-parallel-tools'), (s) =>
      runParallelToolLoopScenario(spec, s),
    ),
  );
  results.push(
    await runTimedScenario(meta('3-complete-object'), (s) =>
      runCompleteObjectScenario(spec, s),
    ),
  );
  results.push(
    await runTimedScenario(meta('4-multimodal-png'), (s) => runMultimodalPngScenario(spec, s)),
  );
  if (spec.isDirectAnthropic) {
    results.push(
      await runTimedScenario(meta('4b-error-tool-image'), (s) =>
        runAnthropicErrorImageToolScenario(spec, s),
      ),
    );
  }
  results.push(
    await runTimedScenario(meta('5-reasoning-roundtrip'), (s) =>
      runReasoningRoundTripScenario(spec, s),
    ),
  );
  results.push(
    await runTimedScenario(meta('6-prompt-cache-hit'), (s) => runPromptCacheScenario(spec, s)),
  );
  return results;
}
