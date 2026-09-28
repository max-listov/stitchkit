/**
 * The watch hub's machinery: one shared source per watched read, its pump and
 * retry, the frames each subscriber is sent — whole values or differences
 * against what it holds — and the release of a source nobody watches.
 */

import { AppError } from '../contract/errors';
import type { BackoffPolicy } from '../internal/backoff';
import { serializeCanonicalJson } from '../internal/canonical-json';
import { createCoalescedTask } from '../internal/coalesced-task';
import { type WatchKey, type WatchStateFrame, watchKeyString } from '../live/watch-contract';
import type {
  AttachedWatcher,
  WatchAdmissionScope,
  WatchHubConfig,
  WatchOperation,
  WatchSubscriber,
} from './watch-hub';
import {
  adoptBaseline,
  frameFor,
  fullFrame,
  remember,
  type Source,
  valueFingerprint,
} from './watch-hub-source';

const DEFAULT_BACKOFF: BackoffPolicy = { minDelayMs: 250, maxDelayMs: 30_000, jitter: 0.2 };

/**
 * The hub's shared sources and what each subscriber holds. A class because
 * every step — acquire, pump, publish, deliver, release — reads and writes the
 * same maps; as methods each step is a function of its own.
 */
export class WatchHubCore {
  readonly sources = new Map<string, Source>();
  readonly held = new Map<WatchSubscriber, Map<string, string>>();
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
      for (const key of source.routes.get(subscriber)?.values() ?? []) {
        this.tell(key, () => subscriber.state({ ...state, key }));
      }
    }
  }

  deliver(source: Source, subscriber: WatchSubscriber): boolean {
    const frame = frameFor(source, subscriber);
    let delivered = true;
    for (const key of source.routes.get(subscriber)?.values() ?? []) {
      delivered = this.tell(key, () => subscriber.value({ ...frame, key })) && delivered;
    }
    if (delivered) source.baselines.set(subscriber, source.revision);
    return delivered;
  }

  publish(source: Source, value: unknown, fingerprint: string): void {
    if (source.fingerprint !== undefined) {
      remember(
        source,
        this.deltaMemoryBytes,
        source.revision,
        source.value,
        source.fingerprint,
      );
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
    // The frame goes to a browser. An application error is written for its
    // caller and travels with its code; anything else — a driver's code and
    // message, with an address or a path in it — stays in the log.
    this.announceState(source, {
      key: source.key,
      phase: 'unavailable',
      reason: 'source-error',
      ...(AppError.is(error)
        ? { code: error.code, message: error.message }
        : { message: 'The watched read failed' }),
    });
    this.config.logger?.warn?.('[stitchkit] watched read failed', {
      key: watchKeyString(source.key),
      error,
    });
  }

  acquire(operation: WatchOperation, routed: WatchKey, args: unknown, scope?: string): Source {
    const id = sourceId(scope, routed);
    const key = sharedKey(routed);
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
      routes: new Map(),
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

  /**
   * Take one subscriber's route off a source; the subscriber leaves the source
   * with its last route.
   */
  unroute(source: Source, subscriber: WatchSubscriber, route: string): void {
    const routes = source.routes.get(subscriber);
    routes?.delete(route);
    if (routes && routes.size > 0) return;
    source.routes.delete(subscriber);
    source.subscribers.delete(subscriber);
    source.baselines.delete(subscriber);
    this.release(source);
  }

  attach(subscriber: WatchSubscriber, scope?: WatchAdmissionScope): AttachedWatcher {
    // Over capacity the subscriber is refused the way every other refusal is:
    // through `open`. A throw here would land in a connection handler, where
    // it has no one to answer and can take the server down with it.
    if (this.held.size >= (this.config.maxSubscribers ?? 1024)) {
      const refused: AttachedWatcher = {
        open: () => ({ accepted: false, reason: 'Watch subscriber capacity exceeded' }),
        close: () => undefined,
        detach: () => undefined,
      };
      return refused;
    }
    if (scope && (!scope.key || scope.key.length > 512))
      throw new Error('Invalid watch admission scope');
    /** Each watched key this subscriber opened, to the source that answers it. */
    const keys = new Map<string, string>();
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
        const route = watchKeyString(key);
        const id = sourceId(scope?.key, key);
        if (keys.has(route)) return { accepted: true };
        if (keys.size >= this.maxWatches) {
          return {
            accepted: false,
            reason: `this connection is already watching ${keys.size} reads (limit ${this.maxWatches})`,
          };
        }
        if (!this.sources.has(id) && this.sources.size >= (this.config.maxSources ?? 1024))
          return { accepted: false, reason: 'Watch source capacity exceeded' };
        const source = this.acquire(operation, key, args, scope?.key);
        // A baseline belongs to the subscriber, so it describes its first
        // route. A further route with nothing to show for itself starts from
        // the whole value, not from what another route holds.
        const alreadyRouted = source.routes.has(subscriber);
        source.subscribers.add(subscriber);
        const routes = source.routes.get(subscriber) ?? new Map<string, WatchKey>();
        routes.set(route, key);
        source.routes.set(subscriber, routes);
        keys.set(route, id);
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
            const frame =
              alreadyRouted && !have ? fullFrame(source) : frameFor(source, subscriber);
            subscriber.value({ ...frame, key });
            source.baselines.set(subscriber, source.revision);
          }
          subscriber.state({ ...source.state, key });
        } catch (error) {
          keys.delete(route);
          this.unroute(source, subscriber, route);
          return {
            accepted: false,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        // `pending`: an invalidation arrived while nobody was subscribed — in
        // the hold window — and was never read. The value in memory says
        // `live` but is not.
        if (
          !source.task.running &&
          (source.signature === undefined ||
            source.state.phase !== 'live' ||
            source.task.pending)
        )
          source.task.trigger();
        return { accepted: true };
      },
      close: (key) => {
        const route = watchKeyString(key);
        const id = keys.get(route);
        if (id === undefined) return;
        keys.delete(route);
        const source = this.sources.get(id);
        if (source) this.unroute(source, subscriber, route);
      },
      detach: () => {
        detached = true;
        scope?.signal.removeEventListener('abort', onAbort);
        for (const [route, id] of keys) {
          const source = this.sources.get(id);
          if (source) this.unroute(source, subscriber, route);
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

/** A key without its routing `instance`: what the source answering it is shared by. */
function sharedKey(key: WatchKey): WatchKey {
  const { instance: _routing, ...shared } = key;
  return shared;
}

/** The one source per admission scope and question. */
function sourceId(scope: string | undefined, key: WatchKey): string {
  return JSON.stringify([scope ?? null, watchKeyString(sharedKey(key))]);
}
