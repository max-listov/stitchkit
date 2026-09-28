import { argumentsDigest } from '../internal/stable-digest';
import type { WatchClientConfig, WatchListeners } from './watch-client';
import {
  WATCH_OPEN,
  type WatchHave,
  type WatchKey,
  type WatchStateFrame,
  type WatchValueFrame,
} from './watch-contract';
import { apply } from './watch-delta';

type Listeners<T> = WatchListeners<T>;
export interface WatchClientEntry {
  epoch: number;
  released: boolean;
  readonly key: WatchKey;
  readonly args: Record<string, unknown>;
  readonly listeners: Set<Listeners<unknown>>;
  revision: number;
  value?: unknown;
  hasValue: boolean;
  /**
   * The server's identity for the value held, carried back on the next `open`.
   *
   * Kept rather than recomputed so that what is offered is what the server
   * actually said, not this client's opinion of the value it built — if those
   * two ever disagree, offering the recomputed one would hide the disagreement
   * and offering the server's one surfaces it as a difference that will not
   * apply.
   */
  fingerprint?: string;
  /**
   * Whether the **current** connection has been told about this key.
   *
   * On the entry rather than on a handle: two handles asking one question share
   * a subscription, so the second must not send a second `open` — and a
   * reconnect has to clear it for both.
   */
  opened: boolean;
  /**
   * Whether a value frame has answered the latest `open`.
   *
   * A revision is a counter of one hub's life of the key, so it orders frames
   * within one open and says nothing across two: a restarted API starts at 1
   * again. Until the first answer to an open arrives, the held revision is not
   * a floor — without this, a client that held revision 40 from the previous
   * process dropped every full value of the new one as "no newer" until its
   * counter passed 40, while showing itself live.
   */
  answered: boolean;
  state: WatchStateFrame;
  release?: ReturnType<typeof setTimeout>;
}

export function publishState(entry: WatchClientEntry, state: WatchStateFrame): void {
  entry.state = state;
  for (const listener of [...entry.listeners]) listener.state?.(state);
}

/**
 * Tell the server about a key, and turn every way that can fail into a state.
 *
 * Nothing here rejects. It runs from a subscribe and from a reconnect, neither
 * of which has anywhere to put a rejected promise — and a disconnected socket
 * rejects the request, which is exactly the moment this runs. An unhandled
 * rejection in a console is also the one outcome that tells the subscriber
 * nothing at all.
 */
export async function openWatch(
  config: WatchClientConfig,
  openTimeoutMs: number,
  entry: WatchClientEntry,
): Promise<void> {
  if (entry.opened || entry.released || (config.session && !config.session.current())) return;
  const epoch = ++entry.epoch;
  entry.opened = true;
  entry.answered = false;
  try {
    // What this client already holds travels with the open, so a reconnection
    // costs a difference — or nothing at all — instead of the value again.
    const have: WatchHave | undefined =
      entry.hasValue && entry.fingerprint !== undefined
        ? { revision: entry.revision, fingerprint: entry.fingerprint }
        : undefined;
    const acknowledgement = await config.transport.request(
      WATCH_OPEN,
      { key: entry.key, args: entry.args, ...(have !== undefined && { have }) },
      { timeoutMs: openTimeoutMs },
    );
    if (
      epoch !== entry.epoch ||
      entry.released ||
      (config.session && !config.session.current())
    )
      return;
    if (!acknowledgement.accepted) {
      const reason = acknowledgement.reason ?? 'the server refused this watch';
      config.onRefused?.(entry.key, reason);
      publishState(entry, {
        key: entry.key,
        phase: 'unavailable',
        reason: 'source-unavailable',
        message: reason,
      });
    }
  } catch (error) {
    if (
      epoch !== entry.epoch ||
      entry.released ||
      (config.session && !config.session.current())
    )
      return;
    // The next connection must be able to try again, so forget it was sent.
    entry.opened = false;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
    publishState(entry, {
      key: entry.key,
      phase: 'unavailable',
      reason: 'source-unavailable',
      ...(code !== undefined && { code }),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * What one value frame does to an entry: a new value, a confirmation of the
 * held one, a late answer to drop, or a reason the key has to start over.
 * The entry's revision, value and fingerprint move here and nowhere else.
 */
export function applyWatchFrame(
  entry: WatchClientEntry,
  frame: WatchValueFrame,
):
  | { kind: 'value'; value: unknown }
  | { kind: 'confirmed' | 'stale' }
  | { kind: 'resync'; message: string } {
  if (frame.kind === 'unchanged') {
    // The value held is still current. Adopt the revision it was confirmed at
    // so the next difference is taken against the right base.
    if (!entry.hasValue) {
      return {
        kind: 'resync',
        message: 'the server confirmed a value this client does not hold',
      };
    }
    entry.revision = frame.revision;
    entry.fingerprint = frame.fingerprint;
    entry.answered = true;
    return { kind: 'confirmed' };
  }
  // A frame no newer than what is held is a late answer to an older question.
  // The hub reads one at a time so this should not happen; dropping it anyway
  // costs one comparison and means the rule is stated where a reader can see it.
  // Only within one open: the first answer to an open may come from another hub.
  if (entry.hasValue && entry.answered && frame.revision <= entry.revision) {
    return { kind: 'stale' };
  }
  let value: unknown;
  if (frame.kind === 'full') {
    value = frame.value;
  } else {
    if (!entry.hasValue || entry.revision !== frame.base) {
      return {
        kind: 'resync',
        message: `a difference against revision ${frame.base} arrived while holding ${
          entry.hasValue ? String(entry.revision) : 'nothing'
        }`,
      };
    }
    try {
      value = apply(entry.value, frame.delta);
    } catch (error) {
      return {
        kind: 'resync',
        message: error instanceof Error ? error.message : String(error),
      };
    }
    // The rebuilt value is checked against the server's identity for it, every
    // time. Reassembly is the one step on this path that can be wrong while
    // looking right, and an unchecked difference would hand a component a
    // plausible answer that nobody holds.
    if (argumentsDigest({ value }) !== frame.fingerprint) {
      return {
        kind: 'resync',
        message: 'the rebuilt value did not match the fingerprint the server sent',
      };
    }
  }
  entry.revision = frame.revision;
  entry.value = value;
  entry.fingerprint = frame.fingerprint;
  entry.hasValue = true;
  entry.answered = true;
  return { kind: 'value', value };
}
