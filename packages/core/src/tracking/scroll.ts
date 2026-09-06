/**
 * Scroll depth as a percentage of the scrollable range — 0 at the top, 100 at
 * the bottom, 0 for a page shorter than its viewport (nothing to scroll).
 */
export function scrollDepthPercent(view: {
  scrollHeight: number;
  innerHeight: number;
  scrollY: number;
}): number {
  const scrollable = view.scrollHeight - view.innerHeight;
  if (scrollable <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((view.scrollY / scrollable) * 100)));
}

export interface ScrollMilestones {
  /** Record a depth without firing — the scroll listener's job. */
  record(percent: number): void;
  /** Record a depth and return the milestones newly reached, ascending. */
  observe(percent: number): number[];
  /** The deepest point seen since the last reset. */
  max(): number;
  /** A new page. */
  reset(): void;
}

/** Milestones fire once each per page, in order, from the deepest point seen. */
export function createScrollMilestones(
  milestones: readonly number[] = [25, 50, 75, 100],
): ScrollMilestones {
  const sorted = [...milestones].sort((a, b) => a - b);
  let deepest = 0;
  const fired = new Set<number>();
  return {
    record(percent) {
      deepest = Math.max(deepest, percent);
    },
    observe(percent) {
      deepest = Math.max(deepest, percent);
      const reached: number[] = [];
      for (const milestone of sorted) {
        if (deepest >= milestone && !fired.has(milestone)) {
          fired.add(milestone);
          reached.push(milestone);
        }
      }
      return reached;
    },
    max: () => deepest,
    reset() {
      deepest = 0;
      fired.clear();
    },
  };
}
