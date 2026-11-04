import type { ManagedResource, ManagedResourceContext } from '../application/resource';
import type { GeoAttribution } from './schema';

export type { GeoAttribution } from './schema';

export interface MaxMindGeoIpPaths {
  readonly city: string;
  readonly asn?: string;
}

export interface MaxMindGeoIpLoaderOptions {
  /** Test seam; production loads the optional `maxmind` peer lazily. */
  readonly loadPeer?: () => Promise<unknown>;
}

export interface GeoIpReader {
  lookup(ip: string): unknown | Promise<unknown>;
  close?(): void | Promise<void>;
}

/** Peer-neutral boundary implemented by a MaxMind adapter or a test fake. */
export interface GeoIpReaderLoader<TPaths = Readonly<Record<string, string>>> {
  revision(paths: TPaths): string | null | Promise<string | null>;
  /** Open exactly the revision observed by the resolver, or reject if it moved. */
  open(paths: TPaths, expectedRevision: string): GeoIpReader | Promise<GeoIpReader>;
}

export interface GeoIpSnapshot {
  readonly state: 'uninitialized' | 'unavailable' | 'ready';
  readonly revision?: string;
  readonly loadedAt?: number;
  /** A failed refresh while `state` remains `ready` means last-known-good. */
  readonly reloadError?: string;
}

export interface GeoIpResolver extends ManagedResource {
  start(context: ManagedResourceContext): Promise<{ value: GeoIpResolver }>;
  resolve(ip: string): Promise<GeoAttribution | null>;
  reload(): Promise<boolean>;
  snapshot(): GeoIpSnapshot;
}

export interface GeoIpResolverOptions<TPaths = Readonly<Record<string, string>>> {
  readonly id?: string;
  readonly paths: TPaths;
  readonly loader: GeoIpReaderLoader<TPaths>;
  readonly reload?: false | { readonly intervalMs?: number };
  readonly map?: (record: unknown) => GeoAttribution | null;
  readonly clock?: () => number;
  readonly onError?: (error: unknown) => void;
}
