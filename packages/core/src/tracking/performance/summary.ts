/** Below this many samples a tail percentile describes a few visitors, not the page. */
const DEFAULT_MIN_SAMPLES = 100;

export interface PerformanceMetricSummary {
  /** Samples that carried the metric. A `null` is a missing value, not a fast one. */
  readonly samples: number;
  readonly p75: number | null;
  /** `null` below `minSamples`, so a thin route shows no number rather than a wrong one. */
  readonly p95: number | null;
}

/** The nearest-rank percentile of ascending values. */
function percentile(ascending: readonly number[], rank: number): number | null {
  return ascending[Math.ceil(ascending.length * rank) - 1] ?? null;
}

/** The figures a report may print for one metric of many samples. */
export function summarizePerformanceMetric(
  values: readonly (number | null)[],
  options: { readonly minSamples?: number } = {},
): PerformanceMetricSummary {
  const present = values.filter((value) => value !== null).sort((left, right) => left - right);
  const trusted = present.length >= (options.minSamples ?? DEFAULT_MIN_SAMPLES);
  return {
    samples: present.length,
    p75: percentile(present, 0.75),
    p95: trusted ? percentile(present, 0.95) : null,
  };
}
