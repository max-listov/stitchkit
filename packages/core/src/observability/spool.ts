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
 * spool file; two processes pointed at one path will replay each other's
 * records — which is safe when the store is idempotent and wasteful always.
 * Give each process its own path.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RequestEvent } from './event';

export interface SpooledSinkConfig {
  /** The real sink — normally the project's audit-table write. */
  write: (event: RequestEvent) => void | Promise<void>;
  /**
   * The spool file. Created with its directory if missing.
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
  /** Observe a spool-file failure. The event is still offered to the store. */
  onSpoolError?: (failure: { error: unknown; event?: RequestEvent }) => void;
}

export interface SpoolRecovery {
  /** Records found undelivered and offered to the store again. */
  replayed: number;
  /** Of those, the ones the store refused again. They stay in the file. */
  failed: number;
}

export interface SpooledSink {
  /** Spool, then deliver. Hand this to `RequestEventSinkConfig.write`. */
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

interface SpoolLine {
  /** A record: the key and the event. */
  k?: string;
  e?: RequestEvent;
  /** An acknowledgement: the key that reached the store. */
  a?: string;
}

/**
 * `startedAt` is a `Date` in the shape and a string on disk.
 *
 * Revived on the way back, because a store handed a string where its column is
 * a timestamp fails the replay — at 3am, on rows that only exist because
 * something already went wrong once.
 */
function reviveEvent(event: RequestEvent): RequestEvent {
  return { ...event, startedAt: new Date(event.startedAt) };
}

export function createSpooledSink(config: SpooledSinkConfig): SpooledSink {
  const keyOf = config.key ?? ((event: RequestEvent) => event.spanId);
  const compactAfter = config.compactAfter ?? 512;
  const undelivered = new Map<string, RequestEvent>();
  let delivered = 0;
  // Appends are serialised through one chain. Two concurrent `appendFile`
  // calls on one path can interleave inside a single line, and a torn line is
  // an unparseable record — that is, a lost audit row, which is the one thing
  // this file exists to prevent.
  let tail: Promise<void> = Promise.resolve();

  function serialise(work: () => Promise<void>): Promise<void> {
    const next = tail.then(work, work);
    tail = next.catch(() => undefined);
    return next;
  }

  async function append(line: SpoolLine, event?: RequestEvent): Promise<void> {
    try {
      await appendFile(config.path, `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      // ENOENT here is the directory, not the file: `appendFile` creates the
      // file and refuses to create the path above it.
      if (isMissing(error)) {
        await mkdir(dirname(config.path), { recursive: true });
        await appendFile(config.path, `${JSON.stringify(line)}\n`, 'utf8');
        return;
      }
      // Reported, not thrown: a spool that cannot be written is a degraded
      // audit, and failing here would take the store write down with it — the
      // opposite of the point.
      config.onSpoolError?.({ error, ...(event !== undefined && { event }) });
    }
  }

  async function compact(): Promise<void> {
    const temporary = `${config.path}.compacting`;
    const body = [...undelivered.entries()]
      .map(([key, event]) => `${JSON.stringify({ k: key, e: event })}\n`)
      .join('');
    try {
      await writeFile(temporary, body, 'utf8');
      await rename(temporary, config.path);
      delivered = 0;
    } catch (error) {
      config.onSpoolError?.({ error });
    }
  }

  return {
    async write(event) {
      const key = keyOf(event);
      await serialise(() => append({ k: key, e: event }, event));
      undelivered.set(key, event);
      // The store is offered the event outside the append chain: a slow store
      // must not hold up the next event's spool line, which is the record that
      // survives if this process dies mid-write.
      await config.write(event);
      undelivered.delete(key);
      delivered += 1;
      await serialise(async () => {
        await append({ a: key });
        if (delivered >= compactAfter) await compact();
      });
    },

    async recover() {
      let body: string;
      try {
        body = await readFile(config.path, 'utf8');
      } catch (error) {
        // No file is the ordinary first run, and it is not a failure. Anything
        // else is reported rather than swallowed: a spool that cannot be read
        // is undelivered rows nobody will ever hear about again.
        if (!isMissing(error)) config.onSpoolError?.({ error });
        return { replayed: 0, failed: 0 };
      }
      const pending = new Map<string, RequestEvent>();
      for (const line of body.split('\n')) {
        if (line.length === 0) continue;
        let parsed: SpoolLine;
        try {
          parsed = JSON.parse(line) as SpoolLine;
        } catch (error) {
          // A torn last line is what a crash mid-append leaves. Skipping it
          // loses at most that one record, and stopping would lose every record
          // after it.
          config.onSpoolError?.({ error });
          continue;
        }
        if (parsed.a !== undefined) {
          pending.delete(parsed.a);
          continue;
        }
        if (parsed.k !== undefined && parsed.e !== undefined) {
          pending.set(parsed.k, reviveEvent(parsed.e));
        }
      }

      const replayed = pending.size;
      let failed = 0;
      for (const [key, event] of pending) {
        try {
          await config.write(event);
          pending.delete(key);
        } catch (error) {
          failed += 1;
          config.onSpoolError?.({ error, event });
        }
      }
      undelivered.clear();
      for (const [key, event] of pending) undelivered.set(key, event);
      delivered = 0;
      await serialise(compact);
      return { replayed, failed };
    },

    pending: () => undelivered.size,
  };
}

function code(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = Reflect.get(error, 'code');
  return typeof value === 'string' ? value : undefined;
}

/** `ENOENT` — the file or the directory above it is not there. */
const isMissing = (error: unknown) => code(error) === 'ENOENT';
