/** What one visit said about its browser's outbox. */
export interface TrackingOutboxReport {
  /** The browser across its visits: `browserStreamId` of a visit's bootstrap. */
  readonly stream: string;
  readonly state: 'available' | 'unavailable' | 'unknown';
  readonly queued: number;
  /** Lifetime: a browser repeats it with every visit. */
  readonly dropped: number;
}

export interface TrackingTelemetryHealth {
  readonly status: 'ok' | 'degraded' | 'unknown';
  readonly observedVisits: number;
  readonly unknownVisits: number;
  readonly unavailable: number;
  /** What each browser last said it still holds. */
  readonly queued: number;
  /** Events lost inside the window. */
  readonly dropped: number;
}

/**
 * Is tracking losing events? A browser keeps `dropped` for life and sends it with
 * every visit, so a sum over visits multiplies an old loss by the number of
 * returns. A loss of this window is what each browser's counter grew by over
 * `baselines`, what it reported before the window; a browser with no earlier report
 * counts from zero, because its loss cannot be told from a new one.
 *
 * `queued` stays out of the verdict: those are a past visit's events, which the
 * next visit delivers. They become a loss only by being dropped.
 */
export function trackingTelemetryHealth(
  reports: readonly TrackingOutboxReport[],
  baselines: ReadonlyMap<string, number> = new Map(),
): TrackingTelemetryHealth {
  const latest = new Map<string, number>();
  const queued = new Map<string, number>();
  for (const report of reports) {
    queued.set(report.stream, report.queued);
    if (report.state !== 'available') continue;
    latest.set(report.stream, Math.max(latest.get(report.stream) ?? 0, report.dropped));
  }
  let dropped = 0;
  for (const [stream, reported] of latest) {
    dropped += Math.max(0, reported - (baselines.get(stream) ?? 0));
  }
  const count = (state: TrackingOutboxReport['state']): number =>
    reports.filter((report) => report.state === state).length;
  const unavailable = count('unavailable');
  const unknown = count('unknown');
  const degraded = dropped > 0 || unavailable > 0;
  return {
    status:
      reports.length === 0
        ? 'unknown'
        : degraded
          ? 'degraded'
          : unknown > 0
            ? 'unknown'
            : 'ok',
    observedVisits: reports.length - unknown,
    unknownVisits: unknown,
    unavailable,
    queued: [...queued.values()].reduce((sum, count) => sum + count, 0),
    dropped,
  };
}
