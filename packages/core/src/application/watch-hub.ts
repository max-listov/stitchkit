/**
 * The server half of a watched read: one read per question, however many are asking.
 *
 * Eight panels showing the same conversation are eight subscribers and one read.
 * That is the whole point of the hub, and it is also the only thing here that a
 * caller cannot build correctly by accident — the rest (re-read on an event,
 * publish only what changed, back off on failure) is easy to write and easy to
 * write subtly wrong.
 *
 * ## Single-flight, plus a dirty bit
 *
 * A key has at most **one** read in flight. An invalidation that arrives while a
 * read is running does not start a second one; it marks the key dirty, and the
 * loop reads again when the first finishes.
 *
 * This is not only cheaper, it is what makes the answer ordered. Two overlapping
 * reads can finish in either order, and the slow one carries the older world: a
 * hub that published both would leave the *older* value standing as current,
 * with the state still `live`, the value plausible, and nothing to alert anyone
 * — until an unrelated invalidation happened to fix it. Serialising per key
 * removes the race rather than detecting it.
 *
 * The revision on the wire is the version of the value, and a client drops a
 * frame no newer than what it holds. Belt beside braces: ordering is already
 * guaranteed here, and the revision keeps the guarantee legible at the other end.
 *
 * ## What it does not know
 *
 * How to perform a read. The application supplies `read`, because the hub
 * calling handlers itself would be a second dispatch path — one that skips the
 * auth gate the first one has. And which operations may be watched: that is a
 * predicate over the operation's identity, supplied by the caller, not a field
 * in `meta` (the core attaches no meaning to `meta` — ADR 0002/0021).
 *
 * One source per process. Two processes behind a balancer are two reads, and no
 * test in this repository can show otherwise.
 *
 * → ADR 0153.
 */
import type { BackoffPolicy } from '../internal/backoff';
import type { StitchLogger } from '../internal/logger';
import { argumentsDigest } from '../internal/stable-digest';
import type {
  WatchHave,
  WatchKey,
  WatchStateFrame,
  WatchValueFrame,
} from '../live/watch-contract';

import { WatchHubCore } from './watch-hub-core';
/** The operation a watched read runs — `OperationIdentity`'s two stable halves. */
export interface WatchOperation {
  readonly service: string;
  readonly action: string;
}

export interface WatchSubscriber {
  /** A new value for a key this subscriber is watching. */
  value(frame: WatchValueFrame): void;
  /** A change in what the hub can say about a key. */
  state(frame: WatchStateFrame): void;
}

export interface AttachedWatcher {
  /**
   * Start watching a key.
   *
   * `have` is what the caller already holds from an earlier connection. Offered,
   * it turns a reconnection into a difference — or into nothing at all when the
   * answer has not moved — instead of the whole value again. Omitted, the caller
   * is treated as holding nothing, which is what a first subscription is.
   */
  open(key: WatchKey, args: unknown, have?: WatchHave): { accepted: boolean; reason?: string };
  close(key: WatchKey): void;
  /** The connection went away. Releases every key this subscriber held. */
  detach(): void;
}

export interface WatchHubConfig {
  /**
   * Perform one read. Supplied by the application, so a watched read goes
   * through the same authorization as the request it mirrors.
   *
   * **It is given no subscriber, and that is the guard, not an omission.** A key
   * shares one read across everyone asking it, so a key that did not separate
   * callers would hand one caller's answer to another. Here it cannot: an answer
   * that depends on who is asking has to carry the asker in `args`, and `args`
   * are what the key's digest is taken over — so two callers who differ get two
   * keys and two reads, by construction rather than by discipline.
   *
   * The one way to defeat that is to resolve an identity from ambient state
   * *inside* this function — a request-scoped context, a module-level "current
   * user". Then every subscriber to that key receives whatever the first read
   * happened to resolve. Do not; put the identity in the arguments.
   */
  read(operation: WatchOperation, args: unknown): Promise<unknown>;
  /** Whether an operation may be watched at all. Refusal is answered in words. */
  watchable(operation: WatchOperation): boolean;
  /**
   * The topics whose announcement means this answer may have changed.
   *
   * Given the arguments as well as the operation, so a topic can name what the
   * answer actually depends on: `chat.transcript:<address>` rather than
   * `chat.transcript`. Without that narrowing, one address changing wakes every
   * watcher of the operation — twenty conversations open means twenty reads for
   * one change, and nineteen of them publish nothing because nothing changed.
   * The read is still paid.
   */
  invalidatedBy(operation: WatchOperation, args: unknown): readonly string[];
  /** Subscribe to a topic; returns the unsubscribe. Normally an event bus's `on`. */
  subscribe(topic: string, listener: () => void): () => void;
  /** The most keys one subscriber may watch at once. Default 64. */
  maxWatchesPerSubscriber?: number;
  /**
   * How long a key survives its last subscriber, in milliseconds. Default 0.
   *
   * A page that navigates away and back within the window finds the value still
   * warm and reads nothing. Longer means more memory held for readers who may
   * not return.
   */
  holdMs?: number;
  /** Retry pacing after a failed read. */
  backoff?: BackoffPolicy;
  /**
   * How many bytes of superseded values one key may keep, for differences.
   *
   * A difference needs the value the receiver actually holds, which is no longer
   * the current one. This is the ceiling on that memory, per key, and it is a
   * byte budget rather than a count of revisions because the thing being
   * protected is the process's heap and revisions have no size.
   *
   * Zero disables differences entirely: every frame carries the whole value,
   * which is what this hub did before they existed. Default 262144 (256 KiB),
   * which holds several revisions of the large answers differences are for and
   * a great many small ones.
   */
  deltaMemoryBytes?: number;
  /** Whether two answers are the same. Defaults to key-order-independent JSON equality. */
  same?(previous: unknown, next: unknown): boolean;
  logger?: StitchLogger;
}

export interface WatchHub {
  attach(subscriber: WatchSubscriber): AttachedWatcher;
  /**
   * How many reads have actually been performed.
   *
   * Exposed because "two browsers, one read" is only a claim until something
   * counts — and a counter that can only ever go up by one is not a measurement
   * either, which is why the tests also exercise a case that must count two.
   */
  readCount(): number;
  /** Keys currently held, including those inside their hold window. */
  size(): number;
  close(): void;
}

/**
 * The identity of a watched read, as the client and the hub both compute it.
 *
 * Exported because the client has to produce exactly this, and two
 * implementations of one key is the failure the digest exists to prevent.
 */
export function watchKey(operation: WatchOperation, args: unknown): WatchKey {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : { value: args };
  return {
    service: operation.service,
    action: operation.action,
    digest: argumentsDigest(record),
  };
}

export function createWatchHub(config: WatchHubConfig): WatchHub {
  const hub = new WatchHubCore(config);
  return {
    attach: (subscriber) => hub.attach(subscriber),
    readCount: () => hub.reads,
    size: () => hub.sources.size,
    close: () => hub.close(),
  };
}
