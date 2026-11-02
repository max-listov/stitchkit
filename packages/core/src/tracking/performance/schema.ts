import { z } from 'zod';

const BoundedMsSchema = z.number().nonnegative().max(3_600_000).nullable();

/**
 * The five Web Vitals of one page load. A metric that did not arrive is `null`,
 * never zero: a zero LCP would pull an average down with a page that never
 * painted, and nothing downstream could tell them apart.
 */
export const PerformanceVitalsSchema = z.object({
  lcpMs: BoundedMsSchema,
  inpMs: BoundedMsSchema,
  fcpMs: BoundedMsSchema,
  ttfbMs: BoundedMsSchema,
  cls: z.number().nonnegative().max(100).nullable(),
});
export type PerformanceVitals = z.infer<typeof PerformanceVitalsSchema>;

/**
 * One page load as measured in a real browser. `id` is the same for every sample
 * of that load: `early` arrives while the visitor reads, `final` as the page goes,
 * and the later one replaces the earlier in an application's table.
 */
export const PerformanceSampleSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(64),
  kind: z.enum(['early', 'final']),
  route: z.string().min(1).max(2_000),
  buildId: z.string().min(1).max(64),
  /** Ties a load to its visit for coverage: how many visits measured anything. */
  visitId: z.string().min(1).max(128).nullable(),
  deviceClass: z.enum(['mobile', 'desktop']),
  navigationType: z.string().min(1).max(32).nullable(),
  vitals: PerformanceVitalsSchema,
  capturedAt: z.number().int().nonnegative(),
});
export type PerformanceSample = z.infer<typeof PerformanceSampleSchema>;
