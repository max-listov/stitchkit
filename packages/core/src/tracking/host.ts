import type { AttributionStorage } from './attribution';
import type { ClickTarget } from './clicks';

/** What the client reads about the current page. */
export interface TrackingPageContext {
  pathname: string;
  /** With the leading `?`, or empty. */
  search: string;
  origin: string;
  hostname: string;
  title: string;
  referrer: string;
  viewportWidth: number;
  viewportHeight: number;
  screenWidth: number;
  screenHeight: number;
  displayMode: 'browser' | 'standalone';
}

/**
 * Everything the tracking client takes from a browser, behind one interface,
 * so the client is a plain object that can be driven by a test without a
 * DOM — and so a host that is not a browser tab (a WebView, a worker) can
 * supply its own. `browserTrackingHost()` is the tab.
 */
export interface TrackingHost {
  page(): TrackingPageContext;
  visible(): boolean;
  /** Current scroll depth, 0–100. */
  scrollDepth(): number;
  /** Subscribe; returns the unsubscribe. */
  on(
    event: 'pagehide' | 'visibilitychange' | 'online' | 'scroll',
    handler: () => void,
  ): () => void;
  /** Clicks, capture phase — a link navigates before bubbling reaches it. */
  onClick(handler: (target: ClickTarget | null) => void): () => void;
  interval(handler: () => void, ms: number): () => void;
  /** Monotonic clock, ms. */
  now(): number;
  wallClock(): number;
  randomUUID(): string;
  /** Where attribution persists; `null` when there is none. */
  storage: AttributionStorage | null;
}

/** The host a browser tab provides. Reads `window` and `document` lazily, never at import. */
export function browserTrackingHost(): TrackingHost {
  return {
    page: () => ({
      pathname: window.location.pathname,
      search: window.location.search,
      origin: window.location.origin,
      hostname: window.location.hostname,
      title: document.title,
      referrer: document.referrer,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: window.screen.width,
      screenHeight: window.screen.height,
      displayMode: window.matchMedia('(display-mode: standalone)').matches
        ? 'standalone'
        : 'browser',
    }),
    visible: () => document.visibilityState === 'visible',
    scrollDepth() {
      const scrollable = document.documentElement.scrollHeight - window.innerHeight;
      if (scrollable <= 0) return 0;
      return Math.max(0, Math.min(100, Math.round((window.scrollY / scrollable) * 100)));
    },
    on(event, handler) {
      const target: EventTarget = event === 'visibilitychange' ? document : window;
      const options = event === 'scroll' ? { passive: true } : undefined;
      target.addEventListener(event, handler, options);
      return () => target.removeEventListener(event, handler);
    },
    onClick(handler) {
      const listener = (event: MouseEvent) => {
        handler(event.target instanceof Element ? event.target : null);
      };
      document.addEventListener('click', listener, { capture: true });
      return () => document.removeEventListener('click', listener, { capture: true });
    },
    interval(handler, ms) {
      const id = window.setInterval(handler, ms);
      return () => window.clearInterval(id);
    },
    now: () => performance.now(),
    wallClock: () => Date.now(),
    randomUUID: () => crypto.randomUUID(),
    storage: (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })(),
  };
}
