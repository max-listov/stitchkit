/**
 * Web Vitals from real visitors, for an application to store and report on.
 *
 * Nothing here runs before the page has finished loading: `web-vitals` is an
 * optional peer fetched as its own chunk once the browser is idle, so measuring a
 * page does not slow what is measured. The module imports no `zod`. A load sends
 * an `early` sample while the visitor reads and a `final` one as the page goes,
 * through `sendBeacon`, the only send a closing page does not cancel. What could
 * not be sent waits in session storage for the next page. A page has one collector
 * and one load: a call while one runs returns it, and what `web-vitals` reports
 * after a back-forward restore is not this load, so it is left out. → ADR 0280.
 */
import { sendUnloadBeacon } from '../beacon';
import { redactTrackingText } from '../privacy';
import { DEFAULT_BOT_USER_AGENT_PATTERN } from '../server/bot';
import type { PerformanceSample, PerformanceVitals } from './schema';

const DEFAULT_EARLY_DELAY_MS = 5_000;
const IDLE_TIMEOUT_MS = 2_000;
const PENDING_KEY = 'stitchkit:performance:pending';
const MAX_PENDING = 20;

const MAX_MS = 3_600_000;
const MAX_CLS = 100;
const RESTORED_NAVIGATIONS: ReadonlySet<string> = new Set(['back-forward-cache', 'restore']);

/**
 * Lab runs and crawlers have no visitor, so their numbers are not a sample of
 * anything. This reads what the agent admits to: Lighthouse with its default
 * settings imitates an ordinary browser, and only `webdriver` can catch it.
 */
const LAB_AGENT = /lighthouse|gtmetrix/i;

export function isLabUserAgent(userAgent: string): boolean {
  return LAB_AGENT.test(userAgent) || DEFAULT_BOT_USER_AGENT_PATTERN.test(userAgent);
}

/** The part of `web-vitals` this uses, so the declarations do not need the peer. */
export interface VitalsMetric {
  readonly name: string;
  readonly value: number;
  readonly navigationType?: string;
}

export type VitalsObserver = (
  report: (metric: VitalsMetric) => void,
  options?: { reportAllChanges?: boolean },
) => void;

export interface VitalsLibrary {
  onLCP: VitalsObserver;
  onINP: VitalsObserver;
  onCLS: VitalsObserver;
  onFCP: VitalsObserver;
  onTTFB: VitalsObserver;
}

/** What the collector needs from a page. */
export interface PerformanceHost {
  readonly userAgent: string;
  /** `navigator.webdriver`: a browser under automation. */
  readonly automated: boolean;
  readonly mobile: boolean;
  now(): number;
  route(): string;
  /** Runs `work` once the page has loaded and the main thread is idle. */
  afterLoad(work: () => void): void;
  /** Runs `work` every time the page may be going away. */
  onHidden(work: () => void): void;
  after(delayMs: number, work: () => void): void;
  beacon(url: string, body: string): boolean;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined;
}

export interface PerformanceCollectorConfig {
  /** The build that served the page. */
  buildId: string;
  /**
   * Where `sendBeacon` posts one sample as a JSON string, sent as `text/plain`:
   * the one type a closing page can deliver to another origin. Declare the endpoint
   * `safelistedBody: true`.
   */
  url: string;
  /** The visit this load belongs to, when the application has one. */
  visitId?: () => string | null;
  /** When the `early` sample leaves, after the library has loaded. Default 5000 ms. */
  earlyDelayMs?: number;
  /** Test seam. Default: the real page. */
  host?: PerformanceHost;
  /** Test seam. Default: `import('web-vitals')`. */
  loadVitals?: () => Promise<VitalsLibrary>;
}

export interface PerformanceCollector {
  /** Stop sending, and let a later call start again. Observers of `web-vitals` live on. */
  stop(): void;
}

const INACTIVE: PerformanceCollector = { stop: () => undefined };

/** The collector of this page. A second one would double every sample of a load. */
let running: PerformanceCollector | undefined;

/** Reading `sessionStorage` throws in a sandboxed frame, and a page must not. */
function sessionStore(): PerformanceHost['storage'] {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/** `crypto.randomUUID` exists only on a secure origin. */
function loadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function browserHost(): PerformanceHost {
  const agent = Reflect.get(navigator, 'userAgentData');
  const mobile = agent === undefined ? undefined : Reflect.get(Object(agent), 'mobile');
  return {
    userAgent: navigator.userAgent,
    automated: navigator.webdriver === true,
    mobile: typeof mobile === 'boolean' ? mobile : /Mobi|Android/i.test(navigator.userAgent),
    now: () => Date.now(),
    route: () => location.pathname,
    afterLoad(work) {
      const idle = (): void => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(work, { timeout: IDLE_TIMEOUT_MS });
        } else {
          setTimeout(work, 0);
        }
      };
      if (document.readyState === 'complete') idle();
      else addEventListener('load', idle, { once: true });
    },
    onHidden(work) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') work();
      });
      addEventListener('pagehide', work);
    },
    after: (delayMs, work) => void setTimeout(work, delayMs),
    beacon: (url, body) => sendUnloadBeacon(url, body),
    storage: sessionStore(),
  };
}

function readPending(host: PerformanceHost): string[] {
  try {
    const stored: unknown = JSON.parse(host.storage?.getItem(PENDING_KEY) ?? '[]');
    if (!Array.isArray(stored)) return [];
    return stored.filter((entry) => typeof entry === 'string');
  } catch {
    return [];
  }
}

function writePending(host: PerformanceHost, pending: readonly string[]): void {
  try {
    if (pending.length === 0) host.storage?.removeItem(PENDING_KEY);
    else host.storage?.setItem(PENDING_KEY, JSON.stringify(pending.slice(-MAX_PENDING)));
  } catch {
    // Storage full or blocked: one lost sample is what a beacon can lose anyway.
  }
}

function samePage(body: string, id: string): boolean {
  return body.includes(`"id":"${id}"`);
}

/**
 * Start collecting on this page, and only on a page: on a server, for a lab agent
 * or under automation it returns an inert collector and sends nothing.
 */
export function createPerformanceCollector(
  config: PerformanceCollectorConfig,
): PerformanceCollector {
  if (running) return running;
  if (config.host === undefined && typeof document === 'undefined') return INACTIVE;
  const host = config.host ?? browserHost();
  if (host.automated || isLabUserAgent(host.userAgent)) return INACTIVE;
  const route = redactTrackingText(host.route());
  const id = loadId();
  const vitals: PerformanceVitals = {
    lcpMs: null,
    inpMs: null,
    fcpMs: null,
    ttfbMs: null,
    cls: null,
  };
  let navigationType: string | null = null;
  let stopped = false;
  let finalSent = false;
  let lastSent: string | undefined;

  const send = (kind: PerformanceSample['kind']): void => {
    if (stopped || Object.values(vitals).every((value) => value === null)) return;
    const measured = `${kind}:${JSON.stringify(vitals)}`;
    if (measured === lastSent || (kind === 'early' && finalSent)) return;
    if (kind === 'final') finalSent = true;
    const sample: PerformanceSample = {
      schemaVersion: 1,
      id,
      kind,
      route,
      buildId: config.buildId,
      visitId: config.visitId?.() ?? null,
      deviceClass: host.mobile ? 'mobile' : 'desktop',
      navigationType,
      vitals: { ...vitals },
      capturedAt: host.now(),
    };
    const body = JSON.stringify(sample);
    lastSent = measured;
    if (host.beacon(config.url, body)) return;
    // Only the newest of a load: the older one, delivered later, would replace it.
    const others = readPending(host).filter((pending) => !samePage(pending, id));
    writePending(host, [...others, body]);
  };

  const replayPending = (): void => {
    writePending(
      host,
      readPending(host).filter((body) => !host.beacon(config.url, body)),
    );
  };

  const observe = (library: VitalsLibrary): void => {
    const record = (
      field: keyof PerformanceVitals,
      limit: number,
      metric: VitalsMetric,
    ): void => {
      if (metric.navigationType && RESTORED_NAVIGATIONS.has(metric.navigationType)) return;
      vitals[field] = Math.min(limit, Math.max(0, metric.value));
      navigationType ??= metric.navigationType ?? null;
    };
    const options = { reportAllChanges: true };
    library.onLCP((metric) => record('lcpMs', MAX_MS, metric), options);
    library.onINP((metric) => record('inpMs', MAX_MS, metric), options);
    library.onCLS((metric) => record('cls', MAX_CLS, metric), options);
    library.onFCP((metric) => record('fcpMs', MAX_MS, metric), options);
    library.onTTFB((metric) => record('ttfbMs', MAX_MS, metric), options);
  };

  host.onHidden(() => send('final'));
  host.afterLoad(() => {
    if (stopped) return;
    replayPending();
    const load = config.loadVitals ?? (() => import('web-vitals'));
    void load().then(
      (library) => {
        observe(library);
        host.after(config.earlyDelayMs ?? DEFAULT_EARLY_DELAY_MS, () => send('early'));
      },
      // A blocked or failed chunk costs the measurement, never the page.
      () => undefined,
    );
  });
  const collector: PerformanceCollector = {
    stop() {
      stopped = true;
      running = undefined;
    },
  };
  running = collector;
  return collector;
}
