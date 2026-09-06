/**
 * Who is on the site right now. A process-local snapshot, not history: it is
 * honestly empty after a restart until the first heartbeat, and a second
 * process has its own.
 */
export interface PresenceEntry<
  TExtra extends Record<string, unknown> = Record<string, unknown>,
> {
  browserStreamId: string;
  visitId: string | null;
  ownerId: string | null;
  page: string;
  extra: TExtra;
}

export interface PresenceRegistry<TExtra extends Record<string, unknown>> {
  touch(entry: PresenceEntry<TExtra>): void;
  /** Everyone seen within the TTL, optionally filtered — a tenant, an area. */
  snapshot(
    filter?: (entry: PresenceEntry<TExtra>) => boolean,
  ): Array<PresenceEntry<TExtra> & { lastSeen: Date }>;
  /** The most recently seen visit of one owner — for server-side events with no browser request. */
  presentVisitOf(ownerId: string): string | null;
  clear(): void;
}

export function createPresenceRegistry<TExtra extends Record<string, unknown>>(
  options: { ttlMs?: number; now?: () => number } = {},
): PresenceRegistry<TExtra> {
  // Heartbeats come every 30 s; 45 s of silence is a departure.
  const ttlMs = options.ttlMs ?? 45_000;
  const now = options.now ?? (() => Date.now());
  const active = new Map<string, PresenceEntry<TExtra> & { lastSeen: number }>();
  const sweep = () => {
    const at = now();
    for (const [key, entry] of active) {
      if (at - entry.lastSeen > ttlMs) active.delete(key);
    }
  };
  return {
    touch(entry) {
      active.set(entry.browserStreamId, { ...entry, lastSeen: now() });
    },
    snapshot(filter = () => true) {
      sweep();
      return [...active.values()]
        .filter(filter)
        .map((entry) => ({ ...entry, lastSeen: new Date(entry.lastSeen) }));
    },
    presentVisitOf(ownerId) {
      sweep();
      let best: (PresenceEntry<TExtra> & { lastSeen: number }) | null = null;
      for (const entry of active.values()) {
        if (entry.ownerId !== ownerId) continue;
        if (!best || entry.lastSeen > best.lastSeen) best = entry;
      }
      return best?.visitId ?? null;
    },
    clear: () => active.clear(),
  };
}
