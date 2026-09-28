/**
 * The watch hub's machinery: one shared source per watched read, its pump and
 * retry, the frames each subscriber is sent — whole values or differences
 * against what it holds — and the release of a source nobody watches.
 */
import type { BackoffPolicy } from '../internal/backoff';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { type CoalescedTask, createCoalescedTask } from '../internal/coalesced-task';
import { argumentsDigest } from '../internal/stable-digest';
import {
  type WatchHave,
  type WatchKey,
  type WatchStateFrame,
  type WatchValueFrame,
  watchKeyString,
} from '../live/watch-contract';
import { deltaWins, diff } from '../live/watch-delta';

import type {
  AttachedWatcher,
  WatchAdmissionScope,
  WatchHubConfig,
  WatchOperation,
  WatchSubscriber,
} from './watch-hub';

const DEFAULT_BACKOFF: BackoffPolicy = { minDelayMs: 250, maxDelayMs: 30_000, jitter: 0.2 };

interface Source {
  readonly id: string;
  readonly scope?: string;
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
  readonly task: CoalescedTask;
  state: WatchStateFrame;
  release?: ReturnType<typeof setTimeout>;
}

/**
 * The hub's shared sources and what each subscriber holds. A class because
 * every step — acquire, pump, publish, deliver, release — reads and writes the
 * same maps; as methods each step is a function of its own.
 */
export class WatchHubCore {
  readonly sources = new Map<string, Source>();
  readonly held = new Map<WatchSubscriber, Set<string>>();
  readonly maxWatches: number;
  readonly holdMs: number;
  readonly deltaMemoryBytes: number;
  readonly same: NonNullable<WatchHubConfig['same']>;
  reads = 0;
  closed = false;
  periodic?: ReturnType<typeof setInterval>;

  constructor(readonly config: WatchHubConfig) {
    this.maxWatches = config.maxWatchesPerSubscriber ?? 64;
    for (const bound of [config.maxSources ?? 1024, config.maxSubscribers ?? 1024]) {
      if (!Number.isInteger(bound) || bound < 1)
        throw new RangeError('Watch capacity must be positive');
    }
    if (config.reconcileIntervalMs !== undefined) {
      if (
        !Number.isInteger(config.reconcileIntervalMs) ||
        config.reconcileIntervalMs < 10 ||
        config.reconcileIntervalMs > 3_600_000
      )
        throw new RangeError('Invalid reconciliation interval');
      this.periodic = setInterval(() => {
        for (const source of this.sources.values()) source.task.trigger();
      }, config.reconcileIntervalMs);
      this.periodic.unref?.();
    }
    this.holdMs = config.holdMs ?? 0;
    this.deltaMemoryBytes = config.deltaMemoryBytes ?? 262_144;
    this.same =
      config.same ??
      ((previous, next) => serializeCanonicalJson(previous) === serializeCanonicalJson(next));
  }

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
  tell(key: WatchKey, send: () => void): boolean {
    try {
      send();
      return true;
    } catch (error) {
      this.config.logger?.warn?.('[stitchkit] watch subscriber threw', {
        key: watchKeyString(key),
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  announceState(source: Source, state: WatchStateFrame): void {
    source.state = state;
    for (const subscriber of source.subscribers) {
      this.tell(source.key, () => subscriber.state(state));
    }
  }

  /**
   * Remember the value a subscriber may still be holding, under the byte ceiling.
   *
   * Called with the value being *superseded*, because that is the only one a
   * difference can be taken against: the current value is `source.value` and
   * needs no memory.
   */
  remember(source: Source, revision: number, value: unknown, fingerprint: string): void {
    if (this.deltaMemoryBytes === 0) return;
    const bytes = (JSON.stringify(value) ?? 'null').length;
    if (bytes > this.deltaMemoryBytes) return;
    source.history.set(revision, { value, fingerprint, bytes });
    source.historyBytes += bytes;
    for (const [oldest, entry] of source.history) {
      if (source.historyBytes <= this.deltaMemoryBytes) break;
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
  frameFor(source: Source, subscriber: WatchSubscriber): WatchValueFrame {
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
  adoptBaseline(source: Source, subscriber: WatchSubscriber, have: WatchHave): void {
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

  deliver(source: Source, subscriber: WatchSubscriber): boolean {
    const frame = this.frameFor(source, subscriber);
    const delivered = this.tell(source.key, () => subscriber.value(frame));
    if (delivered) source.baselines.set(subscriber, source.revision);
    return delivered;
  }

  publish(source: Source, value: unknown, fingerprint: string): void {
    if (source.fingerprint !== undefined) {
      this.remember(source, source.revision, source.value, source.fingerprint);
    }
    source.revision += 1;
    source.value = value;
    source.fingerprint = fingerprint;
    for (const subscriber of source.subscribers) this.deliver(source, subscriber);
  }

  async readSource(source: Source): Promise<void> {
    this.reads += 1;
    const value = await this.config.read(source.operation, source.args, source.scope);
    if (this.closed || this.sources.get(source.id) !== source) return;
    const signature = serializeCanonicalJson(value);
    const unchanged = source.signature !== undefined && this.same(source.value, value);
    source.signature = signature;
    if (!unchanged) this.publish(source, value, valueFingerprint(value));
    if (source.state.phase !== 'live')
      this.announceState(source, { key: source.key, phase: 'live' });
  }

  readFailed(source: Source, error: unknown): void {
    const code = readErrorCode(error);
    this.announceState(source, {
      key: source.key,
      phase: 'unavailable',
      reason: 'source-error',
      ...(code !== undefined && { code }),
      message: error instanceof Error ? error.message : String(error),
    });
    this.config.logger?.warn?.('[stitchkit] watched read failed', {
      key: watchKeyString(source.key),
      error,
    });
  }

  acquire(operation: WatchOperation, key: WatchKey, args: unknown, scope?: string): Source {
    const id = JSON.stringify([scope ?? null, watchKeyString(key)]);
    const existing = this.sources.get(id);
    if (existing) {
      clearTimeout(existing.release);
      existing.release = undefined;
      return existing;
    }
    const source: Source = {
      id,
      scope,
      key,
      operation,
      args,
      subscribers: new Set(),
      unsubscribes: [],
      revision: 0,
      history: new Map(),
      historyBytes: 0,
      baselines: new Map(),
      task: createCoalescedTask({
        run: () => this.readSource(source),
        active: () => !this.closed && source.subscribers.size > 0,
        onError: (error) => this.readFailed(source, error),
        backoff: this.config.backoff ?? DEFAULT_BACKOFF,
      }),
      state: { key, phase: 'opening' },
    };
    // Computed for THIS key's arguments, so the subscription is as narrow as the
    // caller made its topic.
    for (const topic of this.config.invalidatedBy(operation, args)) {
      source.unsubscribes.push(
        this.config.subscribe(topic, () => {
          source.task.trigger();
        }),
      );
    }
    this.sources.set(id, source);
    return source;
  }

  release(source: Source): void {
    if (source.subscribers.size > 0) return;
    source.task.pauseRetry();
    const drop = () => {
      // A read may still be in flight; dropping the source now would publish its
      // result into nothing and let the next subscriber start a second read for
      // the same question. Wait for it to finish, then let go.
      if (source.task.running) {
        source.release = setTimeout(drop, 10);
        source.release.unref?.();
        return;
      }
      source.task.close();
      for (const unsubscribe of source.unsubscribes) unsubscribe();
      this.sources.delete(source.id);
    };
    if (this.holdMs === 0) {
      drop();
      return;
    }
    source.release = setTimeout(drop, this.holdMs);
    source.release.unref?.();
  }

  attach(subscriber: WatchSubscriber, scope?: WatchAdmissionScope): AttachedWatcher {
    if (this.held.size >= (this.config.maxSubscribers ?? 1024))
      throw new Error('Watch subscriber capacity exceeded');
    if (scope && (!scope.key || scope.key.length > 512))
      throw new Error('Invalid watch admission scope');
    const keys = new Set<string>();
    this.held.set(subscriber, keys);
    let detached = false;
    const attached: AttachedWatcher = {
      open: (key, args, have) => {
        if (detached || scope?.signal.aborted)
          return { accepted: false, reason: 'Watch scope ended' };
        if (this.closed) return { accepted: false, reason: 'the watch hub is closed' };
        const operation = { service: key.service, action: key.action };
        if (!this.config.watchable(operation)) {
          return {
            accepted: false,
            reason: `${key.service}.${key.action} is not watchable`,
          };
        }
        const id = JSON.stringify([scope?.key ?? null, watchKeyString(key)]);
        if (keys.has(id)) return { accepted: true };
        if (keys.size >= this.maxWatches) {
          return {
            accepted: false,
            reason: `this connection is already watching ${keys.size} reads (limit ${this.maxWatches})`,
          };
        }
        if (!this.sources.has(id) && this.sources.size >= (this.config.maxSources ?? 1024))
          return { accepted: false, reason: 'Watch source capacity exceeded' };
        const source = this.acquire(operation, key, args, scope?.key);
        source.subscribers.add(subscriber);
        keys.add(id);
        // What the caller says it already holds, believed only as far as the
        // fingerprint bears out: a revision on its own would let a value from
        // a previous life of this key pass for the current one.
        if (have) this.adoptBaseline(source, subscriber, have);
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
            const frame = this.frameFor(source, subscriber);
            subscriber.value(frame);
            source.baselines.set(subscriber, source.revision);
          }
          subscriber.state(source.state);
        } catch (error) {
          source.subscribers.delete(subscriber);
          source.baselines.delete(subscriber);
          keys.delete(id);
          this.release(source);
          return {
            accepted: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        if (
          !source.task.running &&
          (source.signature === undefined || source.state.phase !== 'live')
        )
          source.task.trigger();
        return { accepted: true };
      },
      close: (key) => {
        const id = JSON.stringify([scope?.key ?? null, watchKeyString(key)]);
        if (!keys.delete(id)) return;
        const source = this.sources.get(id);
        if (!source) return;
        source.subscribers.delete(subscriber);
        source.baselines.delete(subscriber);
        this.release(source);
      },
      detach: () => {
        detached = true;
        scope?.signal.removeEventListener('abort', onAbort);
        for (const id of keys) {
          const source = this.sources.get(id);
          if (!source) continue;
          source.subscribers.delete(subscriber);
          source.baselines.delete(subscriber);
          this.release(source);
        }
        keys.clear();
        this.held.delete(subscriber);
      },
    };
    const onAbort = () => attached.detach();
    if (scope?.signal.aborted) attached.detach();
    else scope?.signal.addEventListener('abort', onAbort, { once: true });
    return attached;
  }

  close(): void {
    this.closed = true;
    clearInterval(this.periodic);
    // The map is emptied BEFORE anybody is told.
    //
    // Announcing while iterating `sources.values()` invites the natural client
    // reaction — a subscriber that hears `unavailable` detaches — to re-enter
    // `release()` mid-iteration and delete entries the loop has not reached.
    // Measured: with two watches on one subscriber, only one of the two ever
    // heard it, and the topic unsubscribes ran three times for two sources.
    // Silently dropping a subscriber is the exact failure this teardown was
    // added to end.
    const teardown = [...this.sources.values()];
    this.sources.clear();
    this.held.clear();
    for (const source of teardown) {
      source.task.close();
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
      this.announceState(source, {
        key: source.key,
        phase: 'unavailable',
        reason: 'source-unavailable',
      });
      source.task.close();
      for (const unsubscribe of source.unsubscribes) unsubscribe();
    }
  }
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
