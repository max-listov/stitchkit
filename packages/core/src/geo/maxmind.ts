import { realpath, stat } from 'node:fs/promises';
import type {
  GeoIpReader,
  GeoIpReaderLoader,
  MaxMindGeoIpLoaderOptions,
  MaxMindGeoIpPaths,
} from './types';

interface StructuralMaxMindReader {
  get(ip: string): unknown;
  close?(): void | Promise<void>;
}

interface StructuralMaxMindPeer {
  open(
    path: string,
    options?: { watchForUpdates?: boolean },
  ): Promise<StructuralMaxMindReader>;
}

// Keep the optional peer outside the shared build graph. A literal external
// dynamic import is rewritten to a createRequire shim under the Node target;
// the shim is then hoisted into a shared chunk imported by browser entries.
const MAXMIND_PEER = 'maxmind';

async function revisionOf(paths: MaxMindGeoIpPaths): Promise<string | null> {
  try {
    const entries = await Promise.all(
      [paths.city, paths.asn]
        .filter((path): path is string => path !== undefined)
        .map(async (path) => {
          const [resolved, metadata] = await Promise.all([realpath(path), stat(path)]);
          return [
            resolved,
            metadata.dev,
            metadata.ino,
            metadata.size,
            Math.trunc(metadata.mtimeMs),
          ].join(':');
        }),
    );
    return entries.join('|');
  } catch {
    return null;
  }
}

/** Lazy optional-peer adapter. It opens City and optional ASN as one stable generation. */
export function createMaxMindGeoIpLoader(
  options: MaxMindGeoIpLoaderOptions = {},
): GeoIpReaderLoader<MaxMindGeoIpPaths> {
  const loadPeer = options.loadPeer ?? (() => import(MAXMIND_PEER));
  return {
    revision: revisionOf,
    async open(paths, expectedRevision) {
      const before = await revisionOf(paths);
      if (before === null) throw new Error('GeoIP database is unavailable');
      if (before !== expectedRevision) {
        throw new Error('GeoIP database changed before opening a generation');
      }
      // Boundary over the optional peer, loaded by name at runtime: the module
      // has no type here, and the one member used is checked structurally next.
      const peer = (await loadPeer()) as StructuralMaxMindPeer;
      if (!peer || typeof peer.open !== 'function') {
        throw new Error('The optional maxmind peer does not expose open()');
      }
      const city = await peer.open(paths.city, { watchForUpdates: false });
      let asn: StructuralMaxMindReader | undefined;
      try {
        if (paths.asn) asn = await peer.open(paths.asn, { watchForUpdates: false });
        const after = await revisionOf(paths);
        if (after !== before)
          throw new Error('GeoIP database changed while opening a generation');
        return {
          lookup(ip) {
            const cityRecord = city.get(ip);
            const asnRecord = asn?.get(ip);
            if (!asnRecord || typeof asnRecord !== 'object') return cityRecord;
            if (!cityRecord || typeof cityRecord !== 'object') return asnRecord;
            return { ...cityRecord, ...asnRecord };
          },
          async close() {
            await Promise.all([city.close?.(), asn?.close?.()]);
          },
        } satisfies GeoIpReader;
      } catch (error) {
        await Promise.allSettled([city.close?.(), asn?.close?.()]);
        throw error;
      }
    },
  };
}
