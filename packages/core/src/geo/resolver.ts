import { messageOf } from '../internal/error-message';
import { isRecord } from '../internal/typed';
import { isPublicIp } from '../server/request';
import type {
  GeoAttribution,
  GeoIpReader,
  GeoIpResolver,
  GeoIpResolverOptions,
  GeoIpSnapshot,
} from './types';

interface ReaderGeneration {
  readonly reader: GeoIpReader;
  readonly revision: string;
  lookups: number;
  retired: boolean;
  closePromise?: Promise<void>;
  closeResolve?: () => void;
  closing?: boolean;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/** Map the common MaxMind record shape without exposing peer types. */
export function mapGeoIpRecord(value: unknown): GeoAttribution | null {
  const root = record(value);
  if (!root) return null;
  const country = record(root.country);
  const subdivisions = Array.isArray(root.subdivisions)
    ? record(root.subdivisions[0])
    : undefined;
  const city = record(root.city);
  const postal = record(root.postal);
  const location = record(root.location);
  const names = (entry: Record<string, unknown> | undefined) => record(entry?.names);
  const result: GeoAttribution = {
    countryCode: text(country?.iso_code),
    countryName: text(names(country)?.en),
    regionCode: text(subdivisions?.iso_code),
    regionName: text(names(subdivisions)?.en),
    city: text(names(city)?.en),
    postalCode: text(postal?.code),
    latitude: finite(location?.latitude),
    longitude: finite(location?.longitude),
    timezone: text(location?.time_zone),
    autonomousSystemNumber: finite(root.autonomous_system_number),
    autonomousSystemOrganization: text(root.autonomous_system_organization),
  };
  return Object.values(result).some((entry) => entry !== undefined) ? result : null;
}

const errorMessage = (error: unknown): string => messageOf(error) || 'unknown reload error';

/**
 * Create a server-only GeoIP managed resource with atomic generation swaps.
 * Initial absence is non-fatal; reload failure preserves the last good reader.
 */
export function createGeoIpResolver<TPaths>(
  options: GeoIpResolverOptions<TPaths>,
): GeoIpResolver {
  const clock = options.clock ?? Date.now;
  const map = options.map ?? mapGeoIpRecord;
  let generation: ReaderGeneration | null = null;
  let snapshot: GeoIpSnapshot = Object.freeze({ state: 'uninitialized' });
  let reloadChain: Promise<boolean> = Promise.resolve(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const finishRetire = async (current: ReaderGeneration): Promise<void> => {
    if (current.closing) return current.closePromise ?? Promise.resolve();
    current.closing = true;
    try {
      await current.reader.close?.();
    } catch (error) {
      options.onError?.(error);
    } finally {
      current.closeResolve?.();
    }
  };
  const retire = (current: ReaderGeneration): Promise<void> => {
    current.retired = true;
    if (current.closePromise) return current.closePromise;
    if (current.lookups > 0) {
      current.closePromise = new Promise<void>((resolve) => {
        current.closeResolve = resolve;
      });
      return current.closePromise;
    }
    current.closePromise = finishRetire(current);
    return current.closePromise;
  };

  const swap = async (): Promise<boolean> => {
    if (closed) return false;
    let revision: string | null;
    try {
      revision = await options.loader.revision(options.paths);
      if (revision === null) throw new Error('GeoIP database is unavailable');
      if (generation && revision === generation.revision) {
        if (snapshot.reloadError) {
          snapshot = Object.freeze({
            state: 'ready',
            revision,
            loadedAt: snapshot.loadedAt,
          });
        }
        return false;
      }
      const next = await options.loader.open(options.paths, revision);
      if (closed) {
        await next.close?.();
        return false;
      }
      const previous = generation;
      generation = { reader: next, revision, lookups: 0, retired: false };
      snapshot = Object.freeze({ state: 'ready', revision, loadedAt: clock() });
      if (previous) await retire(previous);
      return true;
    } catch (error) {
      options.onError?.(error);
      snapshot = generation
        ? Object.freeze({
            state: 'ready',
            revision: generation.revision,
            loadedAt: snapshot.loadedAt,
            reloadError: errorMessage(error),
          })
        : Object.freeze({ state: 'unavailable', reloadError: errorMessage(error) });
      return false;
    }
  };
  const reload = (): Promise<boolean> => {
    reloadChain = reloadChain.then(swap, swap);
    return reloadChain;
  };
  const close = async (): Promise<void> => {
    closed = true;
    if (timer) clearInterval(timer);
    timer = undefined;
    await reloadChain.catch(() => undefined);
    const current = generation;
    generation = null;
    if (current) await retire(current);
    snapshot = Object.freeze({ state: 'uninitialized' });
  };

  return {
    id: options.id ?? 'geoip',
    async start() {
      closed = false;
      await reload();
      return { value: this };
    },
    activate() {
      const intervalMs = options.reload === false ? undefined : options.reload?.intervalMs;
      if (intervalMs !== undefined && intervalMs > 0 && !timer) {
        timer = setInterval(() => void reload(), intervalMs);
        timer.unref?.();
      }
    },
    close,
    force: close,
    async resolve(ip) {
      if (!isPublicIp(ip)) return null;
      const current = generation;
      if (!current) return null;
      current.lookups += 1;
      try {
        return map(await current.reader.lookup(ip));
      } catch (error) {
        options.onError?.(error);
        return null;
      } finally {
        current.lookups -= 1;
        if (current.retired && current.lookups === 0) await finishRetire(current);
      }
    },
    reload,
    snapshot: () => snapshot,
  };
}
