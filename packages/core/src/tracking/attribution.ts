import { isRecord } from '../internal/typed';
import type { AttributionData, UtmData } from './schemas';

/** A referrer hostname pattern and the source/medium it stands for. */
export interface ReferrerRule {
  pattern: RegExp;
  source: string;
  medium: string;
}

export interface AttributionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ResolveAttributionInput {
  /** `location.search`, with the leading `?`. */
  search: string;
  /** `document.referrer`. */
  referrer: string;
  /** `location.pathname`. */
  pathname: string;
  /** `location.hostname` — a referrer from the same host is not a referrer. */
  hostname: string;
  storage: AttributionStorage;
  /**
   * Which referrer hosts map to a named source and medium. The framework has
   * no built-in list: which hosts count as "social" or "organic" is the
   * application's data (ADR 0002). An unmatched external referrer is
   * `{ source: hostname, medium: 'referral' }`.
   */
  referrerMap?: readonly ReferrerRule[];
  /** Storage key. Default `tracking.attribution`. */
  storageKey?: string;
  /** How long first-touch lives. Default 90 days. */
  ttlMs?: number;
  now?: number;
}

export interface ResolvedAttribution {
  firstTouch: AttributionData;
  currentTouch: AttributionData;
}

interface StoredTouch {
  data: AttributionData;
  capturedAt: number;
}

interface StoredAttribution {
  firstTouch: StoredTouch;
  currentTouch: StoredTouch;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** The wire limit of a campaign tag: a longer stored one would be refused at bootstrap. */
const MAX_UTM_LENGTH = 200;

function isUtmField(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_UTM_LENGTH);
}

function isUtm(value: unknown): boolean {
  if (value === undefined) return true;
  return (
    isRecord(value) &&
    ['source', 'medium', 'campaign', 'content', 'term'].every((field) =>
      isUtmField(value[field]),
    )
  );
}

function isStoredTouch(value: unknown): value is StoredTouch {
  if (!isRecord(value) || !Number.isFinite(value.capturedAt)) return false;
  const { data } = value;
  return (
    isRecord(data) &&
    isUtm(data.utm) &&
    isOptionalText(data.referrer) &&
    isOptionalText(data.landingPage)
  );
}

/**
 * A guard rather than a schema: this module runs on every page of a storefront,
 * and `zod` would be nine tenths of the client's weight for one read.
 */
function isStoredAttribution(value: unknown): value is StoredAttribution {
  return (
    isRecord(value) && isStoredTouch(value.firstTouch) && isStoredTouch(value.currentTouch)
  );
}

function normalize(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value.toLowerCase().trim().slice(0, 200) || undefined;
}

export function parseUtmFromSearch(search: string): UtmData | null {
  const params = new URLSearchParams(search);
  const source = normalize(params.get('utm_source'));
  if (!source) return null;
  return {
    source,
    medium: normalize(params.get('utm_medium')),
    campaign: normalize(params.get('utm_campaign')),
    content: normalize(params.get('utm_content')),
    term: normalize(params.get('utm_term')),
  };
}

export function parseReferrer(
  referrer: string,
  currentHostname: string,
  referrerMap: readonly ReferrerRule[] = [],
): { source: string; medium: string } | null {
  if (!referrer) return null;
  try {
    const hostname = new URL(referrer).hostname.toLowerCase();
    if (hostname === currentHostname.toLowerCase()) return null;
    const match = referrerMap.find((rule) => rule.pattern.test(hostname));
    return match
      ? { source: match.source, medium: match.medium }
      : { source: hostname, medium: 'referral' };
  } catch {
    return null;
  }
}

function readStored(
  storage: AttributionStorage,
  key: string,
  now: number,
  ttlMs: number,
): StoredAttribution | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredAttribution(parsed) || now - parsed.firstTouch.capturedAt > ttlMs) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(
  storage: AttributionStorage,
  key: string,
  value: StoredAttribution,
): void {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or forbidden: attribution for this visit is still returned,
    // it just does not survive the page.
  }
}

/**
 * First-touch is written once and lives `ttlMs`; a new UTM in the address
 * changes only current-touch. Without UTM or an external referrer the entry
 * is direct, and that is recorded too.
 */
export function resolveAttribution({
  search,
  referrer,
  pathname,
  hostname,
  storage,
  referrerMap = [],
  storageKey = 'tracking.attribution',
  ttlMs = 90 * 24 * 60 * 60 * 1000,
  now = Date.now(),
}: ResolveAttributionInput): ResolvedAttribution {
  const stored = readStored(storage, storageKey, now, ttlMs);
  const urlUtm = parseUtmFromSearch(search);

  if (urlUtm) {
    const currentTouch: AttributionData = {
      utm: urlUtm,
      referrer: referrer || undefined,
      landingPage: pathname,
    };
    const persisted: StoredAttribution = {
      firstTouch: {
        data: stored?.firstTouch.data ?? currentTouch,
        capturedAt: stored?.firstTouch.capturedAt ?? now,
      },
      currentTouch: { data: currentTouch, capturedAt: now },
    };
    writeStored(storage, storageKey, persisted);
    return {
      firstTouch: persisted.firstTouch.data,
      currentTouch: persisted.currentTouch.data,
    };
  }

  if (stored)
    return { firstTouch: stored.firstTouch.data, currentTouch: stored.currentTouch.data };

  const fromReferrer = parseReferrer(referrer, hostname, referrerMap);
  const firstTouch: AttributionData = {
    utm: fromReferrer
      ? { source: fromReferrer.source, medium: fromReferrer.medium }
      : undefined,
    referrer: referrer || undefined,
    landingPage: pathname,
  };
  writeStored(storage, storageKey, {
    firstTouch: { data: firstTouch, capturedAt: now },
    currentTouch: { data: firstTouch, capturedAt: now },
  });
  return { firstTouch, currentTouch: firstTouch };
}
