/**
 * Visible time, measured additively.
 *
 * Every cut yields an interval with its own id and a duration since the last
 * checkpoint; the server sums intervals by id, so a re-delivered event does not
 * double-count and a heartbeat that never arrives loses only its own slice.
 * The server dates the interval from its own clock and the duration; the
 * client's `intervalStartedAt` is carried for the timeline, never trusted.
 */
export interface VisibleInterval {
  activeIntervalId: string;
  activeDurationMs: number;
  intervalStartedAt: number;
}

/** What a heartbeat carries: an interval while visible, only the fact while hidden. */
export type VisibleHeartbeat =
  | (VisibleInterval & { isVisible: true })
  | { isVisible: false; activeDurationMs: 0 };

export interface VisibleTimeMeter {
  /** Restart the measurement — a new page, or the tab became visible again. */
  checkpoint(): void;
  /** Close the interval since the last checkpoint and start a new one. */
  cut(): VisibleInterval;
  /** A heartbeat's view: a cut while visible; while hidden, no interval at all. */
  heartbeat(visible: boolean): VisibleHeartbeat;
}

export interface VisibleTimeMeterOptions {
  /** Monotonic clock (default `performance.now`). */
  now?: () => number;
  /** Wall clock (default `Date.now`). */
  wallClock?: () => number;
  randomUUID?: () => string;
}

export function createVisibleTimeMeter(
  options: VisibleTimeMeterOptions = {},
): VisibleTimeMeter {
  const now = options.now ?? (() => performance.now());
  const wallClock = options.wallClock ?? (() => Date.now());
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  let checkpointAt = now();
  const cut = (): VisibleInterval => {
    const at = now();
    const activeDurationMs = Math.max(0, Math.round(at - checkpointAt));
    checkpointAt = at;
    return {
      activeIntervalId: randomUUID(),
      activeDurationMs,
      intervalStartedAt: wallClock() - activeDurationMs,
    };
  };
  return {
    checkpoint() {
      checkpointAt = now();
    },
    cut,
    heartbeat(visible) {
      if (visible) return { ...cut(), isVisible: true };
      return { isVisible: false, activeDurationMs: 0 };
    },
  };
}
