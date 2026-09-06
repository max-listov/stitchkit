/**
 * The browser's side: is the page still the build the server is serving?
 *
 * `observe(buildId)` compares what the server said to the id this bundle was
 * built with — its **own** id, not the first one it happened to hear. That
 * difference is the whole reason this exists: a tab that loaded a cached
 * bundle after a release and then heard the new id would, under "first seen
 * wins", adopt it as its own and never reload.
 *
 * Once stale, the watcher applies a policy. `immediate` is what a chat app
 * wants and what a form-heavy app does not: `when-hidden` reloads when the
 * tab is next hidden, `on-navigation` when the app next reports a route
 * change, and both give up waiting after `maxDeferMs`.
 *
 * One reload per id. The id a reload was attempted for is remembered across
 * that reload (session storage in a tab); if the page comes back and the
 * server still names it, the server is wrong about what it serves — a marker
 * reading the wrong root, a cached response — and reloading again would be
 * a loop with a policy as its excuse. The page stays, `stale()` is true, and
 * `onStale` has said so. → ADR 0167.
 */
export type ReleaseReloadPolicy = 'immediate' | 'when-hidden' | 'on-navigation';

/** What the watcher takes from a browser tab; a test supplies its own. */
export interface ReleaseWatcherHost {
  hidden(): boolean;
  /** Subscribe to visibility changes; returns the unsubscribe. */
  onVisibilityChange(handler: () => void): () => void;
  setTimeout(handler: () => void, ms: number): () => void;
  reload(): void;
  /** Keep the id a reload was attempted for, across that reload. */
  remember(buildId: string): void;
  /** The id the last reload was attempted for, if the tab still knows. */
  recall(): string | null;
}

export interface ReleaseWatcherConfig {
  /** The build id this bundle was built with — `NEXT_PUBLIC_BUILD_ID`, a git SHA. */
  own: string;
  /** Default `when-hidden`. */
  policy?: ReleaseReloadPolicy;
  /** Longest a deferred reload waits for its moment. Default 15 minutes. */
  maxDeferMs?: number;
  /**
   * Own ids that mean "not a release build" — the watcher never reloads for
   * them, so a dev bundle talking to a production API is not sent in a loop.
   * An empty or missing `own` is treated the same way. Default `['dev']`.
   */
  ignore?: readonly string[];
  host?: ReleaseWatcherHost;
  /** Hear the moment the page becomes stale — to show "a new version is ready" yourself. */
  onStale?: (buildId: string) => void;
}

export interface ReleaseWatcher {
  /** What the server said; `null` (no release) is ignored. */
  observe(buildId: string | null | undefined): void;
  /** The app changed route — the `on-navigation` policy's moment. */
  navigated(): void;
  stale(): boolean;
  dispose(): void;
}

const REMEMBER_KEY = 'stitchkit.release.reloaded-for';

/**
 * The tab. Every read of `document` / `window` is guarded, so the watcher can
 * be constructed during server-side rendering and simply never reload there.
 */
export function browserReleaseHost(): ReleaseWatcherHost {
  const doc = typeof document === 'undefined' ? null : document;
  const win = typeof window === 'undefined' ? null : window;
  return {
    hidden: () => doc?.visibilityState === 'hidden',
    onVisibilityChange(handler) {
      if (!doc) return () => undefined;
      doc.addEventListener('visibilitychange', handler);
      return () => doc.removeEventListener('visibilitychange', handler);
    },
    setTimeout(handler, ms) {
      const id = globalThis.setTimeout(handler, ms);
      return () => globalThis.clearTimeout(id);
    },
    reload: () => win?.location.reload(),
    remember(buildId) {
      try {
        win?.sessionStorage.setItem(REMEMBER_KEY, buildId);
      } catch {
        // Storage refused: the loop breaker is then per page load only.
      }
    },
    recall() {
      try {
        return win?.sessionStorage.getItem(REMEMBER_KEY) ?? null;
      } catch {
        return null;
      }
    },
  };
}

export function createReleaseWatcher(config: ReleaseWatcherConfig): ReleaseWatcher {
  const policy = config.policy ?? 'when-hidden';
  const maxDeferMs = config.maxDeferMs ?? 15 * 60 * 1000;
  const ignore = new Set(config.ignore ?? ['dev']);
  const host = config.host ?? browserReleaseHost();
  let stale = false;
  let done = false;
  let target: string | null = null;
  const cleanups: Array<() => void> = [];

  const reload = (): void => {
    if (done) return;
    done = true;
    for (const off of cleanups.splice(0)) off();
    if (target !== null) host.remember(target);
    host.reload();
  };

  const notify = (buildId: string): void => {
    try {
      config.onStale?.(buildId);
    } catch {
      // A listener's failure is not the page's.
    }
  };

  return {
    observe(buildId) {
      if (stale || done) return;
      if (buildId === null || buildId === undefined || buildId === '') return;
      if (!config.own || ignore.has(config.own)) return;
      if (buildId === config.own) return;
      stale = true;
      target = buildId;
      // Already reloaded for this very id and still not it: the server is
      // naming a build this page cannot become. Say so, do not loop.
      if (host.recall() === buildId) {
        notify(buildId);
        return;
      }
      if (policy === 'immediate') {
        reload();
        notify(buildId);
        return;
      }
      if (policy === 'when-hidden') {
        if (host.hidden()) {
          reload();
          notify(buildId);
          return;
        }
        cleanups.push(
          host.onVisibilityChange(() => {
            if (host.hidden()) reload();
          }),
        );
      }
      cleanups.push(host.setTimeout(reload, maxDeferMs));
      notify(buildId);
    },
    navigated() {
      if (stale && policy === 'on-navigation') reload();
    },
    stale: () => stale,
    dispose() {
      done = true;
      for (const off of cleanups.splice(0)) off();
    },
  };
}
