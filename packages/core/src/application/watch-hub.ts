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
import { type BackoffPolicy, createBackoff } from '../browser/resumable';
import { argumentsDigest, stableValue } from '../internal/stable-digest';
import {
  type WatchKey,
  type WatchStateFrame,
  type WatchValueFrame,
  watchKeyString,
} from '../live/watch-contract';
import type { StitchLogger } from '../logger';

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
  open(key: WatchKey, args: unknown): { accepted: boolean; reason?: string };
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
  /** The topics whose announcement means this operation's answer may have changed. */
  invalidatedBy(operation: WatchOperation): readonly string[];
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

const DEFAULT_BACKOFF: BackoffPolicy = { minDelayMs: 250, maxDelayMs: 30_000, jitter: 0.2 };

interface Source {
  readonly key: WatchKey;
  readonly operation: WatchOperation;
  readonly args: unknown;
  readonly subscribers: Set<WatchSubscriber>;
  readonly unsubscribes: (() => void)[];
  revision: number;
  value?: unknown;
  signature?: string;
  reading: boolean;
  dirty: boolean;
  state: WatchStateFrame;
  retry?: ReturnType<typeof setTimeout>;
  release?: ReturnType<typeof setTimeout>;
  backoff: ReturnType<typeof createBackoff>;
}

/**
 * The identity of a watched read, as the client and the hub both compute it.
 *
 * Exported because the client has to produce exactly this, and two
 * implementations of one key is the failure the digest exists to prevent.
 */
export async function watchKey(operation: WatchOperation, args: unknown): Promise<WatchKey> {
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : { value: args };
  return {
    service: operation.service,
    action: operation.action,
    digest: await argumentsDigest(record),
  };
}

export function createWatchHub(config: WatchHubConfig): WatchHub {
  const sources = new Map<string, Source>();
  const held = new Map<WatchSubscriber, Set<string>>();
  const maxWatches = config.maxWatchesPerSubscriber ?? 64;
  const holdMs = config.holdMs ?? 0;
  const same =
    config.same ??
    ((previous, next) =>
      JSON.stringify(stableValue(previous)) === JSON.stringify(stableValue(next)));
  let reads = 0;
  let closed = false;

  function announceState(source: Source, state: WatchStateFrame): void {
    source.state = state;
    for (const subscriber of source.subscribers) subscriber.state(state);
  }

  function publish(source: Source, value: unknown): void {
    source.revision += 1;
    source.value = value;
    const frame: WatchValueFrame = { key: source.key, revision: source.revision, value };
    for (const subscriber of source.subscribers) subscriber.value(frame);
  }

  async function pump(source: Source): Promise<void> {
    if (source.reading || closed) return;
    source.reading = true;
    try {
      // The dirty bit is cleared *before* the read, not after: an invalidation
      // that lands while this read is running has to cause another one, and
      // clearing afterwards would swallow exactly that case.
      while (source.dirty && !closed) {
        source.dirty = false;
        reads += 1;
        try {
          const value = await config.read(source.operation, source.args);
          source.backoff.reset();
          const signature = JSON.stringify(stableValue(value));
          const unchanged = source.signature !== undefined && same(source.value, value);
          source.signature = signature;
          if (!unchanged) publish(source, value);
          if (source.state.phase !== 'live') {
            announceState(source, { key: source.key, phase: 'live' });
          }
        } catch (error) {
          // A failed read is said in the words the read used — a flag would make
          // "the database is down" and "you are not allowed" the same fact.
          const code = readErrorCode(error);
          announceState(source, {
            key: source.key,
            phase: 'unavailable',
            reason: 'source-error',
            ...(code !== undefined && { code }),
            message: error instanceof Error ? error.message : String(error),
          });
          config.logger?.warn?.('[stitchkit] watched read failed', {
            key: watchKeyString(source.key),
            error,
          });
          scheduleRetry(source);
          return;
        }
      }
    } finally {
      source.reading = false;
    }
  }

  function scheduleRetry(source: Source): void {
    if (closed || source.subscribers.size === 0) return;
    clearTimeout(source.retry);
    source.retry = setTimeout(() => {
      source.dirty = true;
      void pump(source);
    }, source.backoff.next());
    source.retry.unref?.();
  }

  function acquire(operation: WatchOperation, key: WatchKey, args: unknown): Source {
    const id = watchKeyString(key);
    const existing = sources.get(id);
    if (existing) {
      clearTimeout(existing.release);
      existing.release = undefined;
      return existing;
    }
    const source: Source = {
      key,
      operation,
      args,
      subscribers: new Set(),
      unsubscribes: [],
      revision: 0,
      reading: false,
      dirty: true,
      state: { key, phase: 'opening' },
      backoff: createBackoff(config.backoff ?? DEFAULT_BACKOFF),
    };
    for (const topic of config.invalidatedBy(operation)) {
      source.unsubscribes.push(
        config.subscribe(topic, () => {
          source.dirty = true;
          void pump(source);
        }),
      );
    }
    sources.set(id, source);
    return source;
  }

  function release(source: Source): void {
    if (source.subscribers.size > 0) return;
    clearTimeout(source.retry);
    source.retry = undefined;
    const drop = () => {
      // A read may still be in flight; dropping the source now would publish its
      // result into nothing and let the next subscriber start a second read for
      // the same question. Wait for it to finish, then let go.
      if (source.reading) {
        source.release = setTimeout(drop, 10);
        source.release.unref?.();
        return;
      }
      for (const unsubscribe of source.unsubscribes) unsubscribe();
      sources.delete(watchKeyString(source.key));
    };
    if (holdMs === 0) {
      drop();
      return;
    }
    source.release = setTimeout(drop, holdMs);
    source.release.unref?.();
  }

  return {
    attach(subscriber) {
      const keys = new Set<string>();
      held.set(subscriber, keys);
      return {
        open(key, args) {
          if (closed) return { accepted: false, reason: 'the watch hub is closed' };
          const operation = { service: key.service, action: key.action };
          if (!config.watchable(operation)) {
            return {
              accepted: false,
              reason: `${key.service}.${key.action} is not watchable`,
            };
          }
          const id = watchKeyString(key);
          if (keys.has(id)) return { accepted: true };
          if (keys.size >= maxWatches) {
            return {
              accepted: false,
              reason: `this connection is already watching ${keys.size} reads (limit ${maxWatches})`,
            };
          }
          const source = acquire(operation, key, args);
          source.subscribers.add(subscriber);
          keys.add(id);
          // A subscriber arriving after the answer is known gets it now, from
          // memory, before any network happens. That is the difference between a
          // panel that paints and a panel that spins.
          if (source.signature !== undefined) {
            subscriber.value({ key, revision: source.revision, value: source.value });
          }
          subscriber.state(source.state);
          void pump(source);
          return { accepted: true };
        },
        close(key) {
          const id = watchKeyString(key);
          if (!keys.delete(id)) return;
          const source = sources.get(id);
          if (!source) return;
          source.subscribers.delete(subscriber);
          release(source);
        },
        detach() {
          for (const id of keys) {
            const source = sources.get(id);
            if (!source) continue;
            source.subscribers.delete(subscriber);
            release(source);
          }
          keys.clear();
          held.delete(subscriber);
        },
      };
    },
    readCount: () => reads,
    size: () => sources.size,
    close() {
      closed = true;
      for (const source of sources.values()) {
        clearTimeout(source.retry);
        clearTimeout(source.release);
        for (const unsubscribe of source.unsubscribes) unsubscribe();
      }
      sources.clear();
      held.clear();
    },
  };
}

/** An `ApiError`-shaped failure carries a code; anything else does not, and says so by absence. */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}
