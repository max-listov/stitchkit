/**
 * The server's knowledge of which frontend build is current.
 *
 * `read` is the application's: a file the release wrote (`.next/BUILD_ID` of
 * the *active* release root, not the process's own cwd — a frontend-only
 * release leaves the backend in an older immutable root), an environment
 * variable, anything. It returns `null` where there is no release — a dev
 * server under HMR — and then the marker stays silent: no header, no event.
 *
 * `refresh()` is the one operation with a side effect: it re-reads, and if
 * the answer changed, tells every subscriber. A deploy signal calls it; so
 * does every socket connection, so a broadcast the process missed while it
 * was down is repaired by the next client that connects. → ADR 0167.
 */
export interface ReleaseMarker {
  /** The last build id read, or `null` when there is no release to name. */
  current(): string | null;
  /** Re-read; `changed` when the id differs from the last one seen. */
  refresh(): ReleaseRefresh;
  /** Hear every change; returns the unsubscribe. */
  subscribe(listener: (buildId: string | null) => void): () => void;
}

export interface ReleaseRefresh {
  changed: boolean;
  buildId: string | null;
}

export interface ReleaseMarkerConfig {
  /** The current build id, or `null` when there is none. A throw counts as `null`. */
  read: () => string | null;
  /**
   * Hear a `read` that threw or returned something that is not a build id, and
   * a subscriber that threw — the marker itself never does, because it is
   * called from a signal handler and a socket's `connection` event, where an
   * escaped exception ends the process or the connect.
   */
  onError?: (error: unknown) => void;
}

/**
 * A build id travels as a header value: printable ASCII, no whitespace, and a
 * length no release id needs. A file with two lines or a JSON blob is not a
 * build id, and silently sending nothing for it would hide a misconfigured
 * `read` behind a header that simply never appears.
 */
const BUILD_ID = /^[!-~]{1,200}$/;

export function createReleaseMarker(config: ReleaseMarkerConfig): ReleaseMarker {
  const listeners = new Set<(buildId: string | null) => void>();
  const report = (error: unknown): void => {
    try {
      config.onError?.(error);
    } catch {
      // An error reporter that throws has nowhere further to report.
    }
  };
  const read = (): string | null => {
    let value: string | null;
    try {
      value = config.read();
    } catch (error) {
      report(error);
      return null;
    }
    if (value === null || value === undefined) return null;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    // Nothing is "no release"; something that is not an id is a mistake.
    if (trimmed === '') return null;
    if (!BUILD_ID.test(trimmed)) {
      report(
        new Error(`release marker: not a build id: ${JSON.stringify(value).slice(0, 80)}`),
      );
      return null;
    }
    return trimmed;
  };
  let current = read();
  return {
    current: () => current,
    refresh() {
      const next = read();
      // A read that failed is not a release: the last known id stands, so a
      // half-written build does not tell every tab to reload onto nothing.
      if (next === null) return { changed: false, buildId: current };
      if (next === current) return { changed: false, buildId: current };
      current = next;
      for (const listener of listeners) {
        try {
          listener(next);
        } catch (error) {
          report(error);
        }
      }
      return { changed: true, buildId: next };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
