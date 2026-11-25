/**
 * An audit row that survives the store being down.
 *
 * A sink is fire-and-forget by design: it must not fail the work it observes.
 * The cost is that when the store is unreachable the event is simply gone — and
 * the moment a store is most likely to be unreachable is an incident, which is
 * also the window whose audit rows someone will later want most. Measured across
 * six consuming projects: five lose the event, and the sixth had written this
 * file itself, with its own race test.
 *
 * So: the line goes to a local append-only file *before* it is offered to the
 * store, and it is marked delivered only once the store took it. What a previous
 * process left unmarked is replayed by {@link SpooledSink.recover}.
 *
 * ## At least once, and never quietly twice
 *
 * A crash between the store accepting a row and this file recording that it did
 * replays the row. That is the honest guarantee — at least once — and it is why
 * every record carries a key (the W3C `spanId` by default, unique per call):
 * **the store must be idempotent on that key.** A unique index on it turns the
 * duplicate into a no-op, which is the whole cost of the guarantee. Without one,
 * replay writes the row twice, and this file cannot prevent that from here.
 *
 * Exactly-once across a process boundary and a database would need the two to
 * share a transaction. They do not, and an audit layer that pretended otherwise
 * would be lying about the one thing it exists to be trusted on.
 *
 * ## What it is not
 *
 * Not a queue, not a broker, not a cross-process outbox. One process owns one
 * spool file: two processes on one path append and compact the same file and
 * can tear each other's lines. Give each process its own path.
 */
import { isRecord, spooledRecord } from '../internal/typed';
import type { RequestEvent } from './event';
import { createSpoolCore, type SpoolRecovery, SpoolUnspooledError } from './spool-core';

export type { SpoolRecovery };

export interface SpooledSinkConfig {
  /** The real sink — normally the project's audit-table write. */
  write: (event: RequestEvent) => void | Promise<void>;
  /**
   * The spool file. Created with its directory if missing, mode `0o600`.
   *
   * One process, one path: see the module header.
   */
  path: string;
  /**
   * The identity a replayed record is recognised by. Default: `event.spanId`,
   * which is unique per call by construction.
   *
   * Whatever it returns is what the store must be idempotent on.
   */
  key?: (event: RequestEvent) => string;
  /**
   * Delivered records tolerated in the file before it is rewritten without
   * them. Default 512. The rewrite is atomic — a temporary file and a rename —
   * so a crash during it leaves either the old file or the new one.
   */
  compactAfter?: number;
  /** Undelivered events held at most; past it an event is not spooled (and `onSpoolError` says so). Default 10 000. */
  maxPendingEntries?: number;
  /** Spool file size at most, in bytes, compacting first. Default 64 MiB. */
  maxFileBytes?: number;
  /** Observe a spool-file failure. The event is still offered to the store. */
  onSpoolError?: (failure: { error: unknown; event?: RequestEvent }) => void;
}

export interface SpooledSink {
  /**
   * Spool, then deliver. Hand this to `RequestEventSinkConfig.write`. Rejects with the
   * store's error when the store refused a row that is on disk (`recover` offers it again),
   * and with an error of code `SPOOL_UNSPOOLED` (the store's error as `cause`) when the row
   * is kept nowhere: the spool was at `maxPendingEntries` or `maxFileBytes` (`onSpoolError`
   * reports `SPOOL_FULL`) or could not be written, and the store refused it too.
   */
  write(event: RequestEvent): Promise<void>;
  /**
   * Replay what a previous process left undelivered, then rewrite the file with
   * whatever is still undelivered.
   *
   * Call it once at startup, **before** the sink is wired, and await it: a
   * replay racing live writes can only make the file larger and the order
   * stranger. Safe to call on a path that does not exist — that is the ordinary
   * first run, and it reports zero rather than failing.
   */
  recover(): Promise<SpoolRecovery>;
  /** Records spooled and not yet marked delivered, in this process. */
  pending(): number;
}

/**
 * `startedAt` is a `Date` in the shape and a string on disk.
 *
 * Revived on the way back, because a store handed a string where its column is
 * a timestamp fails the replay — at 3am, on rows that only exist because
 * something already went wrong once.
 */
function reviveEvent(value: unknown): RequestEvent {
  if (!isRecord(value) || typeof value.startedAt !== 'string')
    throw new TypeError('Spooled request event is malformed');
  return spooledRecord<RequestEvent>({ ...value, startedAt: new Date(value.startedAt) });
}

export function createSpooledSink(config: SpooledSinkConfig): SpooledSink {
  const core = createSpoolCore<RequestEvent>({
    path: config.path,
    write: config.write,
    key: config.key ?? ((event) => event.spanId),
    encode: (event) => event,
    decode: reviveEvent,
    ...(config.compactAfter !== undefined && { compactAfter: config.compactAfter }),
    ...(config.maxPendingEntries !== undefined && {
      maxPendingEntries: config.maxPendingEntries,
    }),
    ...(config.maxFileBytes !== undefined && { maxFileBytes: config.maxFileBytes }),
    ...(config.onSpoolError && {
      onSpoolError: ({ error, record }) =>
        config.onSpoolError?.({ error, ...(record !== undefined && { event: record }) }),
    }),
  });
  return {
    async write(event) {
      const result = await core.write(event);
      // The store's refusal is the caller's to see: the row stays spooled for `recover`.
      if (result.outcome === 'spooled') throw result.storeError;
      // Neither on disk nor in the store: the caller is told the row is kept nowhere.
      if (result.outcome === 'unspooled') throw new SpoolUnspooledError(result.storeError);
    },
    recover: () => core.recover(),
    pending: () => core.pending(),
  };
}
