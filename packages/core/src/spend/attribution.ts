import { AsyncLocalStorage } from 'node:async_hooks';
import { isRecord, withoutUndefined } from '../internal/typed';
import { type SpendAttribution, SpendAttributionSchema } from './schemas';

const current = new AsyncLocalStorage<SpendAttribution>();

function mergeLabels(
  base: SpendAttribution['labels'],
  override: SpendAttribution['labels'],
): SpendAttribution['labels'] {
  if (base === undefined && override === undefined) return undefined;
  if (override !== undefined && !isRecord(override)) return override;
  if (base !== undefined && !isRecord(base)) return base;
  const merged: Record<string, string> = {};
  for (const source of [base, override]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined) merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Internal attribution merge shared by `runWithSpendAttribution` and `createSpendGateway`:
 * strips `undefined` keys on both sides (and on their `labels`) before spreading, merges
 * `labels`, omits `labels` when both sides are absent or empty, and leaves schema validation
 * to the caller.
 */
export function mergeSpendAttribution(
  base?: Partial<SpendAttribution>,
  override?: Partial<SpendAttribution>,
): Partial<SpendAttribution> {
  const cleanBase = base ? withoutUndefined(base) : {};
  const cleanOverride = override ? withoutUndefined(override) : {};
  const { labels: baseLabels, ...baseFields } = cleanBase;
  const { labels: overrideLabels, ...overrideFields } = cleanOverride;
  const labels = mergeLabels(baseLabels, overrideLabels);
  return {
    ...baseFields,
    ...overrideFields,
    ...(labels !== undefined && { labels }),
  };
}

/**
 * Run `work` with this attribution on every model call it makes through a spend
 * gateway. Nested calls refine the outer one: a field set inside wins, `labels`
 * are merged.
 */
export function runWithSpendAttribution<T>(attribution: SpendAttribution, work: () => T): T {
  const outer = current.getStore();
  const inner = SpendAttributionSchema.parse(attribution);
  const merged = SpendAttributionSchema.parse(mergeSpendAttribution(outer, inner));
  return current.run(merged, work);
}

/** The attribution `runWithSpendAttribution` set for this call chain, if any. */
export function getSpendAttribution(): SpendAttribution | undefined {
  return current.getStore();
}
