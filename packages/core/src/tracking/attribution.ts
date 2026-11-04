import { isRecord } from '../internal/typed';
import { maskTrackingParameters, redactTrackingText } from './privacy';
import type { AttributionData, UtmData } from './schemas';

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
  storage: AttributionStorage | null;
  clickIdParams?: readonly string[];
  /** Storage key. Default `tracking.attribution`. */
  storageKey?: string;
  /** How long first-touch lives. Default 90 days. */
  ttlMs?: number;
  now?: number;
}

export interface ResolvedAttribution {
  firstTouch: AttributionData;
  /** This page's touch: its landing path is always known. */
  currentTouch: AttributionData & { landingPage: string };
}

interface StoredTouch {
  data: AttributionData;
  capturedAt: number;
}

interface StoredAttribution {
  version: 1;
  firstTouch: StoredTouch;
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
    (data.clickId === undefined ||
      (typeof data.clickId === 'string' &&
        data.clickId.length > 0 &&
        data.clickId.length <= MAX_UTM_LENGTH)) &&
    isOptionalText(data.referrer) &&
    isOptionalText(data.landingPage)
  );
}

/**
 * A guard rather than a schema: this module runs on every page of a storefront,
 * and `zod` would be nine tenths of the client's weight for one read.
 */
function isStoredAttribution(value: unknown): value is StoredAttribution {
  return isRecord(value) && value.version === 1 && isStoredTouch(value.firstTouch);
}

function campaignValue(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  return redactTrackingText(value).slice(0, MAX_UTM_LENGTH);
}

export function parseUtmFromSearch(search: string): UtmData | null {
  const params = new URLSearchParams(search);
  const source = campaignValue(params.get('utm_source'));
  const utm = {
    source,
    medium: campaignValue(params.get('utm_medium')),
    campaign: campaignValue(params.get('utm_campaign')),
    content: campaignValue(params.get('utm_content')),
    term: campaignValue(params.get('utm_term')),
  };
  return Object.values(utm).some((value) => value !== undefined) ? utm : null;
}

/** Refuse a click-marker list no request could carry; a client checks it once, at creation. */
export function assertClickIdParams(names: readonly string[]): void {
  for (const name of names) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_UTM_LENGTH) {
      throw new TypeError('clickIdParams names must contain 1–200 characters');
    }
  }
}

/**
 * A referrer as tracking keeps it: credentials masked, and the value of every
 * configured click marker masked too — a referrer from the same site carries the
 * landing query, click identifier included, in full.
 */
export function trackedReferrer(referrer: string, clickIdParams: readonly string[]): string {
  return maskTrackingParameters(redactTrackingText(referrer), new Set(clickIdParams));
}

function clickIdFromSearch(search: string, names: readonly string[]): string | undefined {
  const params = new URLSearchParams(search);
  return names.find((name) => params.getAll(name).some((value) => value.length > 0));
}

/** Within the TTL; a capture time ahead of the clock cannot be aged and is not fresh. */
function isFresh(capturedAt: number, now: number, ttlMs: number): boolean {
  const age = now - capturedAt;
  return age >= 0 && age <= ttlMs;
}

function readStored(
  storage: AttributionStorage | null,
  key: string,
  now: number,
  ttlMs: number,
): StoredAttribution | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredAttribution(parsed) || !isFresh(parsed.firstTouch.capturedAt, now, ttlMs)) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStored(
  storage: AttributionStorage | null,
  key: string,
  value: StoredAttribution,
): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or forbidden: attribution for this visit is still returned,
    // it just does not survive the page.
  }
}

/**
 * First-touch is written once and lives `ttlMs`; current-touch carries only
 * this page's UTM, referrer and configured click marker. Channel classification
 * and retaining a last non-direct channel belong to the application.
 *
 * Both touches leave here already masked: credentials in the landing path and
 * the referrer ({@link trackedReferrer}), click marker values in the referrer.
 */
export function resolveAttribution({
  search,
  referrer,
  pathname,
  storage,
  clickIdParams = [],
  storageKey = 'tracking.attribution',
  ttlMs = 90 * 24 * 60 * 60 * 1000,
  now = Date.now(),
}: ResolveAttributionInput): ResolvedAttribution {
  assertClickIdParams(clickIdParams);
  const stored = readStored(storage, storageKey, now, ttlMs);
  const currentTouch: ResolvedAttribution['currentTouch'] = {
    utm: parseUtmFromSearch(search) ?? undefined,
    clickId: clickIdFromSearch(search, clickIdParams),
    referrer: referrer ? trackedReferrer(referrer, clickIdParams) : undefined,
    landingPage: redactTrackingText(pathname),
  };
  if (stored) return { firstTouch: stored.firstTouch.data, currentTouch };
  writeStored(storage, storageKey, {
    version: 1,
    firstTouch: { data: currentTouch, capturedAt: now },
  });
  return { firstTouch: currentTouch, currentTouch };
}
