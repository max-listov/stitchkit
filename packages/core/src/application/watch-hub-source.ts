/**
 * What a watch source remembers about its value — the current revision, the
 * superseded ones still worth a difference, and what each subscriber holds —
 * and the frame each subscriber is sent from it.
 */
import type { CoalescedTask } from '../internal/coalesced-task';
import { argumentsDigest } from '../internal/stable-digest';
import type {
  WatchHave,
  WatchKey,
  WatchStateFrame,
  WatchValueFrame,
} from '../live/watch-contract';
import { deltaWins, diff } from '../live/watch-delta';
import type { WatchOperation, WatchSubscriber } from './watch-hub';

export interface Source {
  readonly id: string;
  readonly scope?: string;
  readonly key: WatchKey;
  readonly operation: WatchOperation;
  readonly args: unknown;
  readonly subscribers: Set<WatchSubscriber>;
  /**
   * The keys each subscriber opened this source under. A session-scoped key
   * carries the client's `instance`, which routes frames and never divides the
   * source: one scope, one question, one read (ADR 0153, ADR 0208).
   */
  readonly routes: Map<WatchSubscriber, Map<string, WatchKey>>;
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
 * Remember the value a subscriber may still be holding, under the byte ceiling.
 *
 * Called with the value being *superseded*, because that is the only one a
 * difference can be taken against: the current value is `source.value` and
 * needs no memory.
 */
export function remember(
  source: Source,
  deltaMemoryBytes: number,
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
export function fullFrame(source: Source): WatchValueFrame {
  const value = source.value;
  return {
    kind: 'full',
    key: source.key,
    revision: source.revision,
    fingerprint: source.fingerprint ?? valueFingerprint(value),
    value,
  };
}

export function frameFor(source: Source, subscriber: WatchSubscriber): WatchValueFrame {
  const value = source.value;
  const full = fullFrame(source);
  const fingerprint = full.fingerprint;
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
export function adoptBaseline(
  source: Source,
  subscriber: WatchSubscriber,
  have: WatchHave,
): void {
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

/**
 * The identity of a value, order-independent and synchronous.
 *
 * The same digest the watch key is built from, over `{ value }` rather than over
 * arguments — one implementation, because two hashes that had to agree across a
 * socket and were written twice would eventually not.
 */
export function valueFingerprint(value: unknown): string {
  return argumentsDigest({ value });
}
