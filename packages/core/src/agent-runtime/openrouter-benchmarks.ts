import { z } from 'zod';
import type { AgentModelCapability, AgentModelMetric } from './models';
import type { OpenRouterModelSchema } from './openrouter-models';

const OpenRouterBenchmarkMetaSchema = z
  .object({ as_of: z.iso.datetime({ offset: true }) })
  .loose();

const OpenRouterArtificialAnalysisRowSchema = z
  .object({
    source: z.literal('artificial-analysis'),
    model_permaslug: z.string().min(1),
    intelligence_index: z.number().nullish(),
    coding_index: z.number().nullish(),
    agentic_index: z.number().nullish(),
  })
  .loose();

const OpenRouterDesignArenaRowSchema = z
  .object({
    source: z.literal('design-arena'),
    model_permaslug: z.string().min(1),
    arena: z.string().min(1),
    category: z.string().min(1).optional(),
    elo: z.number().nullish(),
    win_rate: z.number().nullish(),
    avg_generation_time_ms: z.number().nullish(),
  })
  .loose();

const OpenRouterArtificialAnalysisResponseSchema = z.object({
  data: z.array(OpenRouterArtificialAnalysisRowSchema),
  meta: OpenRouterBenchmarkMetaSchema,
});

const OpenRouterDesignArenaResponseSchema = z.object({
  data: z.array(OpenRouterDesignArenaRowSchema),
  meta: OpenRouterBenchmarkMetaSchema,
});

export type OpenRouterBenchmarkFetchOutcome =
  | { readonly outcome: 'ok'; readonly value: unknown }
  | { readonly outcome: 'error'; readonly error: unknown };

export function openRouterCapabilities(
  model: z.infer<typeof OpenRouterModelSchema>,
): AgentModelCapability[] {
  const values: AgentModelCapability[] = ['tools'];
  if (model.architecture.input_modalities.includes('image')) values.push('vision');
  if (model.architecture.input_modalities.includes('file')) values.push('files');
  if (
    model.supported_parameters.includes('reasoning') ||
    model.supported_parameters.includes('include_reasoning')
  ) {
    values.push('reasoning');
  }
  return values;
}

function artificialMetrics(
  row: z.infer<typeof OpenRouterArtificialAnalysisRowSchema>,
  observedAt: string,
): AgentModelMetric[] {
  return [
    ['intelligence', row.intelligence_index],
    ['coding', row.coding_index],
    ['agentic', row.agentic_index],
  ].flatMap(([metric, value]) =>
    typeof metric === 'string' && typeof value === 'number'
      ? [
          {
            metric,
            value,
            unit: 'index',
            source: row.source,
            observedAt,
          } satisfies AgentModelMetric,
        ]
      : [],
  );
}

function designMetrics(
  row: z.infer<typeof OpenRouterDesignArenaRowSchema>,
  observedAt: string,
): AgentModelMetric[] {
  const suffix = `${row.arena}${row.category ? `:${row.category}` : ''}`;
  const metrics: AgentModelMetric[] = [];
  if (typeof row.elo === 'number') {
    metrics.push({
      metric: `design-arena:${suffix}:elo`,
      value: row.elo,
      unit: 'elo',
      source: row.source,
      observedAt,
    });
  }
  if (typeof row.win_rate === 'number') {
    metrics.push({
      metric: `design-arena:${suffix}:win-rate`,
      value: row.win_rate,
      unit: 'percent',
      source: row.source,
      observedAt,
    });
  }
  if (typeof row.avg_generation_time_ms === 'number') {
    metrics.push({
      metric: `design-arena:${suffix}:generation-time`,
      value: row.avg_generation_time_ms,
      unit: 'milliseconds',
      source: row.source,
      observedAt,
    });
  }
  return metrics;
}

/** Parse optional benchmark side-feeds into per-model metrics and partial-completeness diagnostics. */
export function collectOpenRouterBenchmarks(
  artificialResult: OpenRouterBenchmarkFetchOutcome,
  designResult: OpenRouterBenchmarkFetchOutcome,
): { readonly metrics: Map<string, AgentModelMetric[]>; readonly diagnostics: string[] } {
  const metrics = new Map<string, AgentModelMetric[]>();
  const diagnostics: string[] = [];

  if (artificialResult.outcome === 'ok') {
    const parsed = OpenRouterArtificialAnalysisResponseSchema.safeParse(
      artificialResult.value,
    );
    if (parsed.success) {
      for (const row of parsed.data.data) {
        metrics.set(row.model_permaslug, artificialMetrics(row, parsed.data.meta.as_of));
      }
    } else {
      diagnostics.push('Artificial Analysis benchmark data is malformed');
    }
  } else {
    diagnostics.push('Artificial Analysis benchmark data is unavailable');
  }

  if (designResult.outcome === 'ok') {
    const parsed = OpenRouterDesignArenaResponseSchema.safeParse(designResult.value);
    if (parsed.success) {
      for (const row of parsed.data.data) {
        metrics.set(row.model_permaslug, [
          ...(metrics.get(row.model_permaslug) ?? []),
          ...designMetrics(row, parsed.data.meta.as_of),
        ]);
      }
    } else {
      diagnostics.push('Design Arena benchmark data is malformed');
    }
  } else {
    diagnostics.push('Design Arena benchmark data is unavailable');
  }

  return { metrics, diagnostics };
}
