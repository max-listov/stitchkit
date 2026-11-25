import { lstatSync, statSync } from 'node:fs';
import { assertPositiveSafeInteger } from '../internal/positive-integer';
import { canonicalDigest } from '../internal/stable-digest';
import {
  clockNs,
  type FileStamp,
  type PathStat,
  pathStatOf,
  pathStatOfAsync,
  stampOf,
} from './file-stamp';
import {
  decodedOf,
  failedReadingOf,
  type JsonFileReading,
  sameFailure,
  valueReadingOf,
} from './json-file-reading';
import {
  DEFAULT_JSON_FILE_BYTES,
  type JsonValueSchema,
  type RegularFileAccept,
  type RegularFileReadOptions,
  readRegularFileFromOpen,
  readRegularFileWithMetaSync,
} from './regular-file';

/** Default cap on the cached payload bytes of `PolledJsonFile(s)` (4 MiB); see {@link PolledJsonOptions.maxCacheBytes}. */
export const MAX_POLLED_JSON_CACHE_BYTES = 4 * 1024 * 1024;

/** Most paths one `PolledJsonFiles` tracks; a larger `refresh` set is refused. */
export const MAX_POLLED_JSON_PATHS = 1024;

/** The read options of every poll, plus the payload cache bound. */
export interface PolledJsonOptions extends RegularFileReadOptions {
  /**
   * Cap on cached payloads, counted in the bytes each file held when read; default
   * {@link MAX_POLLED_JSON_CACHE_BYTES}. What a cached reading keeps is its decoded text (up
   * to two bytes of memory per byte read) and the parsed value, so the memory it takes is a
   * multiple of this count, not this count.
   */
  maxCacheBytes?: number;
}

/**
 * One path of a polled set and its own read options, which replace the set's
 * (`limit`, `noFollow`, `accept`) field by field. Pass the same `accept` function on
 * every poll: a new one reads the file again rather than trusting the cached identity.
 */
export interface PolledJsonEntry {
  readonly path: string;
  readonly options?: RegularFileReadOptions;
}

/** One change of a polled set: a path's new reading, or a path that left the set. */
export type PolledJsonChange<T> =
  | { readonly kind: 'changed'; readonly path: string; readonly reading: JsonFileReading<T> }
  | { readonly kind: 'removed'; readonly path: string };

interface ReadOptions {
  readonly limit: number;
  readonly noFollow: boolean;
  readonly accept?: RegularFileAccept;
}

interface TrackedEntry<T> {
  readonly state: JsonFileReading<T>['state'];
  /** Absent only for a `read` entry whose payload the cache bound evicted. */
  reading?: JsonFileReading<T>;
  /** Metadata of the bytes behind `reading`; absent when a read failed. */
  stamp?: FileStamp;
  digest?: string;
  cachedBytes: number;
  readonly options: ReadOptions;
}

/** What one poll of a path found; `result` is `null` when nothing changed and only a change was asked for. */
type Observation<T> =
  | { readonly kind: 'cached'; readonly result: JsonFileReading<T> | null }
  | {
      readonly kind: 'stored';
      readonly entry: TrackedEntry<T>;
      readonly result: JsonFileReading<T> | null;
    };

type ReadOutcome = { bytes: Uint8Array; stamp?: FileStamp } | { error: unknown };

function sameOptions(a: ReadOptions, b: ReadOptions): boolean {
  return a.limit === b.limit && a.noFollow === b.noFollow && a.accept === b.accept;
}

const MISSING: JsonFileReading<never> = { state: 'missing' };

/**
 * Polls a set of JSON files that changes as it runs, with a bounded LRU payload
 * cache and identity/content change detection. Each path is read with the set's
 * options or its own ({@link PolledJsonEntry}); the unchanged-identity shortcut
 * honours `noFollow` and is skipped when a path's options change. Metadata alone answers
 * only for a file read at least 3 s after its last change: a younger one is read and
 * compared again on every poll until a read finds it that old, since a same-length rewrite
 * inside one tick of a coarse filesystem clock changes no metadata. A filesystem whose
 * clock runs behind this process by more than that window is outside the guarantee.
 */
export class PolledJsonFiles<T> {
  private readonly schema: JsonValueSchema<T>;
  private readonly readOptions: ReadOptions;
  private readonly maxCacheBytes: number;
  private readonly entries = new Map<string, TrackedEntry<T>>();
  private totalCachedBytes = 0;
  private refreshing = false;

  constructor(schema: JsonValueSchema<T>, options: PolledJsonOptions = {}) {
    const {
      limit = DEFAULT_JSON_FILE_BYTES,
      maxCacheBytes = MAX_POLLED_JSON_CACHE_BYTES,
      noFollow = false,
      accept,
    } = options;
    assertPositiveSafeInteger('limit', limit);
    assertPositiveSafeInteger('maxCacheBytes', maxCacheBytes);
    this.schema = schema;
    this.readOptions = { limit, noFollow, accept };
    this.maxCacheBytes = maxCacheBytes;
  }

  /** Current total payload bytes retained in the cache. */
  get cachedBytes(): number {
    return this.totalCachedBytes;
  }

  /** Number of tracked file paths. */
  get size(): number {
    return this.entries.size;
  }

  /** Read `path`, returning the cached reading when file identity or content is unchanged. */
  read(path: string, options?: RegularFileReadOptions): JsonFileReading<T> {
    return this.pollOne(path, options, false) ?? MISSING;
  }

  /**
   * Read `path` only when its state or validated content changed since the last
   * observation; returns `null` when unchanged.
   */
  readChanged(path: string, options?: RegularFileReadOptions): JsonFileReading<T> | null {
    return this.pollOne(path, options, true);
  }

  /** Remove one path from the cache. */
  delete(path: string): boolean {
    this.assertIdle();
    return this.forget(path);
  }

  /**
   * Make `entries` the tracked set: a tracked path absent from it is dropped with a
   * `removed` change, and each path in it is read with {@link readChanged}, a
   * `changed` change for a new path or a new state, in the order given. A path listed
   * twice is refused (`TypeError`), and so is more than {@link MAX_POLLED_JSON_PATHS}
   * paths (`RangeError`) rather than evicted, since an evicted path would come back as
   * a false change; a refused set changes nothing.
   */
  refresh(entries: Iterable<PolledJsonEntry>): PolledJsonChange<T>[] {
    this.assertIdle();
    const wanted = this.wantedOf(entries);
    const observed: Array<[string, Observation<T>]> = [];
    for (const [path, options] of wanted) {
      observed.push([path, this.observeSync(path, options, true)]);
    }
    return this.apply(wanted, observed);
  }

  /**
   * {@link refresh} with every stat and read asynchronous, so a large set does not hold
   * the event loop. Nothing is committed until every path is read: an aborted or
   * failed refresh leaves the set as it was. While it runs, every other call on this
   * set — another `refreshAsync` included — is refused.
   */
  async refreshAsync(
    entries: Iterable<PolledJsonEntry>,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<PolledJsonChange<T>[]> {
    this.assertIdle();
    const { signal } = options;
    const wanted = this.wantedOf(entries);
    this.refreshing = true;
    try {
      const observed: Array<[string, Observation<T>]> = [];
      for (const [path, readOptions] of wanted) {
        signal?.throwIfAborted();
        observed.push([path, await this.observeAsync(path, readOptions, signal)]);
      }
      return this.apply(wanted, observed);
    } finally {
      this.refreshing = false;
    }
  }

  /** Drop all cached entries and reset memory usage to zero. */
  clear(): void {
    this.assertIdle();
    this.entries.clear();
    this.totalCachedBytes = 0;
  }

  private forget(path: string): boolean {
    const existing = this.entries.get(path);
    if (!existing) return false;
    this.totalCachedBytes -= existing.cachedBytes;
    return this.entries.delete(path);
  }

  private assertIdle(): void {
    if (this.refreshing) {
      throw new Error('PolledJsonFiles: a refreshAsync is still running on this set');
    }
  }

  private optionsFor(override: RegularFileReadOptions | undefined): ReadOptions {
    if (override === undefined) return this.readOptions;
    const limit = override.limit ?? this.readOptions.limit;
    assertPositiveSafeInteger('limit', limit);
    return {
      limit,
      noFollow: override.noFollow ?? this.readOptions.noFollow,
      accept: override.accept ?? this.readOptions.accept,
    };
  }

  private wantedOf(entries: Iterable<PolledJsonEntry>): Map<string, ReadOptions> {
    const wanted = new Map<string, ReadOptions>();
    for (const { path, options } of entries) {
      if (wanted.has(path)) {
        throw new TypeError(`PolledJsonFiles: ${path} is listed twice in one refresh`);
      }
      if (wanted.size >= MAX_POLLED_JSON_PATHS) {
        throw new RangeError(`PolledJsonFiles tracks at most ${MAX_POLLED_JSON_PATHS} paths`);
      }
      wanted.set(path, this.optionsFor(options));
    }
    return wanted;
  }

  private apply(
    wanted: ReadonlyMap<string, ReadOptions>,
    observed: ReadonlyArray<readonly [string, Observation<T>]>,
  ): PolledJsonChange<T>[] {
    const changes: PolledJsonChange<T>[] = [];
    for (const path of [...this.entries.keys()]) {
      if (wanted.has(path)) continue;
      this.forget(path);
      changes.push({ kind: 'removed', path });
    }
    for (const [path, observation] of observed) {
      this.commit(path, observation);
      if (observation.result !== null) {
        changes.push({ kind: 'changed', path, reading: observation.result });
      }
    }
    return changes;
  }

  private pollOne(
    path: string,
    override: RegularFileReadOptions | undefined,
    onlyChanged: boolean,
  ): JsonFileReading<T> | null {
    this.assertIdle();
    // Refused, never evicted: an evicted path would come back as a false change and
    // a path that left the set would never be reported as removed.
    if (!this.entries.has(path) && this.entries.size >= MAX_POLLED_JSON_PATHS) {
      throw new RangeError(
        `PolledJsonFiles tracks at most ${MAX_POLLED_JSON_PATHS} paths; delete or refresh first`,
      );
    }
    const observation = this.observeSync(path, this.optionsFor(override), onlyChanged);
    this.commit(path, observation);
    return observation.result;
  }

  private observeSync(
    path: string,
    options: ReadOptions,
    onlyChanged: boolean,
  ): Observation<T> {
    const existing = this.entries.get(path);
    // Taken before the stat: a write the bytes below miss is stamped no earlier than this.
    const readStartedNs = clockNs();
    const found = pathStatOf(
      () =>
        options.noFollow
          ? lstatSync(path, { bigint: true })
          : statSync(path, { bigint: true }),
      readStartedNs,
    );
    const shortcut = this.fromStat(existing, options, found, onlyChanged);
    if (shortcut !== undefined) return shortcut;
    let outcome: ReadOutcome;
    try {
      const { bytes, after } = readRegularFileWithMetaSync(path, options);
      outcome = { bytes, stamp: stampOf(after, readStartedNs) };
    } catch (error) {
      outcome = { error };
    }
    return this.fromRead(existing, options, outcome, onlyChanged);
  }

  private async observeAsync(
    path: string,
    options: ReadOptions,
    signal: AbortSignal | undefined,
  ): Promise<Observation<T>> {
    const existing = this.entries.get(path);
    const readStartedNs = clockNs();
    const found = await pathStatOfAsync(path, options.noFollow, readStartedNs);
    const shortcut = this.fromStat(existing, options, found, true);
    if (shortcut !== undefined) return shortcut;
    let outcome: ReadOutcome;
    try {
      const bytes = await readRegularFileFromOpen(path, { ...options, signal });
      // The identity taken before the read is never newer than the bytes read after it:
      // a change in between costs one more read on the next poll, never a missed one.
      outcome = { bytes, ...(found.kind === 'file' && { stamp: found.stamp }) };
    } catch (error) {
      if (signal?.aborted) throw error;
      outcome = { error };
    }
    return this.fromRead(existing, options, outcome, true);
  }

  /**
   * The answer the path's metadata alone gives, or `undefined` when its bytes must be read:
   * the identity changed, or it was cached while too young to prove a later write.
   */
  private fromStat(
    existing: TrackedEntry<T> | undefined,
    options: ReadOptions,
    found: PathStat,
    onlyChanged: boolean,
  ): Observation<T> | undefined {
    if (found.kind === 'missing') {
      const unchanged = existing?.state === 'missing';
      return {
        kind: 'stored',
        entry: { state: 'missing', reading: MISSING, cachedBytes: 0, options },
        result: onlyChanged && unchanged ? null : MISSING,
      };
    }
    if (
      found.kind !== 'file' ||
      existing?.stamp === undefined ||
      !existing.stamp.settled ||
      existing.stamp.identity !== found.stamp.identity ||
      !sameOptions(existing.options, options)
    ) {
      return undefined;
    }
    if (onlyChanged) return { kind: 'cached', result: null };
    if (existing.reading !== undefined) return { kind: 'cached', result: existing.reading };
    return undefined;
  }

  private fromRead(
    existing: TrackedEntry<T> | undefined,
    options: ReadOptions,
    outcome: ReadOutcome,
    onlyChanged: boolean,
  ): Observation<T> {
    const failed = (reading: JsonFileReading<T>, stamp?: FileStamp): Observation<T> => ({
      kind: 'stored',
      entry: { state: reading.state, reading, cachedBytes: 0, options, stamp },
      result: onlyChanged && sameFailure(existing?.reading, reading) ? null : reading,
    });
    if ('error' in outcome) return failed(failedReadingOf(outcome.error));
    const { bytes, stamp } = outcome;
    const decoded = decodedOf<T>(bytes);
    if ('failure' in decoded) return failed(decoded.failure, stamp);

    const digest = canonicalDigest(decoded.text);
    if (existing?.state === 'read' && existing.digest === digest) {
      const entry = { ...existing, stamp, options };
      if (onlyChanged) return { kind: 'stored', entry, result: null };
      if (existing.reading !== undefined) {
        return { kind: 'stored', entry, result: existing.reading };
      }
    }
    const reading = valueReadingOf(decoded.text, this.schema);
    if (reading.state !== 'read') return failed(reading, stamp);
    const cacheable = bytes.byteLength <= this.maxCacheBytes;
    return {
      kind: 'stored',
      entry: {
        state: 'read',
        stamp,
        digest,
        options,
        ...(cacheable ? { reading, cachedBytes: bytes.byteLength } : { cachedBytes: 0 }),
      },
      result: reading,
    };
  }

  private commit(path: string, observation: Observation<T>): void {
    const existing = this.entries.get(path);
    if (observation.kind === 'cached') {
      if (existing === undefined) return;
      this.entries.delete(path);
      this.entries.set(path, existing);
      return;
    }
    this.storeEntry(path, observation.entry);
  }

  private evictPayloadsFor(neededBytes: number): void {
    for (const entry of this.entries.values()) {
      if (this.totalCachedBytes + neededBytes <= this.maxCacheBytes) break;
      if (entry.cachedBytes === 0) continue;
      this.totalCachedBytes -= entry.cachedBytes;
      entry.cachedBytes = 0;
      entry.reading = undefined;
    }
  }

  private storeEntry(path: string, next: TrackedEntry<T>): void {
    const previous = this.entries.get(path);
    if (previous) {
      this.totalCachedBytes -= previous.cachedBytes;
      this.entries.delete(path);
    }
    if (next.cachedBytes > this.maxCacheBytes) {
      next.cachedBytes = 0;
      next.reading = undefined;
    } else if (next.cachedBytes > 0) {
      this.evictPayloadsFor(next.cachedBytes);
    }
    this.entries.set(path, next);
    this.totalCachedBytes += next.cachedBytes;
  }
}

/**
 * Polls a single JSON file with a bounded cache and change detection.
 * Shares the exact state machine of {@link PolledJsonFiles}.
 */
export class PolledJsonFile<T> {
  private readonly path: string;
  private readonly files: PolledJsonFiles<T>;

  constructor(path: string, schema: JsonValueSchema<T>, options?: PolledJsonOptions) {
    this.path = path;
    this.files = new PolledJsonFiles(schema, options);
  }

  /** Current payload bytes retained in the cache (0 when uncached or oversized). */
  get cachedBytes(): number {
    return this.files.cachedBytes;
  }

  /** Read the file, reusing the cached reading when unchanged. */
  read(): JsonFileReading<T> {
    return this.files.read(this.path);
  }

  /** Read only if the file state or content changed since the last observation; else `null`. */
  readChanged(): JsonFileReading<T> | null {
    return this.files.readChanged(this.path);
  }

  /** Clear cached state so the next observation reloads from disk. */
  clear(): void {
    this.files.clear();
  }
}
