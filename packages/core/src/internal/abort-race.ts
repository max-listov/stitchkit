import { abortError } from './abort-error';

/**
 * The signal's reason, or the `AbortError` a signal aborted without one stands for. A signal-shaped
 * object (a polyfill typed without `reason`) is read the same way.
 */
export function abortReason(signal: {
  readonly aborted: boolean;
  readonly reason?: unknown;
}): unknown {
  return signal.reason ?? abortError('The operation was aborted');
}

/** How a wait against a signal ended: the operation's value, or the signal first. */
export type AbortRaceOutcome<T> =
  | { readonly aborted: false; readonly value: T }
  | { readonly aborted: true };

/**
 * Waits for `operation` or the signal, whichever comes first, without turning the abort into a
 * rejection: a phase that simply stops waiting reads `{ aborted: true }`.
 *
 * Each call owns its listener and removes it when `operation` settles, so a long-lived signal
 * never retains settled work. A rejection before the abort rejects; after it, it is swallowed
 * because the caller already stopped waiting. A value that arrives after the abort is handed to
 * `disposeLate` so an owner can release what it would otherwise leak (a stream, a handle).
 */
export function untilAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<AbortRaceOutcome<T>> {
  const dispose = (value: T): void => {
    try {
      disposeLate?.(value);
    } catch {
      // A disposer failure must not replace the cancellation the caller is handling.
    }
  };
  if (signal.aborted) {
    operation.then(dispose, () => undefined);
    return Promise.resolve({ aborted: true });
  }
  return new Promise<AbortRaceOutcome<T>>((resolve, reject) => {
    let released = false;
    const abort = () => {
      released = true;
      resolve({ aborted: true });
    };
    signal.addEventListener('abort', abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (released) dispose(value);
        else resolve({ aborted: false, value });
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        if (!released) reject(error);
      },
    );
  });
}

/**
 * Releases an await on cancellation without assuming a callback cooperates with its signal: the
 * same wait as `untilAborted`, rejecting with the signal's reason when the signal wins.
 */
export function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  disposeLate?: (value: T) => void,
): Promise<T> {
  return untilAborted(operation, signal, disposeLate).then((outcome) => {
    if (outcome.aborted) throw abortReason(signal);
    return outcome.value;
  });
}

/** A signal that follows its sources until it is released. */
export interface AbortSignalLink {
  /** Aborts with the reason of whichever source aborts first. */
  readonly signal: AbortSignal;
  /** Detaches from every source; the link also detaches itself on its first abort. */
  release(): void;
}

const NOTHING_TO_RELEASE = (): void => undefined;

/**
 * Link signals into one that aborts with the first source's reason. Unlike `AbortSignal.any`,
 * whose listeners some runtimes (React Native) keep on the sources until one aborts, the link holds
 * its listeners only until `release` or the first abort, so a long-lived source retains nothing.
 *
 * An absent source (a caller that gave no signal) is skipped; the last one is always given, and
 * when it is the only one present the link is that signal itself, with nothing to release.
 */
export function linkAbortSignals(
  ...sources: readonly [...(AbortSignal | undefined)[], AbortSignal]
): AbortSignalLink {
  const present = sources.filter((source): source is AbortSignal => source !== undefined);
  const [only] = present;
  if (only && present.length === 1) return { signal: only, release: NOTHING_TO_RELEASE };
  const controller = new AbortController();
  const settled = present.find((source) => source.aborted);
  if (settled) {
    controller.abort(abortReason(settled));
    return { signal: controller.signal, release: NOTHING_TO_RELEASE };
  }
  let attached = true;
  const release = (): void => {
    if (!attached) return;
    attached = false;
    for (const { source, forward } of forwarders) source.removeEventListener('abort', forward);
  };
  const forwarders = present.map((source) => ({
    source,
    forward: (): void => {
      release();
      controller.abort(abortReason(source));
    },
  }));
  for (const { source, forward } of forwarders)
    source.addEventListener('abort', forward, { once: true });
  return { signal: controller.signal, release };
}

/**
 * Run `operation` with a signal that aborts as soon as either `first` or `second` aborts,
 * detaching both listeners once `operation` settles so a long-lived signal retains nothing.
 */
export async function withLinkedAbortSignals<T>(
  first: AbortSignal | undefined,
  second: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!first) return operation(second);
  if (first.aborted) throw abortReason(first);
  if (second.aborted) throw abortReason(second);
  const link = linkAbortSignals(first, second);
  try {
    return await operation(link.signal);
  } finally {
    link.release();
  }
}
