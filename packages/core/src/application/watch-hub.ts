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
import { type BackoffPolicy, createBackoff } from '../internal/backoff';
import { serializeCanonicalJson } from '../internal/canonical-json';
import type { StitchLogger } from '../internal/logger';
import { argumentsDigest } from '../internal/stable-digest';
import {
  type WatchHave,
  type WatchKey,
  type WatchStateFrame,
  type WatchValueFrame,
  watchKeyString,
} from '../live/watch-contract';
import { deltaWins, diff } from '../live/watch-delta';

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
  fingerprint?: string;
  /**
   * Superseded values by revision, oldest first, under a byte ceiling.
   *
   * Insertion order is the eviction order, which is why this is a `Map` and not
   * an object: the oldest revision is the one least likely to still be anyone's
   * baseline.
   */
  readonly history: Map<number, { value: unknown; fingerprint: string; bytes: number }>;
  historyBytes: number;
  /**
   * The revision each subscriber is known to hold — the base its next difference
   * is taken against.
   *
   * "Known to hold" means delivered without throwing, not acknowledged. There is
   * no ack on this protocol and adding one would put a round trip in front of
   * every frame; the socket is ordered and reliable while it is up, and when it
   * is not the subscriber re-declares what it has in `open`. A frame whose
   * delivery threw does not advance the baseline, so the next one is taken
   * against what actually arrived.
   */
  readonly baselines: Map<WatchSubscriber, number>;
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
  const sources = new Map<string, Source>();
  const held = new Map<WatchSubscriber, Set<string>>();
  const maxWatches = config.maxWatchesPerSubscriber ?? 64;
  const holdMs = config.holdMs ?? 0;
  const deltaMemoryBytes = config.deltaMemoryBytes ?? 262_144;
  const same =
    config.same ??
    ((previous, next) => serializeCanonicalJson(previous) === serializeCanonicalJson(next));
  let reads = 0;
  let closed = false;

  /**
   * Hand one frame to one subscriber, and keep its failure to itself.
   *
   * Every call into a subscriber goes through here. They were direct, and a
   * subscriber that threw took out whatever the hub was in the middle of: the
   * rest of a broadcast never heard it, and on the teardown path their
   * `unsubscribes` never ran either. The kernel already isolates its own
   * snapshot listeners for the same reason — one consumer's bug is not the
   * framework's to propagate.
   */
  function tell(key: WatchKey, deliver: () => void): boolean {
    try {
      deliver();
      return true;
    } catch (error) {
      config.logger?.warn?.('[stitchkit] watch subscriber threw', {
        key: watchKeyString(key),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  function announceState(source: Source, state: WatchStateFrame): void {
    source.state = state;
    for (const subscriber of source.subscribers) {
      tell(source.key, () => subscriber.state(state));
    }
  }

  /**
   * Remember the value a subscriber may still be holding, under the byte ceiling.
   *
   * Called with the value being *superseded*, because that is the only one a
   * difference can be taken against: the current value is `source.value` and
   * needs no memory.
   */
  function remember(
    source: Source,
    revision: number,
    value: unknown,
    fingerprint: string,
  ): void {
    if (deltaMemoryBytes === 0) return;
    const bytes = (JSON.stringify(value) ?? 'null').length;
    if (bytes > deltaMemoryBytes) return;
    source.history.set(revision, { value, fingerprint, bytes });
    source.historyBytes += bytes;
    for (const [oldest, entry] of source.history) {
      if (source.historyBytes <= deltaMemoryBytes) break;
      source.history.delete(oldest);
      source.historyBytes -= entry.bytes;
    }
  }

  /**
   * The frame this one subscriber should receive — a difference when it saves,
   * the value when it does not.
   *
   * The choice is per subscriber and it has to be: eight panels on one key can
   * each be holding a different revision, one of them having just joined with
   * nothing at all. A single broadcast frame would have to be the value, which
   * is the behaviour this replaces.
   */
  function frameFor(source: Source, subscriber: WatchSubscriber): WatchValueFrame {
    const value = source.value;
    const fingerprint = source.fingerprint ?? valueFingerprint(value);
    const full: WatchValueFrame = {
      kind: 'full',
      key: source.key,
      revision: source.revision,
      fingerprint,
      value,
    };
    const base = source.baselines.get(subscriber);
    if (base === undefined) return full;
    // Already current — which happens when a subscriber reconnected holding the
    // answer that is still the answer. Saying so costs tens of bytes; saying it
    // with the value costs the value.
    if (base === source.revision) {
      return { kind: 'unchanged', key: source.key, revision: source.revision, fingerprint };
    }
    const held = source.history.get(base);
    if (!held) return full;
    const delta = diff(held.value, value);
    if (delta === undefined || !deltaWins(delta, value)) return full;
    return {
      kind: 'delta',
      key: source.key,
      revision: source.revision,
      fingerprint,
      base,
      delta,
    };
  }

  /**
   * Believe a reconnecting subscriber about what it holds, as far as the
   * fingerprint goes.
   *
   * The revision it names is a hint about *where* to look; the fingerprint is
   * what decides. They are checked in that order against the current value first
   * — the common case is a page that came back to an answer that never moved —
   * and then against the superseded values still in memory.
   *
   * A fingerprint that matches nothing is not an error and is not announced: the
   * subscriber simply has no baseline, and the next frame is the whole value,
   * which is exactly right for a client holding something this hub cannot
   * reconstruct.
   */
  function adoptBaseline(source: Source, subscriber: WatchSubscriber, have: WatchHave): void {
    if (source.fingerprint === have.fingerprint) {
      source.baselines.set(subscriber, source.revision);
      return;
    }
    const named = source.history.get(have.revision);
    if (named?.fingerprint === have.fingerprint) {
      source.baselines.set(subscriber, have.revision);
      return;
    }
    for (const [revision, entry] of source.history) {
      if (entry.fingerprint !== have.fingerprint) continue;
      source.baselines.set(subscriber, revision);
      return;
    }
  }

  function deliver(source: Source, subscriber: WatchSubscriber): boolean {
    const frame = frameFor(source, subscriber);
    const delivered = tell(source.key, () => subscriber.value(frame));
    if (delivered) source.baselines.set(subscriber, source.revision);
    return delivered;
  }

  function publish(source: Source, value: unknown, fingerprint: string): void {
    if (source.fingerprint !== undefined) {
      remember(source, source.revision, source.value, source.fingerprint);
    }
    source.revision += 1;
    source.value = value;
    source.fingerprint = fingerprint;
    for (const subscriber of source.subscribers) deliver(source, subscriber);
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
          const signature = serializeCanonicalJson(value);
          const unchanged = source.signature !== undefined && same(source.value, value);
          source.signature = signature;
          if (!unchanged) publish(source, value, valueFingerprint(value));
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
      history: new Map(),
      historyBytes: 0,
      baselines: new Map(),
      reading: false,
      dirty: true,
      state: { key, phase: 'opening' },
      backoff: createBackoff(config.backoff ?? DEFAULT_BACKOFF),
    };
    // Computed for THIS key's arguments, so the subscription is as narrow as the
    // caller made its topic.
    for (const topic of config.invalidatedBy(operation, args)) {
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
        open(key, args, have) {
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
          // What the caller says it already holds, believed only as far as the
          // fingerprint bears out: a revision on its own would let a value from
          // a previous life of this key pass for the current one.
          if (have) adoptBaseline(source, subscriber, have);
          // A subscriber arriving after the answer is known gets it now, from
          // memory, before any network happens. That is the difference between a
          // panel that paints and a panel that spins.
          // The replay is NOT swallowed, unlike a broadcast.
          //
          // A subscriber whose first frame throws has been added to the source
          // and told nothing: it would sit retained, seeing revision N+1 onward
          // and never the value it opened for — a panel permanently one edit
          // behind, with no error anywhere. `open` already has a refusal channel
          // for exactly this, so it is used instead of hiding the failure.
          try {
            if (source.signature !== undefined) {
              const frame = frameFor(source, subscriber);
              subscriber.value(frame);
              source.baselines.set(subscriber, source.revision);
            }
            subscriber.state(source.state);
          } catch (error) {
            source.subscribers.delete(subscriber);
            source.baselines.delete(subscriber);
            keys.delete(id);
            release(source);
            return {
              accepted: false,
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          void pump(source);
          return { accepted: true };
        },
        close(key) {
          const id = watchKeyString(key);
          if (!keys.delete(id)) return;
          const source = sources.get(id);
          if (!source) return;
          source.subscribers.delete(subscriber);
          source.baselines.delete(subscriber);
          release(source);
        },
        detach() {
          for (const id of keys) {
            const source = sources.get(id);
            if (!source) continue;
            source.subscribers.delete(subscriber);
            source.baselines.delete(subscriber);
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
      // The map is emptied BEFORE anybody is told.
      //
      // Announcing while iterating `sources.values()` invites the natural client
      // reaction — a subscriber that hears `unavailable` detaches — to re-enter
      // `release()` mid-iteration and delete entries the loop has not reached.
      // Measured: with two watches on one subscriber, only one of the two ever
      // heard it, and the topic unsubscribes ran three times for two sources.
      // Silently dropping a subscriber is the exact failure this teardown was
      // added to end.
      const teardown = [...sources.values()];
      sources.clear();
      held.clear();
      for (const source of teardown) {
        clearTimeout(source.retry);
        clearTimeout(source.release);
        // Told, not dropped.
        //
        // This used to clear its sources in silence, leaving every subscriber
        // holding the last value it was sent, at phase `live`, forever. ADR 0153
        // argues at length against exactly that state — a stale value standing
        // as current — and the only reason it was survivable is that the hub
        // used to close when the process did, so the socket died with it and the
        // client recovered through `onConnectionChange`. A subtree restart
        // closes the hub while the connections are still up, which makes the
        // silent version the normal case rather than the impossible one.
        //
        // `unavailable` / `source-unavailable` is the pair the client already
        // publishes when a connection drops, so this needs no new branch on the
        // browser side. `closed` would need one, and would tell a live page to
        // stop retrying.
        announceState(source, {
          key: source.key,
          phase: 'unavailable',
          reason: 'source-unavailable',
        });
        for (const unsubscribe of source.unsubscribes) unsubscribe();
      }
    },
  };
}

/**
 * The identity of a value, order-independent and synchronous.
 *
 * The same digest the watch key is built from, over `{ value }` rather than over
 * arguments — one implementation, because two hashes that had to agree across a
 * socket and were written twice would eventually not.
 */
function valueFingerprint(value: unknown): string {
  return argumentsDigest({ value });
}

/** An `ApiError`-shaped failure carries a code; anything else does not, and says so by absence. */
function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : undefined;
}
