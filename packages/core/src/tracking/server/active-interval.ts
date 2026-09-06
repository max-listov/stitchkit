const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ActiveTimeInterval {
  intervalId: string;
  page: string;
  deltaMs: number;
  startedAt: Date;
  endedAt: Date;
}

export interface ActiveIntervalOptions {
  /** Longest interval a client may claim. Default 30 minutes. */
  maxMs?: number;
  /** The event types that carry an interval. Default `PAGE_LEAVE` and `SESSION_HEARTBEAT`. */
  types?: readonly string[];
}

/**
 * The visible-time interval an event carries, dated by the **server**: the
 * client reports only a duration, its `intervalStartedAt` is carried for the
 * timeline and never used — a client's clock is not admitted to the record.
 * `null` when the event has no interval, an unshaped one, or one longer than
 * a tab could plausibly have been visible.
 */
export function activeIntervalOf(
  event: { type: string; page: string; metadata?: Record<string, unknown> | undefined },
  serverNow: Date,
  {
    maxMs = 30 * 60 * 1000,
    types = ['PAGE_LEAVE', 'SESSION_HEARTBEAT'],
  }: ActiveIntervalOptions = {},
): ActiveTimeInterval | null {
  if (!types.includes(event.type) || !event.metadata) return null;
  const intervalId = event.metadata.activeIntervalId;
  const deltaMs = event.metadata.activeDurationMs;
  if (typeof intervalId !== 'string' || !UUID.test(intervalId)) return null;
  if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs)) return null;
  // Rounded before the bound: 0.4 ms is a zero-length interval, not a short one.
  const rounded = Math.round(deltaMs);
  if (rounded <= 0 || rounded > maxMs) return null;
  return {
    intervalId,
    page: event.page,
    deltaMs: rounded,
    startedAt: new Date(serverNow.getTime() - rounded),
    endedAt: serverNow,
  };
}
