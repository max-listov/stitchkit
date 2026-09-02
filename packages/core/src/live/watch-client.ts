/**
 * The client half of a watched read.
 *
 * `watch.notes.list({ folder: 'a' })` returns a handle. Subscribe to it and the
 * values arrive; unsubscribe and, once nobody is left, the server is told to
 * stop reading. Two components asking the same question share one subscription
 * and one server-side read, which is the arrangement the hub exists for and
 * which a per-component `useEffect` cannot reach.
 *
 * ## Why it is built from the contract, not from a method
 *
 * `watch(api.notes.list, args)` is the shape one would write first, and it
 * cannot work: a client method is a bare closure with a `withOptions` property
 * and no identity on it, deliberately — it has to survive being handed to a
 * `map`. Passing one here gives an anonymous function, and the server needs to
 * know *what* to re-read. So the watch client is built from the contract, like
 * `createUrlBuilder`, and the identity is the contract's own
 * `(prefix, endpoint key)` — the same pair the server labels every request with.
 *
 * ## Retention
 *
 * The last value of a key is kept while anyone holds it, and for `holdMs` after
 * the last subscriber leaves. A component that unmounts and remounts inside that
 * window paints immediately from memory. The key digest is cached too, so the
 * second subscription resolves synchronously — computing it is a promise, and a
 * value that arrives on a later microtask is not "before the network" in any
 * sense a rendering component can use.
 */
import type { ContractDef, EndpointDef } from '../contract/define';
import { argumentsDigest, stableValue } from '../internal/stable-digest';
import {
  WATCH_CLOSE,
  WATCH_OPEN,
  WATCH_STATE,
  WATCH_VALUE,
  type WatchKey,
  type WatchStateFrame,
  type WatchValueFrame,
  watchKeyString,
} from './watch-contract';

export interface WatchListeners<TValue> {
  value(value: TValue): void;
  /** Phase and, when unhealthy, the read's own code and message. */
  state?(state: WatchStateFrame): void;
}

export interface WatchHandle<TValue> {
  /** Returns the unsubscribe. The retained value, if any, arrives before it returns. */
  subscribe(listeners: WatchListeners<TValue>): () => void;
  /** Drops every listener this handle registered and releases the key. */
  close(): void;
}

/** The transport half a watch client needs — a bound realtime client for `watchContract`. */
export interface WatchTransport {
  on(event: string, handler: (payload: never) => void): () => void;
  emit(event: string, payload: unknown): void;
  request(
    event: string,
    payload: unknown,
    options: { timeoutMs: number },
  ): Promise<{ accepted: boolean; reason?: string }>;
}

export interface WatchClientConfig {
  readonly transport: WatchTransport;
  /** How long a key's value is retained after its last subscriber. Default 0. */
  readonly holdMs?: number;
  /** Deadline for the `open` acknowledgement. Default 10000. */
  readonly openTimeoutMs?: number;
  /** Called when the server refuses to open a watch, in its own words. */
  readonly onRefused?: (key: WatchKey, reason: string) => void;
}

type Listeners<TValue> = WatchListeners<TValue>;

interface Entry {
  readonly key: WatchKey;
  readonly listeners: Set<Listeners<unknown>>;
  revision: number;
  value?: unknown;
  hasValue: boolean;
  state: WatchStateFrame;
  release?: ReturnType<typeof setTimeout>;
}

export type TypedWatchClient<T extends Record<string, EndpointDef>> = {
  [K in keyof T]: (args?: Record<string, unknown>) => WatchHandle<unknown>;
};

export function createWatchClient<T extends Record<string, EndpointDef>>(
  contract: ContractDef<T, string>,
  config: WatchClientConfig,
): TypedWatchClient<T> {
  const entries = new Map<string, Entry>();
  const digests = new Map<string, string>();
  const holdMs = config.holdMs ?? 0;
  const openTimeoutMs = config.openTimeoutMs ?? 10_000;
  const service = contract.meta.prefix;

  config.transport.on(WATCH_VALUE, (frame: WatchValueFrame) => {
    const entry = entries.get(watchKeyString(frame.key));
    if (!entry) return;
    // A frame no newer than what is held is a late answer to an older question.
    // The hub reads one at a time so this should not happen; dropping it anyway
    // costs one comparison and means the rule is stated where a reader can see it.
    if (entry.hasValue && frame.revision <= entry.revision) return;
    entry.revision = frame.revision;
    entry.value = frame.value;
    entry.hasValue = true;
    for (const listener of [...entry.listeners]) listener.value(frame.value);
  });

  config.transport.on(WATCH_STATE, (frame: WatchStateFrame) => {
    const entry = entries.get(watchKeyString(frame.key));
    if (!entry) return;
    entry.state = frame;
    for (const listener of [...entry.listeners]) listener.state?.(frame);
  });

  /** The cache is what makes a re-subscribe synchronous; the digest itself is not. */
  function cachedDigest(action: string, args: Record<string, unknown>): string | undefined {
    return digests.get(`${service}/${action}/${JSON.stringify(stableValue(args))}`);
  }

  async function resolveDigest(
    action: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const cacheKey = `${service}/${action}/${JSON.stringify(stableValue(args))}`;
    const cached = digests.get(cacheKey);
    if (cached !== undefined) return cached;
    const digest = await argumentsDigest(args);
    digests.set(cacheKey, digest);
    return digest;
  }

  function entryFor(key: WatchKey): Entry {
    const id = watchKeyString(key);
    const existing = entries.get(id);
    if (existing) {
      clearTimeout(existing.release);
      existing.release = undefined;
      return existing;
    }
    const entry: Entry = {
      key,
      listeners: new Set(),
      revision: 0,
      hasValue: false,
      state: { key, phase: 'opening' },
    };
    entries.set(id, entry);
    return entry;
  }

  function releaseEntry(entry: Entry): void {
    if (entry.listeners.size > 0) return;
    const drop = () => {
      if (entry.listeners.size > 0) return;
      entries.delete(watchKeyString(entry.key));
      config.transport.emit(WATCH_CLOSE, { key: entry.key });
    };
    if (holdMs === 0) {
      drop();
      return;
    }
    entry.release = setTimeout(drop, holdMs);
    entry.release.unref?.();
  }

  function handleFor(action: string, args: Record<string, unknown>): WatchHandle<unknown> {
    const mine = new Set<Listeners<unknown>>();
    let entry: Entry | undefined;
    let opened = false;

    // Synchronous when this question has been asked before — which is the case
    // the claim is about. The first time, there is nothing retained to be
    // synchronous with.
    const known = cachedDigest(action, args);
    if (known !== undefined) entry = entryFor({ service, action, digest: known });

    const ready: Promise<Entry> = (async () => {
      if (entry) return entry;
      const digest = await resolveDigest(action, args);
      entry = entryFor({ service, action, digest });
      return entry;
    })();

    async function open(target: Entry): Promise<void> {
      if (opened) return;
      opened = true;
      const acknowledgement = await config.transport.request(
        WATCH_OPEN,
        { key: target.key, args },
        { timeoutMs: openTimeoutMs },
      );
      if (!acknowledgement.accepted) {
        const reason = acknowledgement.reason ?? 'the server refused this watch';
        config.onRefused?.(target.key, reason);
        const refusal: WatchStateFrame = {
          key: target.key,
          phase: 'unavailable',
          reason: 'source-unavailable',
          message: reason,
        };
        target.state = refusal;
        for (const listener of [...target.listeners]) listener.state?.(refusal);
      }
    }

    return {
      subscribe(listeners) {
        const registered = listeners as Listeners<unknown>;
        mine.add(registered);
        if (entry) {
          entry.listeners.add(registered);
          // Retained value first, state second: a subscriber that receives
          // `live` before the value it describes has been told the wrong thing
          // for one turn.
          if (entry.hasValue) registered.value(entry.value);
          registered.state?.(entry.state);
        }
        void ready.then((target) => {
          if (!mine.has(registered)) return;
          if (!target.listeners.has(registered)) {
            target.listeners.add(registered);
            if (target.hasValue) registered.value(target.value);
            registered.state?.(target.state);
          }
          void open(target);
        });
        return () => {
          mine.delete(registered);
          const target = entry;
          if (!target) return;
          target.listeners.delete(registered);
          releaseEntry(target);
        };
      },
      close() {
        const target = entry;
        if (!target) return;
        for (const listener of mine) target.listeners.delete(listener);
        mine.clear();
        releaseEntry(target);
      },
    };
  }

  const client: Record<string, (args?: Record<string, unknown>) => WatchHandle<unknown>> = {};
  for (const action of Object.keys(contract.endpoints)) {
    client[action] = (args = {}) => handleFor(action, args);
  }
  // The loose→typed bridge every generated client surface crosses: the methods
  // are built by walking the contract, so their per-endpoint types cannot be
  // expressed while building them. → ADR 0003.
  return client as unknown as TypedWatchClient<T>;
}
