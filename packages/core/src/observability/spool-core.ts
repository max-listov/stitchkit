/**
 * The one local spool: a record goes to an append-only file before the store is
 * offered it, and is marked delivered once the store took it. What a previous
 * process left unmarked is replayed, in the order it was written, by `recover`.
 *
 * Bounded (I10): `maxPendingEntries` undelivered records and `maxFileBytes` on
 * disk (compacting first when delivered lines are what fills it). Past either
 * bound a record is not spooled, and the result says so — the caller decides
 * whether a record that may be lost is acceptable. The file is kept `0o600`:
 * spooled records are audit rows, often with identities in them.
 *
 * Order: records of one `group` reach the store in the order they were written.
 * `write` holds a record back (spooled, not offered) while an earlier record of
 * its group is undelivered, and `recover` stops a group at its first refusal;
 * other groups go on. Without `group` every record stands alone.
 *
 * At least once, never quietly twice: a crash between the store accepting a
 * record and this file marking it replays the record, so the store must be
 * idempotent on the key. See `spool.ts` for the reasoning; this module is the
 * mechanism both the request-event sink and the spend ledger use.
 */
import { writeFileAtomic } from '../internal/atomic-file';
import { errnoOf } from '../internal/errno';
import {
  appendSpoolLine,
  moveSpoolAside,
  openSpoolFile,
  owedRecordsOf,
  type SpoolScanResult,
  scanSpoolFile,
  spoolBodyOf,
  writeSpoolAside,
} from './spool-file';

export interface SpoolCoreConfig<T> {
  path: string;
  /** Deliver one record to the store; must be idempotent on `key(record)`. */
  write: (record: T) => void | Promise<void>;
  key: (record: T) => string;
  /** Records that must reach the store in write order share a group (an attempt id). */
  group?: (record: T) => string;
  /** The record as it lies on disk, and back. */
  encode: (record: T) => unknown;
  decode: (value: unknown) => T;
  /** Delivered records tolerated before the file is rewritten without them. Default 512. */
  compactAfter?: number;
  /** Undelivered records held at most; past it a record is not spooled. Default 10 000. */
  maxPendingEntries?: number;
  /** Spool file size at most, in bytes; past it a record is not spooled. Default 64 MiB. */
  maxFileBytes?: number;
  onSpoolError?: (failure: { error: unknown; record?: T }) => void;
}

/**
 * What became of one record: `delivered` (the store took it); `spooled` (on disk,
 * not delivered — the store refused it, `storeError` says why, or an earlier
 * record of its group is still undelivered — and `recover` will offer it again);
 * `unspooled` (neither: the spool was full or unwritable and the store refused it
 * too; the record is lost unless the caller keeps it).
 */
export type SpoolWriteResult =
  | { readonly outcome: 'delivered' }
  | { readonly outcome: 'spooled'; readonly storeError: unknown }
  | { readonly outcome: 'unspooled'; readonly storeError: unknown };

export interface SpoolRecovery {
  /** Undelivered records found and offered to the store, in file order. */
  replayed: number;
  /**
   * Records still undelivered: refused, or behind a refusal in their group — in the spool
   * file, or in `quarantined` when they did not fit its bound.
   */
  failed: number;
  /**
   * A file the spool moved its debt to, beside its own, so that new records still fit
   * `maxFileBytes`: the owed records a replay left when they did not fit (counted in
   * `failed`), or the whole file when even reading it would hold more than the bound in
   * memory (not counted: nothing in it was offered). A spool at this path with a larger
   * `maxFileBytes` replays it with `recover()`.
   */
  quarantined?: string;
  /**
   * The file could not be read (other than not existing): its debt is unknown, not zero, and
   * left on disk as it is. `onSpoolError` carries the reason (`SPOOL_UNREADABLE`, `cause`).
   */
  unread?: true;
}

/**
 * Reported through `onSpoolError` when a record is not spooled because the spool is at a
 * bound (I10): `entries` — `maxPendingEntries` undelivered records held in memory — or
 * `bytes` — `maxFileBytes` on disk. The record is still offered to the store.
 */
export class SpoolBoundError extends RangeError {
  readonly code = 'SPOOL_FULL';
  constructor(
    readonly bound: 'entries' | 'bytes',
    limit: number,
  ) {
    super(
      bound === 'entries'
        ? `Spool holds its bound of ${limit} undelivered records`
        : `Spool file is at its ${limit}-byte bound`,
    );
    this.name = 'SpoolBoundError';
  }
}

/**
 * What a writer is told when a record was neither spooled nor taken by the store: it is
 * kept nowhere, and lost unless the caller keeps it. `cause` is the store's refusal.
 */
export class SpoolUnspooledError extends Error {
  readonly code = 'SPOOL_UNSPOOLED';
  constructor(storeError: unknown) {
    super('Record not saved: the spool could not hold it and the store refused it', {
      cause: storeError,
    });
    this.name = 'SpoolUnspooledError';
  }
}

/** Reported through `onSpoolError` when `recover` cannot read the spool file. */
export class SpoolUnreadableError extends Error {
  readonly code = 'SPOOL_UNREADABLE';
  constructor(path: string, cause: unknown) {
    super(`Spool file ${path} could not be read: its debt is unknown`, { cause });
    this.name = 'SpoolUnreadableError';
  }
}

/** Reported through `onSpoolError` when `recover` moves the spool's debt aside. */
export class SpoolQuarantineError extends Error {
  readonly code = 'SPOOL_QUARANTINED';
  constructor(
    readonly quarantined: string,
    reason: string,
  ) {
    super(`Spool debt moved to ${quarantined}: ${reason}`);
    this.name = 'SpoolQuarantineError';
  }
}

export interface SpoolCore<T> {
  write(record: T): Promise<SpoolWriteResult>;
  recover(): Promise<SpoolRecovery>;
  pending(): number;
}

const heldBack = new Error('An earlier record of this group is undelivered');

/**
 * What stays undelivered after a recover: what the file still owes first, in file order,
 * then a record written while the replay ran, so its group keeps its order behind it.
 */
function keepAfterRecover<T>(
  undelivered: Map<string, T>,
  pending: ReadonlyMap<string, T>,
  recovered: ReadonlySet<string>,
): void {
  const during = [...undelivered].filter(([key]) => !pending.has(key) && !recovered.has(key));
  undelivered.clear();
  for (const [key, record] of [...pending, ...during]) undelivered.set(key, record);
}

/** A record the store did not take: on disk (`spooled`) or nowhere. */
function undeliveredResult(spooled: boolean, storeError: unknown): SpoolWriteResult {
  return spooled ? { outcome: 'spooled', storeError } : { outcome: 'unspooled', storeError };
}

/** A scan that holds at most the spool's own bound in memory, and at most its pending records. */
function scanSpool<T>(
  config: SpoolCoreConfig<T>,
  maxFileBytes: number,
  maxPending: number,
  report: boolean,
): Promise<SpoolScanResult<T>> {
  return scanSpoolFile(
    config.path,
    config.decode,
    { maxBytes: maxFileBytes, maxEntries: maxPending },
    report ? (error) => config.onSpoolError?.({ error }) : undefined,
  );
}

/**
 * Offer each owed record to the store in file order, marking each one it takes; a group stops
 * at its first refusal. Removes what was delivered from `pending` and answers its keys.
 */
async function replayOwed<T>(
  pending: Map<string, T>,
  config: SpoolCoreConfig<T>,
  acknowledge: (key: string) => Promise<void>,
): Promise<Set<string>> {
  const stopped = new Set<string>();
  const recovered = new Set<string>();
  for (const [key, record] of pending) {
    const group = config.group?.(record);
    if (group !== undefined && stopped.has(group)) continue;
    try {
      await config.write(record);
      pending.delete(key);
      recovered.add(key);
      await acknowledge(key);
    } catch (error) {
      config.onSpoolError?.({ error, record });
      if (group !== undefined) stopped.add(group);
    }
  }
  return recovered;
}

export function createSpoolCore<T>(config: SpoolCoreConfig<T>): SpoolCore<T> {
  const compactAfter = config.compactAfter ?? 512;
  const maxPending = config.maxPendingEntries ?? 10_000;
  const maxFileBytes = config.maxFileBytes ?? 64 * 1024 * 1024;
  const groupOf = config.group;
  const undelivered = new Map<string, T>();
  let delivered = 0;
  let fileBytes: number | undefined;
  let tail: Promise<unknown> = Promise.resolve();

  const scan = (report: boolean) => scanSpool(config, maxFileBytes, maxPending, report);
  // Compact a file over its bound once even with nothing delivered: a legacy file may hold
  // delivered lines.
  let compactedOnce = false;

  function serialise<R>(work: () => Promise<R>): Promise<R> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  }

  /** The file's size, with a torn last line (a crash mid-append) closed off and the mode set. */
  async function openedSize(): Promise<number> {
    fileBytes ??= await openSpoolFile(config.path);
    return fileBytes;
  }

  async function append(line: object, record?: T): Promise<boolean> {
    try {
      const text = `${JSON.stringify(line)}\n`;
      const length = Buffer.byteLength(text);
      if ((await openedSize()) + length > maxFileBytes && (delivered > 0 || !compactedOnce))
        await compact();
      if ((await openedSize()) + length > maxFileBytes) {
        config.onSpoolError?.({
          error: new SpoolBoundError('bytes', maxFileBytes),
          ...(record !== undefined && { record }),
        });
        return false;
      }
      await appendSpoolLine(config.path, text);
      fileBytes = (fileBytes ?? 0) + length;
      return true;
    } catch (error) {
      fileBytes = undefined;
      config.onSpoolError?.({ error, ...(record !== undefined && { record }) });
      return false;
    }
  }

  /**
   * Rewrite the file with what it still owes the store. Built from the file, not
   * from this process's memory: records an earlier process (or another writer)
   * left undelivered, and lines nobody could decode, survive it. At the end of a
   * recover (`afterRecover`) a debt that does not fit `maxFileBytes` goes beside the
   * file and the spool goes on with an empty one — refusing every new record behind an
   * old debt is what the spool exists to prevent; answers where it went.
   */
  async function compact(afterRecover = false): Promise<string | undefined> {
    compactedOnce = true;
    let scanned: SpoolScanResult<T>;
    try {
      scanned = await scan(false);
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT') config.onSpoolError?.({ error });
      return undefined;
    }
    if (!scanned.within) {
      if (afterRecover) return quarantine(await moveSpoolAside(config.path), scanned.reason);
      config.onSpoolError?.({
        error: new RangeError(`Spool file not compacted: ${scanned.reason}`),
      });
      return undefined;
    }
    const body = spoolBodyOf(scanned.scan);
    const bytes = Buffer.byteLength(body);
    if (!afterRecover || bytes <= maxFileBytes) {
      await writeBody(body);
      return undefined;
    }
    const target = await writeSpoolAside(config.path, body);
    await writeBody('');
    return quarantine(
      target,
      `${scanned.scan.owed.size} owed records take ${bytes} bytes, over the ${maxFileBytes}-byte bound`,
    );
  }

  function quarantine(target: string, reason: string): string {
    fileBytes = undefined;
    config.onSpoolError?.({ error: new SpoolQuarantineError(target, reason) });
    return target;
  }

  async function writeBody(body: string): Promise<void> {
    try {
      await writeFileAtomic(config.path, body, { mode: 0o600 });
      delivered = 0;
      fileBytes = Buffer.byteLength(body);
    } catch (error) {
      fileBytes = undefined;
      config.onSpoolError?.({ error });
    }
  }

  async function acknowledge(key: string): Promise<void> {
    undelivered.delete(key);
    delivered += 1;
    await serialise(async () => {
      await append({ a: key });
      if (delivered >= compactAfter) await compact();
    });
  }

  /**
   * Deliver the undelivered records of `group` written before `key`, in order. A
   * new record of a group retries the ones ahead of it, so a database that came
   * back takes the attempt and then its receipt without waiting for a restart.
   */
  async function drainAhead(group: string, key: string): Promise<boolean> {
    for (const [earlierKey, earlier] of [...undelivered]) {
      if (earlierKey === key) return true;
      if (groupOf?.(earlier) !== group) continue;
      try {
        await config.write(earlier);
      } catch {
        return false;
      }
      if (undelivered.has(earlierKey)) await acknowledge(earlierKey);
    }
    return true;
  }

  return {
    async write(record) {
      const key = config.key(record);
      const group = groupOf?.(record);
      // Registered before the first await: a write of the same group arriving
      // meanwhile already sees this one ahead of it.
      const room = undelivered.size < maxPending;
      if (room) undelivered.set(key, record);
      else
        config.onSpoolError?.({ error: new SpoolBoundError('entries', maxPending), record });
      let spooled = false;
      if (room) {
        try {
          const encoded = config.encode(record);
          spooled = await serialise(() => append({ k: key, e: encoded }, record));
        } finally {
          if (!spooled) undelivered.delete(key);
        }
      }
      if (group !== undefined && !(await drainAhead(group, key)))
        return undeliveredResult(spooled, heldBack);
      // Outside the append chain: a slow store must not hold up the next record's line.
      try {
        await config.write(record);
      } catch (storeError) {
        return undeliveredResult(spooled, storeError);
      }
      if (spooled) await acknowledge(key);
      return { outcome: 'delivered' };
    },

    async recover() {
      let scanned: SpoolScanResult<T>;
      try {
        scanned = await scan(true);
      } catch (error) {
        if (errnoOf(error) === 'ENOENT') return { replayed: 0, failed: 0 };
        config.onSpoolError?.({ error: new SpoolUnreadableError(config.path, error) });
        return { replayed: 0, failed: 0, unread: true };
      }
      if (!scanned.within) {
        // Not one record is offered from a file this large: it goes aside whole, and the
        // spool starts a file that new records fit.
        const quarantined = await serialise(async () =>
          quarantine(await moveSpoolAside(config.path), scanned.reason),
        );
        return { replayed: 0, failed: 0, quarantined };
      }
      const pending = owedRecordsOf(scanned.scan);
      const replayed = pending.size;
      const recovered = await replayOwed(pending, config, (key) =>
        serialise(() => append({ a: key }).then(() => undefined)),
      );
      keepAfterRecover(undelivered, pending, recovered);
      delivered = 0;
      const quarantined = await serialise(() => compact(true));
      if (quarantined === undefined) return { replayed, failed: pending.size };
      for (const key of pending.keys()) undelivered.delete(key);
      return { replayed, failed: pending.size, quarantined };
    },

    pending: () => undelivered.size,
  };
}
